/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 代码分析工具：函数调用图分析 & 函数搜索。
 * 基于正则解析（无需 AST 依赖），适用于逆向分析场景。
 */

import type {ScriptInfo} from '../DebuggerContext.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// ==================== 类型定义 ====================

/** 函数类型 */
type FunctionType =
  | 'declaration'   // function foo() {}
  | 'expression'    // const foo = function() {}
  | 'arrow'         // const foo = () => {}
  | 'method'        // obj.foo() {} / class { foo() {} }
  | 'anonymous';    // 匿名函数

/** 函数信息 */
interface FunctionInfo {
  name: string;
  scriptId: string;
  scriptUrl: string;
  lineNumber: number;       // 1-based
  columnNumber: number;     // 0-based
  params: string[];
  type: FunctionType;
}

/** 调用关系 */
interface CallInfo {
  caller: string;
  callee: string;
  scriptId: string;
  lineNumber: number;
}

/** 解析单个脚本的结果 */
interface ParseResult {
  functions: FunctionInfo[];
  calls: CallInfo[];
}

/** 调用图 */
interface CallGraph {
  calls: Map<string, Set<string>>;       // caller -> callees
  calledBy: Map<string, Set<string>>;    // callee -> callers
  functions: Map<string, FunctionInfo>;
}

/** 调用追踪树 */
interface TraceResult {
  [functionName: string]: TraceResult | 'Leaf';
}

// ==================== 正则解析器 ====================

/**
 * 将字符偏移转换为行列号。
 */
function offsetToLineCol(source: string, offset: number): {line: number; col: number} {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lastNl = i;
    }
  }
  return {line, col: offset - lastNl - 1};
}

/**
 * 用正则从脚本源码中提取函数定义和调用关系。
 * 不依赖 AST 库，适合压缩/混淆代码。
 */
function parseScript(
  scriptId: string,
  scriptUrl: string,
  source: string,
): ParseResult {
  const functions: FunctionInfo[] = [];
  const calls: CallInfo[] = [];

  // --- 提取函数定义 ---

  // function declarations: function foo(a, b) {
  const declRe = /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const pos = offsetToLineCol(source, m.index);
    functions.push({
      name: m[1],
      scriptId,
      scriptUrl,
      lineNumber: pos.line,
      columnNumber: pos.col,
      params: extractParams(m[2]),
      type: 'declaration',
    });
  }

  // 变量赋值函数: const/let/var foo = function / () =>
  const exprRe = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:function\s*(?:\w*)?\s*\(([^)]*)\)|(\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>)/g;
  while ((m = exprRe.exec(source)) !== null) {
    const pos = offsetToLineCol(source, m.index);
    const paramStr = m[2] ?? (m[3] ? m[3].replace(/^\(|\)$/g, '') : '');
    const isArrow = !m[2];
    functions.push({
      name: m[1],
      scriptId,
      scriptUrl,
      lineNumber: pos.line,
      columnNumber: pos.col,
      params: extractParams(paramStr),
      type: isArrow ? 'arrow' : 'expression',
    });
  }

  // 对象/类方法: methodName(params) { 或 methodName: function(params) {
  const methodRe = /([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  while ((m = methodRe.exec(source)) !== null) {
    const name = m[1];
    // 排除关键字和已匹配的 function 声明
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'throw', 'new', 'typeof', 'delete', 'void', 'else'].includes(name)) continue;
    // 检查是否已经记录过（同名同行）
    const pos = offsetToLineCol(source, m.index);
    const exists = functions.some(f => f.name === name && f.lineNumber === pos.line && f.scriptId === scriptId);
    if (!exists) {
      functions.push({
        name,
        scriptId,
        scriptUrl,
        lineNumber: pos.line,
        columnNumber: pos.col,
        params: extractParams(m[2]),
        type: 'method',
      });
    }
  }

  // --- 提取调用关系 ---
  // 简化策略：找出所有 foo( 形式的调用，caller 用最近的函数定义推断
  const callRe = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
  const keywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'throw',
    'new', 'typeof', 'delete', 'void', 'else', 'class', 'const', 'let', 'var',
    'import', 'export', 'default', 'from', 'as', 'try', 'finally', 'do',
  ]);

  // 排序函数定义，用于推断 caller
  const sortedFuncs = [...functions].sort((a, b) => {
    if (a.scriptId !== b.scriptId) return a.scriptId.localeCompare(b.scriptId);
    return a.lineNumber - b.lineNumber;
  }).filter(f => f.scriptId === scriptId);

  while ((m = callRe.exec(source)) !== null) {
    const callee = m[1];
    if (keywords.has(callee)) continue;

    const pos = offsetToLineCol(source, m.index);
    // 找到包含此调用的最近函数（作为 caller）
    let caller = '<global>';
    for (let i = sortedFuncs.length - 1; i >= 0; i--) {
      if (sortedFuncs[i].lineNumber <= pos.line) {
        caller = sortedFuncs[i].name;
        break;
      }
    }

    calls.push({caller, callee, scriptId, lineNumber: pos.line});
  }

  return {functions, calls};
}

/**
 * 从参数字符串中提取参数名列表。
 */
function extractParams(paramStr: string): string[] {
  if (!paramStr || !paramStr.trim()) return [];
  return paramStr.split(',').map(p => p.trim().replace(/\s*=.*$/, '')).filter(Boolean);
}

// ==================== 调用图构建与查询 ====================

function buildCallGraph(parseResults: ParseResult[]): CallGraph {
  const calls = new Map<string, Set<string>>();
  const calledBy = new Map<string, Set<string>>();
  const functions = new Map<string, FunctionInfo>();

  for (const result of parseResults) {
    for (const func of result.functions) {
      if (!functions.has(func.name)) {
        functions.set(func.name, func);
      }
    }
    for (const call of result.calls) {
      if (!calls.has(call.caller)) calls.set(call.caller, new Set());
      calls.get(call.caller)!.add(call.callee);

      if (!calledBy.has(call.callee)) calledBy.set(call.callee, new Set());
      calledBy.get(call.callee)!.add(call.caller);
    }
  }

  return {calls, calledBy, functions};
}

/**
 * 上游追踪（谁调用了目标函数）。
 */
function getUpstreamTrace(graph: CallGraph, name: string, depth: number): TraceResult {
  const result: TraceResult = {};
  const visited = new Set<string>();

  function trace(n: string, d: number): TraceResult {
    if (d <= 0 || visited.has(n)) return {};
    visited.add(n);
    const callers = graph.calledBy.get(n);
    if (!callers || callers.size === 0) { visited.delete(n); return {}; }
    const r: TraceResult = {};
    for (const c of callers) {
      if (visited.has(c)) { r[c] = 'Leaf'; continue; }
      const sub = trace(c, d - 1);
      r[c] = Object.keys(sub).length > 0 ? sub : 'Leaf';
    }
    visited.delete(n);
    return r;
  }

  const callers = graph.calledBy.get(name);
  if (callers) {
    for (const c of callers) {
      const sub = trace(c, depth - 1);
      result[c] = Object.keys(sub).length > 0 ? sub : 'Leaf';
    }
  }
  return result;
}

/**
 * 下游追踪（目标函数调用了谁）。
 */
function getDownstreamTrace(graph: CallGraph, name: string, depth: number): TraceResult {
  const result: TraceResult = {};
  const visited = new Set<string>();

  function trace(n: string, d: number): TraceResult {
    if (d <= 0 || visited.has(n)) return {};
    visited.add(n);
    const callees = graph.calls.get(n);
    if (!callees || callees.size === 0) { visited.delete(n); return {}; }
    const r: TraceResult = {};
    for (const c of callees) {
      if (visited.has(c)) { r[c] = 'Leaf'; continue; }
      const sub = trace(c, d - 1);
      r[c] = Object.keys(sub).length > 0 ? sub : 'Leaf';
    }
    visited.delete(n);
    return r;
  }

  const callees = graph.calls.get(name);
  if (callees) {
    for (const c of callees) {
      const sub = trace(c, depth - 1);
      result[c] = Object.keys(sub).length > 0 ? sub : 'Leaf';
    }
  }
  return result;
}

/**
 * Levenshtein 距离（用于模糊匹配函数名）。
 */
function levenshteinDistance(a: string, b: string): number {
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

function findSimilarFunctions(graph: CallGraph, name: string, limit = 5): string[] {
  const results: Array<{name: string; score: number}> = [];
  for (const fn of graph.functions.keys()) {
    if (fn === name) continue;
    const maxLen = Math.max(fn.length, name.length);
    if (maxLen === 0) continue;
    const dist = levenshteinDistance(fn.toLowerCase(), name.toLowerCase());
    let score = 1 - dist / maxLen;
    // 子串加分
    if (fn.toLowerCase().includes(name.toLowerCase())) score += 0.3;
    results.push({name: fn, score});
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit).map(r => r.name);
}

/**
 * 格式化调用追踪树为可读文本。
 */
function formatTraceTree(trace: TraceResult, prefix = '', isLast = true): string {
  const entries = Object.entries(trace);
  if (entries.length === 0) return '';
  let result = '';
  entries.forEach(([name, value], index) => {
    const isLastEntry = index === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    result += `${prefix}${connector}${name}\n`;
    if (value !== 'Leaf' && Object.keys(value).length > 0) {
      result += formatTraceTree(value, prefix + childPrefix, isLastEntry);
    }
  });
  return result;
}

// ==================== 获取脚本源码的辅助函数 ====================

/**
 * 获取所有脚本及其源码（可选 URL 过滤）。
 * 通过 DebuggerContext 获取脚本列表，逐个拉取源码。
 */
async function getAllScriptsWithSource(
  debugger_: {
    getScripts(): ScriptInfo[];
    getScriptSource(
      scriptId: string,
    ): Promise<{scriptSource: string; bytecode?: string}>;
  },
  urlPattern?: string,
  excludeMinified = true,
): Promise<Map<string, {url: string; source: string}>> {
  const scripts = debugger_.getScripts();
  const filtered = urlPattern
    ? scripts.filter(s => {
        try {
          return new RegExp(urlPattern, 'i').test(s.url);
        } catch {
          return s.url.toLowerCase().includes(urlPattern.toLowerCase());
        }
      })
    : scripts.filter(s => s.url); // 排除无 URL 的内联脚本

  const result = new Map<string, {url: string; source: string}>();

  for (const script of filtered) {
    try {
      const {scriptSource: source} = await debugger_.getScriptSource(
        script.scriptId,
      );
      if (!source) continue;
      // 排除极端压缩文件（单行超长），除非用户指定了 urlPattern
      if (excludeMinified && !urlPattern) {
        const firstNewline = source.indexOf('\n');
        if (firstNewline === -1 && source.length > 50000) continue;
        if (firstNewline > 50000) continue;
      }
      result.set(script.scriptId, {url: script.url, source});
    } catch {
      // 忽略获取源码失败的脚本
    }
  }

  return result;
}

// ==================== 工具定义 ====================

/**
 * analyze_call_graph - 分析指定函数的调用图（上游调用者 + 下游被调用者）。
 */
export const analyzeCallGraph = defineTool({
  name: 'analyze_call_graph',
  description:
    'Analyze the call graph for a specific JavaScript function to understand its callers and callees. ' +
    'Parses all loaded scripts to build function call relationships, then traces upstream (who calls it) ' +
    'and downstream (what it calls) paths. Useful for understanding code flow in reverse engineering.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    functionName: zod
      .string()
      .describe('要分析的函数名。'),
    upstreamDepth: zod
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe('上游追踪深度（调用者方向）。默认 3，最大 10。'),
    downstreamDepth: zod
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe('下游追踪深度（被调用者方向）。默认 3，最大 10。'),
    urlPattern: zod
      .string()
      .optional()
      .describe('可选的 URL 正则过滤，仅分析匹配的脚本。'),
  },
  handler: async (request, response, context) => {
    const {functionName, upstreamDepth, downstreamDepth, urlPattern} = request.params;
    const debugger_ = context.debuggerContext;

    response.appendResponseLine(`分析函数调用图: ${functionName}`);
    response.appendResponseLine('');

    // 获取所有脚本源码
    const scripts = await getAllScriptsWithSource(debugger_, urlPattern);

    if (scripts.size === 0) {
      response.appendResponseLine('未找到任何脚本。');
      if (urlPattern) {
        response.appendResponseLine(`   URL 过滤: ${urlPattern}`);
      }
      return;
    }

    response.appendResponseLine(`已解析 ${scripts.size} 个脚本`);

    // 解析所有脚本
    const parseResults: ParseResult[] = [];
    let totalFunctions = 0;
    let totalCalls = 0;

    for (const [scriptId, {url, source}] of scripts) {
      const result = parseScript(scriptId, url, source);
      parseResults.push(result);
      totalFunctions += result.functions.length;
      totalCalls += result.calls.length;
    }

    response.appendResponseLine(`发现 ${totalFunctions} 个函数, ${totalCalls} 个调用关系`);
    response.appendResponseLine('');

    // 构建调用图
    const graph = buildCallGraph(parseResults);

    // 查找目标函数
    const funcInfo = graph.functions.get(functionName);

    if (!funcInfo) {
      response.appendResponseLine(`未找到函数 "${functionName}"。`);
      response.appendResponseLine('');
      const similar = findSimilarFunctions(graph, functionName);
      if (similar.length > 0) {
        response.appendResponseLine('相似函数:');
        for (const name of similar) {
          const info = graph.functions.get(name);
          if (info) {
            response.appendResponseLine(`   • ${name} (${info.scriptUrl}:${info.lineNumber})`);
          } else {
            response.appendResponseLine(`   • ${name}`);
          }
        }
      }
      return;
    }

    // 输出函数信息
    response.appendResponseLine(`已找到函数: ${funcInfo.name}`);
    response.appendResponseLine(`   位置: ${funcInfo.scriptUrl}:${funcInfo.lineNumber}:${funcInfo.columnNumber}`);
    response.appendResponseLine(`   类型: ${funcInfo.type}`);
    response.appendResponseLine(`   参数: ${funcInfo.params.length > 0 ? funcInfo.params.join(', ') : '(无)'}`);
    response.appendResponseLine('');

    // 上游追踪
    const upstream = getUpstreamTrace(graph, functionName, upstreamDepth);
    const upEntries = Object.keys(upstream);
    response.appendResponseLine(`上游（谁调用了 ${functionName}）: ${upEntries.length} 个直接调用者`);
    if (upEntries.length > 0) {
      response.appendResponseLine(formatTraceTree(upstream));
    } else {
      response.appendResponseLine('   (未找到调用者)');
    }
    response.appendResponseLine('');

    // 下游追踪
    const downstream = getDownstreamTrace(graph, functionName, downstreamDepth);
    const downEntries = Object.keys(downstream);
    response.appendResponseLine(`下游（${functionName} 调用了谁）: ${downEntries.length} 个直接被调用者`);
    if (downEntries.length > 0) {
      response.appendResponseLine(formatTraceTree(downstream));
    } else {
      response.appendResponseLine('   (未找到被调用者)');
    }
  },
});

/**
 * search_functions - 在已加载的脚本中搜索函数定义，返回结构化信息。
 */
export const searchFunctions = defineTool({
  name: 'search_functions',
  description:
    'Search for function definitions across all loaded JavaScript scripts. ' +
    'Returns structured information including function name, type, parameters, and location. ' +
    'Supports regex pattern matching on function names. Useful for locating target functions during reverse engineering.',
  annotations: {
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  schema: {
    pattern: zod
      .string()
      .describe('函数名搜索模式（正则表达式或普通字符串，大小写不敏感）。'),
    urlPattern: zod
      .string()
      .optional()
      .describe('可选的 URL 过滤，仅搜索匹配的脚本。'),
    maxResults: zod
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe('最大返回数量。默认 50，最大 200。'),
  },
  handler: async (request, response, context) => {
    const {pattern, urlPattern, maxResults} = request.params;
    const debugger_ = context.debuggerContext;

    // 构造匹配正则
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // 回退为字面量匹配
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    // 获取脚本源码
    const scripts = await getAllScriptsWithSource(debugger_, urlPattern, false);

    if (scripts.size === 0) {
      response.appendResponseLine('未找到任何脚本。');
      return;
    }

    // 解析并搜索
    const matches: FunctionInfo[] = [];

    for (const [scriptId, {url, source}] of scripts) {
      const result = parseScript(scriptId, url, source);
      for (const func of result.functions) {
        if (regex.test(func.name)) {
          matches.push(func);
          if (matches.length >= maxResults) break;
        }
      }
      if (matches.length >= maxResults) break;
    }

    response.appendResponseLine(`在 ${scripts.size} 个脚本中搜索函数: /${pattern}/i`);
    response.appendResponseLine(`找到 ${matches.length} 个匹配${matches.length >= maxResults ? '（已截断）' : ''}`);
    response.appendResponseLine('');

    if (matches.length === 0) {
      response.appendResponseLine('未找到匹配的函数。试试更宽泛的搜索模式。');
      return;
    }

    // 输出结构化结果
    for (const func of matches) {
      const params = func.params.length > 0 ? func.params.join(', ') : '';
      response.appendResponseLine(`${func.type.padEnd(12)} ${func.name}(${params})`);
      response.appendResponseLine(`             ${func.scriptUrl}:${func.lineNumber}:${func.columnNumber}`);
    }

    response.appendResponseLine('');
    response.appendResponseLine(
      '提示: 使用 get_script_source(url=..., startLine, endLine) 查看函数源码。' +
      '使用 analyze_call_graph(functionName) 分析函数调用关系。',
    );
  },
});
