/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * trace_dispatch_chain: 自动追踪 dispatcher trampoline 多层 wrapper 链路。
 *
 * 适用场景：custom_vm / control-flow-flattening 类站点（boss、jd、拼多多）
 * 经常出现 dispatcher entry → wrapper1 (l.apply) → wrapper2 (closure) → ...
 * → final case body 的深度调用链，单层 trace_function 需要 30+ 轮。
 *
 * 实现机制：在 entry 函数位置设真实断点 → 工具内 Runtime.evaluate 触发
 * → 命中后递归 stepInto 走完链路 → 自动识别 4 类 wrapper 模式 → 输出
 * dispatch_chain_trace.yaml。支持多 sample 串联与稳定性校验。
 */

import type {DebuggerContext, BreakpointInfo} from '../DebuggerContext.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// ==================== 类型定义 ====================

type CallPattern =
  | 'l_apply'
  | 'closure_wrapper'
  | 'final_case_body'
  | 'trampoline_indirect'
  | 'unknown';

interface ChainEntry {
  depth: number;
  wrapper_name: string;
  script_url: string;
  script_id: string;
  line_number: number; // 1-based
  column_number: number;
  call_pattern: CallPattern;
  call_count: number;
  arg_modes: string[];
  is_final: boolean;
  source_preview: string;
}

interface SampleResult {
  sample_index: number;
  chain: ChainEntry[];
  truncated: boolean;
}

// ==================== Wrapper 模式启发式识别 ====================

/**
 * 在给定函数体源码内，识别 wrapper 调用模式。
 * 取 frame 周围 ±20 行作为上下文。
 */
function detectCallPattern(sourcePreview: string): {
  pattern: CallPattern;
  callCount: number;
} {
  // 计算各类模式出现次数
  const applyMatches = sourcePreview.match(
    /\b(\w+)\s*\.\s*apply\s*\(\s*[^,)]+,\s*\[/g,
  );
  const trampolineMatches = sourcePreview.match(
    /\b(\w+)\s*\[\s*\w+\s*\]\s*\.\s*apply\s*\(/g,
  );
  const switchMatches = sourcePreview.match(/\bswitch\s*\(/g);
  const caseMatches = sourcePreview.match(/\bcase\s+[\w'"\d]+\s*:/g);
  const returnCallMatches = sourcePreview.match(
    /return\s+(\w+)\s*\([^)]*\)\s*[;}]/g,
  );

  // 优先级：trampoline_indirect > l_apply > final_case_body > closure_wrapper > unknown
  if (trampolineMatches && trampolineMatches.length > 0) {
    return {pattern: 'trampoline_indirect', callCount: trampolineMatches.length};
  }
  if (applyMatches && applyMatches.length > 0) {
    return {pattern: 'l_apply', callCount: applyMatches.length};
  }
  if (switchMatches && switchMatches.length > 0 && caseMatches && caseMatches.length >= 3) {
    // switch + 多个 case：dispatcher 主体或 final case body
    // 若 body 内不再有 wrapper 调用，判定为 final_case_body
    const hasWrapperInside =
      (applyMatches?.length ?? 0) > 0 || (trampolineMatches?.length ?? 0) > 0;
    if (!hasWrapperInside) {
      return {pattern: 'final_case_body', callCount: caseMatches.length};
    }
  }
  if (returnCallMatches && returnCallMatches.length === 1) {
    // 函数体只有单一 return f(...)：closure wrapper
    const previewLines = sourcePreview.split('\n').length;
    if (previewLines <= 10) {
      return {pattern: 'closure_wrapper', callCount: 1};
    }
  }

  return {pattern: 'unknown', callCount: 0};
}

// ==================== 工具：找 entry 函数位置 ====================

/**
 * 在已加载脚本中搜索 entry 函数定义位置。
 * 复用 set_breakpoint_on_text 的策略：尝试多种声明模式，挑首个匹配。
 */
async function locateEntryFunction(
  debugger_: DebuggerContext,
  functionName: string,
  urlPattern?: string,
): Promise<{
  url: string;
  scriptId: string;
  lineNumber: number; // 0-based
  columnNumber: number;
  preview: string;
} | null> {
  const patterns = [
    `function ${functionName}(`,
    `function ${functionName} (`,
    `${functionName}=function`,
    `${functionName} = function`,
    `${functionName}:function`,
    `${functionName}: function`,
  ];

  for (const pattern of patterns) {
    const result = await debugger_.searchInScripts(pattern, {
      caseSensitive: true,
      isRegex: false,
    });
    let matches = result.matches;

    if (urlPattern) {
      const lowerFilter = urlPattern.toLowerCase();
      matches = matches.filter(
        m => m.url && m.url.toLowerCase().includes(lowerFilter),
      );
    }
    matches = matches.filter(m => m.lineContent.length < 100000);
    if (matches.length === 0) continue;

    const match = matches[0];
    const script = debugger_.getScriptById(match.scriptId);
    const url = script?.url || match.url;
    if (!url) continue;

    const {scriptSource: source} = await debugger_.getScriptSource(
      match.scriptId,
    );
    const lines = source.split('\n');
    let columnNumber = 0;
    if (match.lineNumber < lines.length) {
      const lineContent = lines[match.lineNumber];
      const funcStart = lineContent.indexOf(pattern);
      if (funcStart >= 0) {
        // 找到函数体开始的 `{` 位置
        const afterPattern = lineContent.substring(funcStart + pattern.length);
        const braceMatch = afterPattern.indexOf('{');
        if (braceMatch >= 0) {
          columnNumber = funcStart + pattern.length + braceMatch + 1;
        } else {
          columnNumber = funcStart;
        }
      }
    }

    const previewLines = lines.slice(
      Math.max(0, match.lineNumber - 2),
      match.lineNumber + 8,
    );
    return {
      url,
      scriptId: match.scriptId,
      lineNumber: match.lineNumber,
      columnNumber,
      preview: previewLines.join('\n'),
    };
  }

  return null;
}

// ==================== 等待 paused（带超时） ====================

interface PausedEventLite {
  callFrames: Array<{
    callFrameId: string;
    functionName: string;
    location: {scriptId: string; lineNumber: number; columnNumber?: number};
    url?: string;
  }>;
  hitBreakpoints?: string[];
}

function waitForPausedEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  timeoutMs: number,
): Promise<PausedEventLite> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('Debugger.paused', onPaused);
      reject(
        new Error(`Timed out waiting for Debugger.paused (${timeoutMs}ms)`),
      );
    }, timeoutMs);

    const onPaused = (event: PausedEventLite): void => {
      clearTimeout(timer);
      client.off('Debugger.paused', onPaused);
      resolve(event);
    };

    client.on('Debugger.paused', onPaused);
  });
}

// ==================== 单 sample chain walk ====================

interface WalkOptions {
  maxChainDepth: number;
  triggerExpression: string;
  triggerWaitMs: number;
  stepTimeoutMs: number;
  urlPattern?: string;
}

async function walkSingleSample(
  debugger_: DebuggerContext,
  sampleIndex: number,
  entryLocation: Awaited<ReturnType<typeof locateEntryFunction>>,
  options: WalkOptions,
): Promise<SampleResult> {
  if (!entryLocation) {
    throw new Error('Entry location is null');
  }
  const client = debugger_.getClient();
  if (!client) {
    throw new Error('Debugger client not available');
  }

  const chain: ChainEntry[] = [];
  const visitedFunctions = new Set<string>();
  let truncated = false;

  // 启动等待 paused 的监听（在 trigger 之前注册，避免 race）
  const pausedPromise = waitForPausedEvent(client, options.triggerWaitMs);

  // 通过 Runtime.evaluate 触发 entry 调用
  // awaitPromise=false：不等待 trigger 表达式 promise 解决（断点会卡住）
  try {
    await client.send('Runtime.evaluate', {
      expression: options.triggerExpression,
      awaitPromise: false,
      returnByValue: false,
      silent: true,
    });
  } catch {
    // evaluate 本身可能因为同步阻塞返回，仍 OK
  }

  // 等首次 paused（命中 entry 断点）
  let pausedEvent: PausedEventLite;
  try {
    pausedEvent = await pausedPromise;
  } catch {
    return {
      sample_index: sampleIndex,
      chain: [],
      truncated: false,
    };
  }

  // 记录 depth 0：entry 自身
  const topFrame = pausedEvent.callFrames[0];
  const entryScript = debugger_.getScriptById(topFrame.location.scriptId);
  const {scriptSource: entrySource} = await debugger_.getScriptSource(
    topFrame.location.scriptId,
  );
  const entryLines = entrySource.split('\n');
  const entryPreview = entryLines
    .slice(
      Math.max(0, topFrame.location.lineNumber - 5),
      topFrame.location.lineNumber + 25,
    )
    .join('\n');
  const entryArgsResult = await collectFrameArgs(
    debugger_,
    topFrame.callFrameId,
  );
  const entryPattern = detectCallPattern(entryPreview);
  chain.push({
    depth: 0,
    wrapper_name: topFrame.functionName || '<anonymous>',
    script_url: entryScript?.url || topFrame.url || '',
    script_id: topFrame.location.scriptId,
    line_number: topFrame.location.lineNumber + 1,
    column_number: topFrame.location.columnNumber ?? 0,
    call_pattern: entryPattern.pattern,
    call_count: entryPattern.callCount,
    arg_modes: entryArgsResult,
    is_final: entryPattern.pattern === 'final_case_body',
    source_preview: entryPreview.slice(0, 800),
  });
  visitedFunctions.add(
    `${topFrame.location.scriptId}:${topFrame.functionName}`,
  );

  // 如果 entry 自身就是 final case body，则不再 stepInto
  let currentDepth = 0;
  while (
    !chain[chain.length - 1].is_final &&
    currentDepth < options.maxChainDepth
  ) {
    // stepInto → 等下一次 paused
    const stepPaused = waitForPausedEvent(client, options.stepTimeoutMs);
    try {
      await client.send('Debugger.stepInto');
      const newPaused = await stepPaused;
      const newTop = newPaused.callFrames[0];
      if (!newTop) break;

      const newScript = debugger_.getScriptById(newTop.location.scriptId);
      const newUrl = newScript?.url || newTop.url || '';

      // URL 过滤：只跟踪用户脚本（如果指定了 urlPattern）
      if (
        options.urlPattern &&
        !newUrl.toLowerCase().includes(options.urlPattern.toLowerCase())
      ) {
        // 不在目标脚本范围 → stepOut 跳出
        const stepOutPaused = waitForPausedEvent(client, options.stepTimeoutMs);
        try {
          await client.send('Debugger.stepOut');
          await stepOutPaused;
          continue;
        } catch {
          break;
        }
      }

      const fnKey = `${newTop.location.scriptId}:${newTop.functionName}`;

      // 同一函数内的步进（line 变化但函数名未变）→ stepOver 而不是 stepInto
      if (
        chain[chain.length - 1].wrapper_name === newTop.functionName &&
        chain[chain.length - 1].script_id === newTop.location.scriptId
      ) {
        // 还在同一函数内，跳过（继续 stepInto 直到进入新函数或到达 case body）
        continue;
      }

      // 循环检测：进入已访问的函数 → 视为 final
      if (visitedFunctions.has(fnKey)) {
        chain[chain.length - 1].is_final = true;
        break;
      }
      visitedFunctions.add(fnKey);

      currentDepth++;
      const {scriptSource: newSource} = await debugger_.getScriptSource(
        newTop.location.scriptId,
      );
      const newLines = newSource.split('\n');
      const newPreview = newLines
        .slice(
          Math.max(0, newTop.location.lineNumber - 5),
          newTop.location.lineNumber + 25,
        )
        .join('\n');
      const newArgs = await collectFrameArgs(debugger_, newTop.callFrameId);
      const newPattern = detectCallPattern(newPreview);

      chain.push({
        depth: currentDepth,
        wrapper_name: newTop.functionName || '<anonymous>',
        script_url: newUrl,
        script_id: newTop.location.scriptId,
        line_number: newTop.location.lineNumber + 1,
        column_number: newTop.location.columnNumber ?? 0,
        call_pattern: newPattern.pattern,
        call_count: newPattern.callCount,
        arg_modes: newArgs,
        is_final: newPattern.pattern === 'final_case_body',
        source_preview: newPreview.slice(0, 800),
      });

      if (newPattern.pattern === 'final_case_body') {
        break;
      }
    } catch {
      // 步进超时或断点丢失：停止该 sample
      break;
    }
  }

  if (
    currentDepth >= options.maxChainDepth &&
    !chain[chain.length - 1].is_final
  ) {
    truncated = true;
  }

  return {
    sample_index: sampleIndex,
    chain,
    truncated,
  };
}

async function collectFrameArgs(
  debugger_: DebuggerContext,
  callFrameId: string,
): Promise<string[]> {
  try {
    const result = await debugger_.evaluateOnCallFrame(
      callFrameId,
      `(() => { try { return JSON.stringify(Array.from(arguments).map(a => { if (a === null) return 'null'; if (a === undefined) return 'undefined'; const t = typeof a; if (t === 'number' || t === 'boolean') return t + ':' + a; if (t === 'string') return 'string:' + (a.length > 30 ? a.slice(0,30)+'…' : a); if (Array.isArray(a)) return 'array['+a.length+']'; if (t === 'object') return 'object:'+(a.constructor?.name || '?'); return t; })).slice(0, 400); } catch(e) { return '["<arg_inspection_failed>"]'; } })()`,
      {returnByValue: true},
    );
    if (result.exceptionDetails || !result.result.value) {
      return [];
    }
    const parsed = JSON.parse(result.result.value as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ==================== YAML 序列化 ====================

function yamlEscape(value: string): string {
  if (
    value.includes('\n') ||
    value.includes(':') ||
    value.includes('#') ||
    value.includes('"') ||
    value.includes("'") ||
    value.match(/^[\s\-?!&*|>%@]/)
  ) {
    // 用双引号 + 转义
    return (
      '"' +
      value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') +
      '"'
    );
  }
  if (value === '' || value.match(/^(true|false|null|~|\d+(\.\d+)?)$/i)) {
    return `"${value}"`;
  }
  return value;
}

function yamlValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return yamlEscape(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      '\n' +
      value
        .map(item => {
          if (
            typeof item === 'object' &&
            item !== null &&
            !Array.isArray(item)
          ) {
            const lines = yamlObject(
              item as Record<string, unknown>,
              indent + 1,
            ).split('\n');
            return `${pad}- ${lines[0].trim()}\n${lines
              .slice(1)
              .filter(l => l.trim())
              .map(l => `${pad}  ${l.trim()}`)
              .join('\n')}`;
          }
          return `${pad}- ${yamlValue(item, indent + 1)}`;
        })
        .join('\n')
    );
  }
  if (typeof value === 'object') {
    return '\n' + yamlObject(value as Record<string, unknown>, indent + 1);
  }
  return String(value);
}

function yamlObject(obj: Record<string, unknown>, indent: number): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const rendered = yamlValue(value, indent);
    if (rendered.startsWith('\n')) {
      lines.push(`${pad}${key}:${rendered}`);
    } else {
      lines.push(`${pad}${key}: ${rendered}`);
    }
  }
  return lines.join('\n');
}

function serializeTraceYaml(payload: {
  entry: {
    id: string | number;
    function_name: string;
    script_url: string;
    line_number: number;
    column_number: number;
  };
  chain: ChainEntry[];
  total_chain_depth: number;
  sample_count_actual: number;
  sample_count_requested: number;
  stability_across_samples: boolean;
  chain_truncated: boolean;
  samples: Array<{
    sample_index: number;
    chain_function_names: string[];
  }>;
}): string {
  return yamlObject(payload as unknown as Record<string, unknown>, 0);
}

// ==================== 工具定义 ====================

export const traceDispatchChain = defineTool({
  name: 'trace_dispatch_chain',
  description:
    'Traces the full dispatcher trampoline wrapper chain for a custom_vm-style entry function. ' +
    'Sets a real breakpoint at entry → triggers the call via Runtime.evaluate → walks the chain via ' +
    'recursive stepInto → auto-detects 4 wrapper patterns (l.apply / closure / final case body / ' +
    'trampoline indirect). Replaces 30+ rounds of nested trace_function calls with a single tool call. ' +
    'Output: dispatch_chain_trace.yaml (inline if outputPath omitted) with full chain + stability across samples.',
  annotations: {
    title: 'Trace Dispatch Chain',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  schema: {
    entryFunctionName: zod
      .string()
      .describe(
        'Entry function name (e.g. dispatcher entry like "_0x4d8a" or "n.dispatch"). The tool searches for "function NAME" / "NAME=function" / etc. patterns.',
      ),
    entryId: zod
      .union([zod.string(), zod.number()])
      .optional()
      .describe(
        'Optional entry identifier (opcode number or label) used for logging/reporting only.',
      ),
    triggerExpression: zod
      .string()
      .describe(
        'JavaScript expression to execute inside the page to trigger the entry call. Example: "window.__zp_stoken__ && window.__zp_stoken__()" or "document.querySelector(\'#trigger\').click()".',
      ),
    urlPattern: zod
      .string()
      .optional()
      .describe(
        'Optional URL substring filter. When set, both entry search and stepInto frame filtering use it; non-matching frames are stepped over.',
      ),
    entryCondition: zod
      .string()
      .optional()
      .describe(
        'Optional conditional breakpoint expression. Only break when this is truthy. Example: "arguments[0] === 19854".',
      ),
    maxChainDepth: zod
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(10)
      .describe(
        'Maximum wrapper chain depth to follow. Chain is marked truncated when reached. Default 10.',
      ),
    sampleCount: zod
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(3)
      .describe(
        'Number of full trigger samples. Each sample re-triggers the entry and walks chain again. Used to verify stability_across_samples. Default 3.',
      ),
    pauseOnFinal: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'If true, the debugger stays paused after the last sample (caller must resume). Default false (auto resume after each sample).',
      ),
    triggerWaitMs: zod
      .number()
      .int()
      .min(100)
      .max(60000)
      .optional()
      .default(5000)
      .describe(
        'Max wait time (ms) for the entry breakpoint to be hit after trigger. Default 5000.',
      ),
    stepTimeoutMs: zod
      .number()
      .int()
      .min(100)
      .max(30000)
      .optional()
      .default(3000)
      .describe(
        'Max wait time (ms) for each stepInto/stepOut/stepOver to complete. Default 3000.',
      ),
    outputPath: zod
      .string()
      .optional()
      .describe(
        'Optional absolute path to save dispatch_chain_trace.yaml. If omitted, the YAML is returned inline in the response.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    if (!debugger_.isEnabled()) {
      response.appendResponseLine(
        'Debugger is not enabled. Please select a page first.',
      );
      return;
    }

    const {
      entryFunctionName,
      entryId,
      triggerExpression,
      urlPattern,
      entryCondition,
      maxChainDepth,
      sampleCount,
      pauseOnFinal,
      triggerWaitMs,
      stepTimeoutMs,
      outputPath,
    } = request.params;

    let entryBreakpoint: BreakpointInfo | null = null;

    try {
      // 步骤 1：定位 entry 函数
      response.appendResponseLine(
        `Locating entry function "${entryFunctionName}"…`,
      );
      const entryLocation = await locateEntryFunction(
        debugger_,
        entryFunctionName,
        urlPattern,
      );
      if (!entryLocation) {
        response.appendResponseLine(
          `❌ Entry function "${entryFunctionName}" not found in any loaded script${urlPattern ? ` matching "${urlPattern}"` : ''}.`,
        );
        response.appendResponseLine(
          'Tip: Use search_in_sources to verify the exact function signature first.',
        );
        return;
      }
      response.appendResponseLine(
        `Found at ${entryLocation.url}:${entryLocation.lineNumber + 1}:${entryLocation.columnNumber}`,
      );

      // 步骤 2：在 entry 设真实断点
      entryBreakpoint = await debugger_.setBreakpoint(
        entryLocation.url,
        entryLocation.lineNumber,
        entryLocation.columnNumber,
        entryCondition,
      );
      response.appendResponseLine(
        `Breakpoint set at entry (id=${entryBreakpoint.breakpointId})${entryCondition ? `, condition: ${entryCondition}` : ''}`,
      );

      // 步骤 3：多 sample 链路追踪
      const samples: SampleResult[] = [];
      for (let i = 0; i < sampleCount; i++) {
        response.appendResponseLine(
          `\n=== Sample ${i + 1}/${sampleCount} ===`,
        );
        try {
          const sample = await walkSingleSample(debugger_, i, entryLocation, {
            maxChainDepth,
            triggerExpression,
            triggerWaitMs,
            stepTimeoutMs,
            urlPattern,
          });
          samples.push(sample);
          response.appendResponseLine(
            `  chain depth: ${sample.chain.length}${sample.truncated ? ' (truncated)' : ''}`,
          );
          for (const entry of sample.chain) {
            response.appendResponseLine(
              `    [${entry.depth}] ${entry.wrapper_name} (${entry.call_pattern}) @ ${entry.script_url.split('/').pop() || entry.script_url}:${entry.line_number}`,
            );
          }
        } catch (err) {
          response.appendResponseLine(
            `  ⚠️ Sample ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          samples.push({sample_index: i, chain: [], truncated: false});
        }

        // 不是最后一个 sample → 必须 resume 让原触发流程跑完
        if (i < sampleCount - 1 && debugger_.isPaused()) {
          try {
            await debugger_.resume();
          } catch {
            // resume 失败：忽略
          }
        }
      }

      // 步骤 4：稳定性判定
      const nonEmptySamples = samples.filter(s => s.chain.length > 0);
      const firstChain = nonEmptySamples[0]?.chain.map(c => c.wrapper_name) ?? [];
      const stability =
        nonEmptySamples.length > 1 &&
        nonEmptySamples.every(
          s =>
            s.chain.length === firstChain.length &&
            s.chain.every((c, idx) => c.wrapper_name === firstChain[idx]),
        );

      // 取第一个 sample 作为代表链路
      const representativeChain = nonEmptySamples[0]?.chain ?? [];
      const truncated = samples.some(s => s.truncated);

      // 步骤 5：构造输出 payload
      const payload = {
        entry: {
          id: entryId ?? entryFunctionName,
          function_name: entryFunctionName,
          script_url: entryLocation.url,
          line_number: entryLocation.lineNumber + 1,
          column_number: entryLocation.columnNumber,
        },
        chain: representativeChain,
        total_chain_depth: representativeChain.length,
        sample_count_actual: nonEmptySamples.length,
        sample_count_requested: sampleCount,
        stability_across_samples: stability,
        chain_truncated: truncated,
        samples: samples.map(s => ({
          sample_index: s.sample_index,
          chain_function_names: s.chain.map(c => c.wrapper_name),
        })),
      };

      const yamlContent = serializeTraceYaml(payload);

      // 步骤 6：落盘 / inline 返回
      response.appendResponseLine('\n=== Result ===');
      response.appendResponseLine(
        `total_chain_depth: ${payload.total_chain_depth}`,
      );
      response.appendResponseLine(
        `sample_count_actual: ${payload.sample_count_actual}/${payload.sample_count_requested}`,
      );
      response.appendResponseLine(
        `stability_across_samples: ${payload.stability_across_samples}`,
      );
      response.appendResponseLine(
        `chain_truncated: ${payload.chain_truncated}`,
      );

      if (outputPath) {
        try {
          const data = new TextEncoder().encode(yamlContent);
          const result = await context.saveFile(data, outputPath);
          response.appendResponseLine(
            `\n✅ Trace saved to ${result.filename} (${yamlContent.length} chars).`,
          );
        } catch (err) {
          response.appendResponseLine(
            `\n⚠️ saveFile failed (${err instanceof Error ? err.message : String(err)}). Falling back to inline.`,
          );
          response.appendResponseLine('\n```yaml');
          response.appendResponseLine(yamlContent);
          response.appendResponseLine('```');
        }
      } else {
        response.appendResponseLine('\n```yaml');
        response.appendResponseLine(yamlContent);
        response.appendResponseLine('```');
      }
    } catch (error) {
      response.appendResponseLine(
        `\n❌ Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // 步骤 7：清理 entry 断点（保留 paused 状态由 pauseOnFinal 控制）
      if (entryBreakpoint) {
        try {
          await debugger_.removeBreakpoint(entryBreakpoint.breakpointId);
          response.appendResponseLine(
            `\nEntry breakpoint removed (id=${entryBreakpoint.breakpointId}).`,
          );
        } catch {
          // 忽略清理失败
        }
      }
      // 处理终态：默认 resume
      if (debugger_.isPaused() && !pauseOnFinal) {
        try {
          await debugger_.resume();
          response.appendResponseLine('▶️ Execution resumed.');
        } catch {
          // 忽略 resume 失败
        }
      } else if (debugger_.isPaused() && pauseOnFinal) {
        response.appendResponseLine(
          '⏸️ Execution remains paused (pauseOnFinal=true). Use pause_or_resume to resume.',
        );
      }
    }
  },
});
