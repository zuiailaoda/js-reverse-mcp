/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * [LOCAL FORK] 导航断点自愈逻辑。
 *
 * 上游 navigate_page 遇到断点暂停时，会主动停止加载并提示用户手动 resume。
 * 本 fork 额外提供"自动容错"：暂停时自动清空所有 XHR / 代码断点并 resume，
 * 然后尽力等待加载完成。逻辑抽到此独立文件，navigate_page 的每个分支只需
 * 调用 healPausedNavigation() 一行，将对上游 pages.ts 的侵入降到最小。
 */

import type {DebuggerContext} from '../DebuggerContext.js';
import type {Page} from '../third_party/index.js';

import type {Response} from './ToolDefinition.js';

interface AutoRecoveryResult {
  resumed: boolean;
  clearedXHRBreakpoints: string[];
  clearedCodeBreakpoints: string[];
  error?: string;
}

/**
 * 当导航因断点暂停时的自动恢复：
 * 1. 未暂停 → no-op。
 * 2. 暂停 → 移除全部 XHR 断点 + 全部代码断点，然后 resume。不做选择性恢复：
 *    重新设置同样的断点只会在下次导航再次卡住。用户如仍需要断点，需显式重设。
 */
async function autoResumeAfterNavigationTimeout(
  debugger_: DebuggerContext,
): Promise<AutoRecoveryResult> {
  if (!debugger_.isPaused()) {
    return {
      resumed: false,
      clearedXHRBreakpoints: [],
      clearedCodeBreakpoints: [],
    };
  }

  // 1. 移除所有 XHR 断点（导航暂停最常见的原因）。
  const xhrBreakpoints = debugger_.getXHRBreakpoints();
  const clearedXHR: string[] = [];
  for (const url of xhrBreakpoints) {
    try {
      await debugger_.removeXHRBreakpoint(url);
      clearedXHR.push(url);
    } catch {
      // 单个失败跳过，继续移除其余。
    }
  }

  // 2. 移除所有代码断点——它们若落在导航期间加载的脚本上，同样会拦截导航。
  const codeBreakpoints = debugger_.getBreakpoints();
  const clearedCode: string[] = [];
  for (const bp of codeBreakpoints) {
    try {
      await debugger_.removeBreakpoint(bp.breakpointId);
      clearedCode.push(`${bp.url}:${bp.lineNumber + 1}`);
    } catch {
      // 单个失败跳过，继续移除其余。
    }
  }

  // 3. resume。断点清空后 resume 应能让页面继续加载而不再触发暂停。
  try {
    await debugger_.resume();
    return {
      resumed: true,
      clearedXHRBreakpoints: clearedXHR,
      clearedCodeBreakpoints: clearedCode,
    };
  } catch (e) {
    return {
      resumed: false,
      clearedXHRBreakpoints: clearedXHR,
      clearedCodeBreakpoints: clearedCode,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 构造自愈动作的可读摘要。 */
function formatAutoRecoveryResult(result: AutoRecoveryResult): string {
  const parts: string[] = [];
  if (result.clearedXHRBreakpoints.length > 0) {
    parts.push(
      `cleared ${result.clearedXHRBreakpoints.length} XHR breakpoint(s): ${JSON.stringify(result.clearedXHRBreakpoints)}`,
    );
  }
  if (result.clearedCodeBreakpoints.length > 0) {
    parts.push(
      `cleared ${result.clearedCodeBreakpoints.length} code breakpoint(s): ${JSON.stringify(result.clearedCodeBreakpoints)}`,
    );
  }
  if (parts.length === 0) {
    parts.push('no breakpoints to clear');
  }
  return parts.join('; ');
}

/**
 * 在 navigate_page 检测到断点暂停时调用：自动清断点 + resume，然后尽力等待
 * 加载完成。返回是否视为导航完成（用于后续 restoreXHRBreakpoints 判断）。
 */
export async function healPausedNavigation(
  debugger_: DebuggerContext,
  page: Page,
  response: Response,
  timeout: number,
  label: string,
): Promise<boolean> {
  const recovery = await autoResumeAfterNavigationTimeout(debugger_);
  if (recovery.resumed) {
    response.appendResponseLine(
      `${label} paused at a breakpoint. Auto-recovery: ${formatAutoRecoveryResult(recovery)}; then resumed execution.`,
    );
    try {
      await page.waitForLoadState('domcontentloaded', {timeout});
      response.appendResponseLine('Re-navigation after auto-recovery succeeded.');
      response.appendResponseLine(
        'Note: Any previously obtained script IDs are now invalid. Use script URLs instead.',
      );
      return true;
    } catch (retryErr) {
      response.appendResponseLine(
        `Re-navigation after auto-recovery also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}. Page may be partially loaded.`,
      );
      return false;
    }
  }
  response.appendResponseLine(
    `${label} paused at a breakpoint. Auto-recovery FAILED${recovery.error ? `: ${recovery.error}` : ''} (${formatAutoRecoveryResult(recovery)}). Use get_paused_info then pause_or_resume(action="resume").`,
  );
  return false;
}
