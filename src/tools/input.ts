/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UI 交互工具：点击、输入、按键、悬停、拖拽、文件上传、对话框处理、等待文本。
 * 使用 CSS 选择器定位元素（Patchright/Playwright API）。
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool, timeoutSchema} from './ToolDefinition.js';

/**
 * 解析按键组合字符串，返回 [主键, ...修饰键]。
 * 例如 "Control+Shift+A" → ["a", "Control", "Shift"]
 */
function parseKey(keyStr: string): [string, ...string[]] {
  const modifiers = ['Control', 'Shift', 'Alt', 'Meta'];
  const parts = keyStr.split('+');
  const mods: string[] = [];
  let mainKey = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // 处理 "Control++" 的情况：最后一个空字符串表示 "+"
    if (part === '' && i === parts.length - 1) {
      mainKey = '+';
    } else if (modifiers.includes(part)) {
      mods.push(part);
    } else {
      mainKey = part;
    }
  }

  if (!mainKey && mods.length > 0) {
    // 如果没有主键但有修饰键，最后一个修饰键作为主键
    mainKey = mods.pop()!;
  }

  return [mainKey, ...mods];
}

export const fill = defineTool({
  name: 'fill',
  description: `输入文本到 input/textarea，或从 <select> 中选择选项。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    selector: zod
      .string()
      .describe('目标元素的 CSS 选择器'),
    value: zod.string().describe('要填入的值'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const selector = request.params.selector;
    const value = request.params.value;

    await context.waitForEventsAfterAction(async () => {
      // 检测是否为 select 元素
      const tagName = await page.$eval(selector, (el: Element) => el.tagName.toLowerCase());
      if (tagName === 'select') {
        await page.selectOption(selector, value);
      } else {
        await page.fill(selector, value);
      }
    });

    response.appendResponseLine(`成功填入内容到元素: ${selector}`);
  },
});

export const typeText = defineTool({
  name: 'type_text',
  description: `通过键盘输入文本到当前聚焦的元素。与 fill 不同，此工具逐字模拟键盘输入。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    text: zod.string().describe('要输入的文本'),
    submitKey: zod
      .string()
      .optional()
      .describe('输入完成后按下的键，如 "Enter"、"Tab"、"Escape"'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();

    await page.keyboard.type(request.params.text);

    if (request.params.submitKey) {
      await page.keyboard.press(request.params.submitKey);
    }

    response.appendResponseLine(
      `成功输入文本${request.params.submitKey ? `并按下 ${request.params.submitKey}` : ''}`,
    );
  },
});

export const pressKey = defineTool({
  name: 'press_key',
  description: `按键或组合键。用于键盘快捷键、导航键或特殊按键组合。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    key: zod
      .string()
      .describe(
        '按键或组合（如 "Enter", "Control+A", "Control++", "Control+Shift+R"）。修饰键: Control, Shift, Alt, Meta',
      ),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const [key, ...modifiers] = parseKey(request.params.key);

    await context.waitForEventsAfterAction(async () => {
      for (const modifier of modifiers) {
        await page.keyboard.down(modifier);
      }
      await page.keyboard.press(key);
      for (const modifier of modifiers.toReversed()) {
        await page.keyboard.up(modifier);
      }
    });

    response.appendResponseLine(`成功按下: ${request.params.key}`);
  },
});

export const hover = defineTool({
  name: 'hover',
  description: `悬停在指定元素上。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    selector: zod
      .string()
      .describe('目标元素的 CSS 选择器'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    await page.hover(request.params.selector);
    response.appendResponseLine(`成功悬停在元素: ${request.params.selector}`);
  },
});

export const drag = defineTool({
  name: 'drag',
  description: `将一个元素拖拽到另一个元素上。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    fromSelector: zod
      .string()
      .describe('被拖拽元素的 CSS 选择器'),
    toSelector: zod
      .string()
      .describe('目标元素的 CSS 选择器'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    await page.dragAndDrop(request.params.fromSelector, request.params.toSelector);
    response.appendResponseLine(
      `成功将 ${request.params.fromSelector} 拖拽到 ${request.params.toSelector}`,
    );
  },
});

export const uploadFile = defineTool({
  name: 'upload_file',
  description: `通过文件输入元素上传文件。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    selector: zod
      .string()
      .describe('文件输入元素的 CSS 选择器'),
    filePath: zod
      .string()
      .describe('要上传的本地文件路径'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    await page.setInputFiles(request.params.selector, request.params.filePath);
    response.appendResponseLine(
      `成功上传文件 ${request.params.filePath} 到 ${request.params.selector}`,
    );
  },
});

export const handleDialog = defineTool({
  name: 'handle_dialog',
  description: `处理浏览器对话框（alert/confirm/prompt）。接受或关闭。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['accept', 'dismiss'])
      .describe('接受或关闭对话框'),
    promptText: zod
      .string()
      .optional()
      .describe('可选的 prompt 对话框输入文本'),
  },
  handler: async (request, response, context) => {
    const dialog = context.getDialog();
    if (!dialog) {
      response.appendResponseLine('当前没有打开的对话框。');
      return;
    }

    if (request.params.action === 'accept') {
      await dialog.accept(request.params.promptText);
      response.appendResponseLine('已接受对话框。');
    } else {
      await dialog.dismiss();
      response.appendResponseLine('已关闭对话框。');
    }
    context.clearDialog();
  },
});

export const waitFor = defineTool({
  name: 'wait_for',
  description: `等待指定文本出现在页面上。支持多个文本，任一出现即返回。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    text: zod
      .array(zod.string())
      .min(1)
      .describe('要等待出现的文本列表，任一出现即成功。'),
    ...timeoutSchema,
  },
  handler: async (request, response, context) => {
    const texts = request.params.text;
    const timeout = request.params.timeout ?? 5000;

    // 检查 JS 是否被断点暂停：暂停时 DOM 冻结，wait_for 无意义
    if (context.debuggerContext.isEnabled() && context.debuggerContext.isPaused()) {
      response.appendResponseLine(
        `⚠️ 页面 JS 当前被断点暂停，DOM 已冻结，wait_for 无法工作。请先调用 pause_or_resume 恢复执行。`,
      );
      return;
    }

    // 并行等待所有文本，任一匹配即成功
    const results = texts.map(t =>
      context.waitForTextOnPage({text: t, timeout}),
    );

    // Node.js 级别超时保护：当页面 JS 被断点暂停时，
    // Playwright 的 locator.waitFor() timer 可能被冻结，
    // 导致 Promise.race 永远 pending 并阻塞整个 MCP 连接。
    // 使用独立于浏览器的 Node.js setTimeout 作为兜底。
    const nodeTimeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`wait_for: Node.js 级别超时 (${timeout}ms)`)),
        timeout + 1000, // 比 Playwright timeout 多 1 秒作为兜底
      );
    });

    try {
      await Promise.race([Promise.race(results), nodeTimeout]);
      response.appendResponseLine(`文本已出现在页面上。`);
    } catch {
      response.appendResponseLine(
        `等待超时，以下文本未出现: ${texts.join(', ')}`,
      );
    }
  },
});
