/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * [LOCAL FORK] 本地二开新增工具的统一聚合入口。
 *
 * main.ts 只需 `import * as localTools from './tools/localIndex.js'` 并把
 * `...Object.values(localTools)` 加入 tools 数组即可注册全部本地工具——无论以后
 * 新增多少本地工具，对上游 main.ts 的侵入都固定为那两行，便于持续同步上游。
 *
 * 这些工具全部位于独立文件（上游不碰这些路径），因此上游更新时几乎不会冲突。
 */

// 调用图分析 / 函数搜索
export {analyzeCallGraph, searchFunctions} from './analysis.js';

// dispatcher 链路自动追踪
export {traceDispatchChain} from './dispatchChain.js';

// UI 交互（上游 interaction.ts 只有 click_element，这里补齐其余交互能力）
export {
  fill,
  typeText,
  pressKey,
  hover,
  drag,
  uploadFile,
  handleDialog,
  waitFor,
} from './input.js';

// a11y 树快照
export {takeSnapshot} from './snapshot.js';

// 脚本拦截 / 替换
export {
  overrideScriptWithFile,
  listScriptOverrides,
  removeScriptOverride,
  clearScriptOverrides,
  replaceScript,
  listScriptReplacements,
  removeScriptReplacement,
  clearScriptReplacements,
} from './intercept.js';

// 页面控制补充（list / close / resize / emulate）
export {listPages, closePage, resizePage, emulate} from './pagesExtra.js';
