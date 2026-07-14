/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 脚本拦截工具 - 通过 CDP Fetch 域在网络层动态替换 JS 脚本内容。
 *
 * 提供以下工具：
 * - override_script_with_file: 用本地文件完整覆盖脚本（首选，无字符串约束）
 * - replace_script: 注册字符串补丁替换规则（支持多规则链式应用）
 * - list_script_replacements / remove_script_replacement / clear_script_replacements
 * - list_script_overrides / remove_script_override / clear_script_overrides
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {CDPSession, Page} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';
import type {Context} from './ToolDefinition.js';

// ─────────────────────────────────────────────
// 数据结构
// ─────────────────────────────────────────────

/**
 * 字符串补丁替换规则（replace_script）
 */
interface ScriptReplacementRule {
  id: string;
  urlPattern: string;
  matchedUrl: string;
  oldCode: string;
  newCode: string;
  createdAt: number;
}

/**
 * 整文件覆盖规则（override_script_with_file）
 * 优先级高于 replace 规则：当 URL 匹配时直接返回本地文件内容
 */
interface ScriptOverrideRule {
  id: string;
  urlPattern: string;
  matchedUrl: string;
  filePath: string;
  createdAt: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright Route type is not re-exported by third_party
  routeHandler?: (route: any) => Promise<void>; // page.route() handler for cleanup
}

// 每个页面的 replace 规则
const pageReplacementRules = new WeakMap<Page, Map<string, ScriptReplacementRule>>();
// 每个页面的 override 规则
const pageOverrideRules = new WeakMap<Page, Map<string, ScriptOverrideRule>>();

// 已初始化 Fetch 拦截的页面
const initializedPages = new WeakSet<Page>();

// 规则 ID 计数器
let ruleIdCounter = 0;

function getPageRules(page: Page): Map<string, ScriptReplacementRule> {
  let rules = pageReplacementRules.get(page);
  if (!rules) {
    rules = new Map();
    pageReplacementRules.set(page, rules);
  }
  return rules;
}

function getPageOverrides(page: Page): Map<string, ScriptOverrideRule> {
  let overrides = pageOverrideRules.get(page);
  if (!overrides) {
    overrides = new Map();
    pageOverrideRules.set(page, overrides);
  }
  return overrides;
}

// ─────────────────────────────────────────────
// 核心拦截处理逻辑
// ─────────────────────────────────────────────

/**
 * 处理 Fetch.requestPaused 事件
 *
 * 优先级：override 规则（整文件替换）> replace 规则（链式字符串补丁）
 */
async function handleRequestPaused(
  session: CDPSession,
  page: Page,
  event: {requestId: string; request: {url: string}},
): Promise<void> {
  const {requestId, request} = event;
  const url: string = request.url;

  // ── 1. Override 规则现在由 page.route() 处理（跨导航稳定），不再在 CDP Fetch 中处理 ──

  // ── 2. 检查 replace 规则（链式字符串补丁，修复多规则 bug）──
  const rules = getPageRules(page);
  const matchedRules: ScriptReplacementRule[] = [];
  for (const rule of rules.values()) {
    if (rule.matchedUrl === url) {
      matchedRules.push(rule);
    }
  }

  if (matchedRules.length === 0) {
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch {
      // 忽略
    }
    return;
  }

  try {
    const response = await session.send('Fetch.getResponseBody', {requestId});
    const responseResult = response as {body: string; base64Encoded: boolean};

    let body: string;
    if (responseResult.base64Encoded) {
      body = Buffer.from(responseResult.body, 'base64').toString('utf-8');
    } else {
      body = responseResult.body;
    }

    // 链式应用所有匹配规则（按注册顺序依次替换）
    let modified = false;
    for (const rule of matchedRules) {
      if (body.includes(rule.oldCode)) {
        body = body.replace(rule.oldCode, rule.newCode);
        modified = true;
      }
    }

    const base64Body = Buffer.from(body).toString('base64');
    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
      body: base64Body,
    });

    void modified; // suppress unused warning
  } catch {
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch {
      // 忽略
    }
  }
}

/**
 * 根据当前规则启用/禁用 Fetch 拦截
 */
async function enableFetchInterception(session: CDPSession, page: Page): Promise<void> {
  const rules = getPageRules(page);
  const overrides = getPageOverrides(page);

  if (rules.size === 0 && overrides.size === 0) {
    try {
      await session.send('Fetch.disable');
    } catch {
      // 忽略
    }
    return;
  }

  const urlSet = new Set<string>();
  for (const rule of rules.values()) {
    urlSet.add(rule.matchedUrl);
  }
  for (const override of overrides.values()) {
    urlSet.add(override.matchedUrl);
  }

  const patterns: Array<{urlPattern: string; requestStage: 'Request' | 'Response'}> = [];
  for (const url of urlSet) {
    patterns.push({urlPattern: url, requestStage: 'Response' as const});
  }

  // 对于 override 规则，额外注册 urlPattern 通配符模式
  // 确保同一 pattern 下的不同路径（如 /common/ 和 /passport/）都能触发拦截
  // 使用 Request 阶段：直接拦截，不发送到服务器（更快且避免重复请求）
  for (const override of overrides.values()) {
    const wildcardPattern = `*${override.urlPattern}*`;
    const alreadyRegistered = patterns.some(p => p.urlPattern === wildcardPattern);
    if (!alreadyRegistered) {
      patterns.push({urlPattern: wildcardPattern, requestStage: 'Request' as const});
    }
  }

  await session.send('Fetch.enable', {patterns});
}

/**
 * 为页面初始化 Fetch 拦截（含导航事件监听，确保刷新后规则仍生效）
 */
async function initializeFetchInterception(page: Page, context: Context): Promise<CDPSession> {
  const session = await context.getCdpSession(page);

  if (initializedPages.has(page)) {
    return session;
  }
  initializedPages.add(page);

  // 监听 Fetch.requestPaused 事件
  session.on(
    'Fetch.requestPaused',
    (event: {requestId: string; request: {url: string}}) => {
      void handleRequestPaused(session, page, event);
    },
  );

  // 获取主 frame ID
  let mainFrameId: string | undefined;
  try {
    const frameTree = (await session.send('Page.getFrameTree')) as {
      frameTree?: {frame?: {id?: string}};
    };
    mainFrameId = frameTree.frameTree?.frame?.id;
  } catch {
    // 忽略
  }

  // 导航时重新启用 Fetch 拦截
  session.on('Page.frameStartedLoading', async (params: {frameId: string}) => {
    const rules = getPageRules(page);
    const overrides = getPageOverrides(page);
    if (rules.size === 0 && overrides.size === 0) return;

    let isMainFrame = !mainFrameId || params.frameId === mainFrameId;
    if (!isMainFrame) {
      try {
        const frameTree = (await session.send('Page.getFrameTree')) as {
          frameTree?: {frame?: {id?: string}};
        };
        const currentMainFrameId = frameTree.frameTree?.frame?.id;
        if (params.frameId === currentMainFrameId) {
          isMainFrame = true;
          mainFrameId = currentMainFrameId;
        }
      } catch {
        isMainFrame = true;
      }
    }

    if (isMainFrame) {
      try {
        await enableFetchInterception(session, page);
      } catch {
        // 忽略
      }
    }
  });

  // 启用 Page 域以接收导航事件
  try {
    await session.send('Page.enable');
  } catch {
    // 忽略
  }

  return session;
}

// ─────────────────────────────────────────────
// override_script_with_file 工具组
// ─────────────────────────────────────────────

export const overrideScriptWithFile = defineTool({
  name: 'override_script_with_file',
  description: `Use a local file to completely replace a script matching a URL pattern. When the browser requests a matching script, the entire response is replaced with the local file content.

**Advantages over replace_script:**
- No oldCode/newCode string matching required
- Supports arbitrary modifications anywhere in the file
- Single rule covers all injection points (no multi-rule issues)
- Always reads from disk, bypassing HTTP cache

**Workflow:**
1. Modify the local JS file (add logging, hooks, etc.)
2. Call this tool to register the override
3. Reload with ignoreCache: true to trigger interception

**IMPORTANT:** Changes take effect after page reload. Rules persist until removed.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlPattern: zod
      .string()
      .describe('URL pattern (regex) to match scripts. Examples: "passport/zp/security-js/3f4fd88c", ".*jquery.*"'),
    filePath: zod
      .string()
      .describe('Absolute path to the local file to serve as replacement. Example: "D:/project/overrides/www.example.com/app.js"'),
  },
  handler: async (request, response, context) => {
    const {urlPattern, filePath} = request.params;
    const page = context.getSelectedPage();

    // 验证文件存在
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      response.appendResponseLine(`❌ Error: 文件不存在: ${resolvedPath}`);
      return;
    }

    // 获取文件大小
    const stat = fs.statSync(resolvedPath);
    const sizeKB = (stat.size / 1024).toFixed(1);

    // 查找匹配的脚本
    const debugger_ = context.debuggerContext;
    const scripts = debugger_.getScripts();

    let urlRegex: RegExp;
    try {
      urlRegex = new RegExp(urlPattern, 'i');
    } catch (error) {
      response.appendResponseLine(`❌ Error: 无效的 URL 正则: ${error}`);
      return;
    }

    const matchingScripts: Array<{scriptId: string; url: string}> = [];
    for (const scriptInfo of scripts) {
      if (scriptInfo.url && urlRegex.test(scriptInfo.url)) {
        matchingScripts.push({scriptId: scriptInfo.scriptId, url: scriptInfo.url});
      }
    }

    if (matchingScripts.length === 0) {
      response.appendResponseLine(`❌ Error: 没有已加载的脚本匹配 "${urlPattern}"`);
      response.appendResponseLine('');
      response.appendResponseLine('💡 提示:');
      response.appendResponseLine('   • 确保脚本已加载（先导航到目标页面）');
      response.appendResponseLine('   • 使用 `list_network_requests` + resourceTypes=["script"] 查看');
      return;
    }

    if (matchingScripts.length > 1) {
      response.appendResponseLine(`⚠️ 多个脚本匹配，使用第一个：`);
      for (const s of matchingScripts.slice(0, 3)) {
        response.appendResponseLine(`   • ${s.url}`);
      }
      if (matchingScripts.length > 3) {
        response.appendResponseLine(`   ... 还有 ${matchingScripts.length - 3} 个`);
      }
      response.appendResponseLine('');
    }

    const matchedScript = matchingScripts[0];
    const ruleId = `override_${Date.now()}_${++ruleIdCounter}`;

    // 使用 Playwright page.route() 替代 CDP Fetch domain 进行拦截
    // page.route() 跨页面导航自动保持，不受 CDP Fetch.enable 导航重置的竞争条件影响
    const routePattern = `**/*${urlPattern}*`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright Route type is not re-exported by third_party
    const routeHandler = async (route: any) => {
      try {
        const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: fileContent,
        });
      } catch {
        // 文件读取失败，放行原始请求
        await route.continue();
      }
    };

    await page.route(routePattern, routeHandler);

    const rule: ScriptOverrideRule = {
      id: ruleId,
      urlPattern,
      matchedUrl: matchedScript.url,
      filePath: resolvedPath,
      createdAt: Date.now(),
      routeHandler,
    };

    const overrides = getPageOverrides(page);
    overrides.set(ruleId, rule);

    // 仍然初始化 Fetch 拦截用于 replace_script 规则
    const session = await initializeFetchInterception(page, context);
    await enableFetchInterception(session, page);

    response.appendResponseLine('✅ 脚本文件覆盖规则已注册。');
    response.appendResponseLine('');
    response.appendResponseLine(`**Rule ID:** \`${ruleId}\``);
    response.appendResponseLine(`**匹配 URL:** ${matchedScript.url}`);
    response.appendResponseLine(`**Route pattern:** \`${routePattern}\``);
    response.appendResponseLine(`**本地文件:** ${resolvedPath}`);
    response.appendResponseLine(`**文件大小:** ${sizeKB} KB`);
    response.appendResponseLine('');
    response.appendResponseLine('⚠️ 使用 `navigate_page(type=reload, ignoreCache=true)` 刷新后生效。');
  },
});

export const listScriptOverrides = defineTool({
  name: 'list_script_overrides',
  description: 'List all active script override rules (override_script_with_file) for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const overrides = getPageOverrides(page);

    if (overrides.size === 0) {
      response.appendResponseLine('📋 当前页面没有脚本文件覆盖规则。');
      response.appendResponseLine('使用 `override_script_with_file` 添加规则。');
      return;
    }

    response.appendResponseLine(`📋 **${overrides.size} 条文件覆盖规则：**`);
    response.appendResponseLine('');

    for (const rule of overrides.values()) {
      response.appendResponseLine('---');
      response.appendResponseLine(`**ID:** \`${rule.id}\``);
      response.appendResponseLine(`**Pattern:** ${rule.urlPattern}`);
      response.appendResponseLine(`**匹配 URL:** ${rule.matchedUrl}`);
      response.appendResponseLine(`**本地文件:** ${rule.filePath}`);
      const exists = fs.existsSync(rule.filePath);
      response.appendResponseLine(`**文件状态:** ${exists ? '✅ 存在' : '❌ 不存在（规则将回退到原始请求）'}`);
    }
  },
});

export const removeScriptOverride = defineTool({
  name: 'remove_script_override',
  description: 'Remove a script override rule by its ID.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    ruleId: zod.string().describe('The override rule ID to remove (from list_script_overrides).'),
  },
  handler: async (request, response, context) => {
    const {ruleId} = request.params;
    const page = context.getSelectedPage();
    const overrides = getPageOverrides(page);

    if (!overrides.has(ruleId)) {
      response.appendResponseLine(`❌ 未找到规则: \`${ruleId}\``);
      response.appendResponseLine('使用 `list_script_overrides` 查看当前规则。');
      return;
    }

    const rule = overrides.get(ruleId)!;
    // 清理 page.route() handler
    if (rule.routeHandler) {
      try {
        await page.unroute(`**/*${rule.urlPattern}*`, rule.routeHandler);
      } catch {
        // 忽略
      }
    }

    overrides.delete(ruleId);

    const session = await context.getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ 规则已移除: \`${ruleId}\``);
  },
});

export const clearScriptOverrides = defineTool({
  name: 'clear_script_overrides',
  description: 'Remove all script override rules for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const overrides = getPageOverrides(page);
    const count = overrides.size;

    if (count === 0) {
      response.appendResponseLine('📋 没有需要清除的文件覆盖规则。');
      return;
    }

    // 清理所有 page.route() handlers
    for (const rule of overrides.values()) {
      if (rule.routeHandler) {
        try {
          await page.unroute(`**/*${rule.urlPattern}*`, rule.routeHandler);
        } catch {
          // 忽略
        }
      }
    }

    overrides.clear();

    const session = await context.getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ 已清除 ${count} 条文件覆盖规则。`);
  },
});

// ─────────────────────────────────────────────
// replace_script 工具组（保留，修复多规则 bug）
// ─────────────────────────────────────────────

export const replaceScript = defineTool({
  name: 'replace_script',
  description: `Replace a JavaScript code snippet in scripts matching a URL pattern. Uses network interception to modify scripts before execution.

**IMPORTANT:** Changes take effect after page refresh. Rules persist across page refreshes until removed.

**NOTE:** For injecting multiple points, prefer \`override_script_with_file\` which replaces the entire file and avoids string-matching constraints.

This tool:
1. Finds loaded scripts matching the URL pattern (regex)
2. Registers an interception rule for the matched script URL
3. On page refresh, intercepts and modifies the script (all matching rules applied in order)

Use cases:
- Modify third-party scripts
- Inject debugging code
- Bypass anti-debugging measures
- Test code changes without modifying source`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlPattern: zod
      .string()
      .describe('URL pattern (regex) to match scripts. Examples: ".*main\\.js.*", ".*jquery.*"'),
    oldCode: zod
      .string()
      .describe('The original code snippet to replace. Must match exactly.'),
    newCode: zod
      .string()
      .describe('The new code snippet.'),
  },
  handler: async (request, response, context) => {
    const {urlPattern, oldCode, newCode} = request.params;
    const page = context.getSelectedPage();

    if (!oldCode.trim()) {
      response.appendResponseLine('❌ Error: oldCode 不能为空。');
      return;
    }

    if (oldCode === newCode) {
      response.appendResponseLine('❌ Error: oldCode 和 newCode 相同。');
      return;
    }

    // 从 debuggerContext 中获取已加载的脚本列表
    const debugger_ = context.debuggerContext;
    const scripts = debugger_.getScripts();

    let urlRegex: RegExp;
    try {
      urlRegex = new RegExp(urlPattern, 'i');
    } catch (error) {
      response.appendResponseLine(`❌ Error: 无效的 URL 正则: ${error}`);
      return;
    }

    // 查找匹配的脚本
    const matchingScripts: Array<{scriptId: string; url: string}> = [];
    for (const scriptInfo of scripts) {
      if (scriptInfo.url && urlRegex.test(scriptInfo.url)) {
        matchingScripts.push({scriptId: scriptInfo.scriptId, url: scriptInfo.url});
      }
    }

    if (matchingScripts.length === 0) {
      response.appendResponseLine(`❌ Error: 没有已加载的脚本匹配 "${urlPattern}"`);
      response.appendResponseLine('');
      response.appendResponseLine('💡 提示:');
      response.appendResponseLine('   • 确保脚本已加载');
      response.appendResponseLine('   • 使用 `list_network_requests` + resourceTypes=["script"] 查看');
      return;
    }

    if (matchingScripts.length > 1) {
      response.appendResponseLine(`⚠️ 多个脚本匹配，使用第一个：`);
      for (const s of matchingScripts.slice(0, 3)) {
        response.appendResponseLine(`   • ${s.url}`);
      }
      if (matchingScripts.length > 3) {
        response.appendResponseLine(`   ... 还有 ${matchingScripts.length - 3} 个`);
      }
      response.appendResponseLine('');
    }

    const matchedScript = matchingScripts[0];
    const ruleId = `rule_${Date.now()}_${++ruleIdCounter}`;

    const rule: ScriptReplacementRule = {
      id: ruleId,
      urlPattern,
      matchedUrl: matchedScript.url,
      oldCode,
      newCode,
      createdAt: Date.now(),
    };

    const rules = getPageRules(page);
    rules.set(ruleId, rule);

    // 初始化 Fetch 拦截（含导航监听器）
    const session = await initializeFetchInterception(page, context);
    await enableFetchInterception(session, page);

    response.appendResponseLine('✅ 脚本替换规则已注册。');
    response.appendResponseLine('');
    response.appendResponseLine(`**Rule ID:** \`${ruleId}\``);
    response.appendResponseLine(`**匹配 URL:** ${matchedScript.url}`);
    response.appendResponseLine(`**旧代码:** \`${oldCode.substring(0, 50)}${oldCode.length > 50 ? '...' : ''}\``);
    response.appendResponseLine(`**新代码:** \`${newCode.substring(0, 50)}${newCode.length > 50 ? '...' : ''}\``);
    response.appendResponseLine('');
    response.appendResponseLine('⚠️ **刷新页面**后替换生效。');
  },
});

export const listScriptReplacements = defineTool({
  name: 'list_script_replacements',
  description: 'List all active script replacement rules for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const rules = getPageRules(page);

    if (rules.size === 0) {
      response.appendResponseLine('📋 当前页面没有脚本替换规则。');
      response.appendResponseLine('使用 `replace_script` 添加规则。');
      return;
    }

    response.appendResponseLine(`📋 **${rules.size} 条规则：**`);
    response.appendResponseLine('');

    for (const rule of rules.values()) {
      response.appendResponseLine('---');
      response.appendResponseLine(`**ID:** \`${rule.id}\``);
      response.appendResponseLine(`**Pattern:** ${rule.urlPattern}`);
      response.appendResponseLine(`**URL:** ${rule.matchedUrl}`);
      response.appendResponseLine(`**旧代码:**`);
      response.appendResponseLine('```javascript');
      response.appendResponseLine(rule.oldCode.length > 200 ? rule.oldCode.substring(0, 200) + '...' : rule.oldCode);
      response.appendResponseLine('```');
      response.appendResponseLine(`**新代码:**`);
      response.appendResponseLine('```javascript');
      response.appendResponseLine(rule.newCode.length > 200 ? rule.newCode.substring(0, 200) + '...' : rule.newCode);
      response.appendResponseLine('```');
    }
  },
});

export const removeScriptReplacement = defineTool({
  name: 'remove_script_replacement',
  description: 'Remove a script replacement rule by its ID.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    ruleId: zod.string().describe('The rule ID to remove.'),
  },
  handler: async (request, response, context) => {
    const {ruleId} = request.params;
    const page = context.getSelectedPage();
    const rules = getPageRules(page);

    if (!rules.has(ruleId)) {
      response.appendResponseLine(`❌ 未找到规则: \`${ruleId}\``);
      response.appendResponseLine('使用 `list_script_replacements` 查看当前规则。');
      return;
    }

    rules.delete(ruleId);

    const session = await context.getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ 规则已移除: \`${ruleId}\``);
  },
});

export const clearScriptReplacements = defineTool({
  name: 'clear_script_replacements',
  description: 'Remove all script replacement rules for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const rules = getPageRules(page);
    const count = rules.size;

    if (count === 0) {
      response.appendResponseLine('📋 没有需要清除的规则。');
      return;
    }

    rules.clear();

    const session = await context.getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ 已清除 ${count} 条规则。`);
  },
});
