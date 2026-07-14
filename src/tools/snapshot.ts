/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 页面 a11y 树文本快照工具。
 * 通过 CDP Accessibility.getFullAXTree 获取页面无障碍树结构。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

interface AXNode {
  nodeId: string;
  role: {value: string};
  name?: {value: string};
  value?: {value: string};
  description?: {value: string};
  properties?: Array<{name: string; value: {value: unknown}}>;
  childIds?: string[];
}

/**
 * 格式化 a11y 节点为可读文本。
 */
function formatNode(
  node: AXNode,
  nodeMap: Map<string, AXNode>,
  indent: number,
  verbose: boolean,
): string {
  const prefix = '  '.repeat(indent);
  const role = node.role?.value ?? 'unknown';
  const name = node.name?.value ?? '';
  const value = node.value?.value;

  // 跳过无意义的节点（非详细模式下）
  if (!verbose && role === 'none' && !name) {
    // 但仍然递归子节点
    return (node.childIds ?? [])
      .map(id => {
        const child = nodeMap.get(id);
        return child ? formatNode(child, nodeMap, indent, verbose) : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  let line = `${prefix}- ${role}`;
  if (name) line += ` "${name}"`;
  if (value !== undefined && value !== '') line += ` [value: "${value}"]`;

  if (verbose && node.properties) {
    for (const prop of node.properties) {
      const v = prop.value?.value;
      if (v !== undefined && v !== false && v !== '') {
        line += ` [${prop.name}: ${String(v)}]`;
      }
    }
  }

  const parts = [line];

  for (const childId of node.childIds ?? []) {
    const child = nodeMap.get(childId);
    if (child) {
      const childText = formatNode(child, nodeMap, indent + 1, verbose);
      if (childText) parts.push(childText);
    }
  }

  return parts.join('\n');
}

export const takeSnapshot = defineTool({
  name: 'take_snapshot',
  description: `获取当前页面的 a11y 树文本快照。列出页面元素及其角色、名称、值等信息。可用于理解页面结构和定位元素。`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    verbose: zod
      .boolean()
      .optional()
      .describe(
        '是否包含完整的无障碍树信息（disabled/focused/checked 等属性）。默认为 false。',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        '保存快照的文件路径（绝对路径或相对路径）。省略则直接返回在响应中。',
      ),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const verbose = request.params.verbose ?? false;

    // 通过 CDP 获取完整 a11y 树
    const session = await context.getCdpSession(page);
    const {nodes} = await session.send('Accessibility.getFullAXTree') as {nodes: AXNode[]};

    if (!nodes || nodes.length === 0) {
      response.appendResponseLine('无法获取页面快照（页面可能为空或未加载完成）。');
      return;
    }

    // 构建节点映射
    const nodeMap = new Map<string, AXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // 从根节点开始格式化
    const root = nodes[0];
    const text = formatNode(root, nodeMap, 0, verbose);

    if (request.params.filePath) {
      const filePath = path.resolve(request.params.filePath);
      await fs.writeFile(filePath, text, 'utf-8');
      response.appendResponseLine(`快照已保存到 ${filePath}`);
    } else {
      response.appendResponseLine(text);
    }
  },
});
