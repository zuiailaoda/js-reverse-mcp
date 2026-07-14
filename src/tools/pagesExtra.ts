/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * [LOCAL FORK] 页面控制补充工具，上游 v4.0.1 没有这些工具：
 *   - list_pages / close_page / resize_page
 *   - emulate（视口 / 颜色方案 / 地理位置 / 网络节流 / CPU 节流 / User-Agent）
 *
 * 独立文件，不侵入上游 pages.ts，便于持续同步上游。
 *
 * 网络 / CPU 节流通过 CDP 实现真实限速（Network.emulateNetworkConditions /
 * Emulation.setCPUThrottlingRate）。注意：这不同于旧本地实现——旧实现仅记录预设
 * 用于放大工具等待超时，并不真正限速。真实限速会启用 Network 域，仅在显式传入
 * networkConditions 时才启用，反检测场景下若无需节流请勿传该参数。
 */

import type {CDPSession} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {CLOSE_PAGE_ERROR, defineTool} from './ToolDefinition.js';

export const listPages = defineTool({
  name: 'list_pages',
  description: `列出浏览器中所有打开的页面。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response) => {
    response.setIncludePages(true);
  },
});

export const closePage = defineTool({
  name: 'close_page',
  description: `关闭指定索引的页面。最后一个打开的页面不能关闭。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    pageIdx: zod
      .number()
      .describe('要关闭的页面索引。调用 list_pages 查看可用页面。'),
  },
  handler: async (request, response, context) => {
    try {
      await context.closePage(request.params.pageIdx);
    } catch (err) {
      if (err instanceof Error && err.message === CLOSE_PAGE_ERROR) {
        response.appendResponseLine(err.message);
      } else {
        throw err;
      }
    }
    response.setIncludePages(true);
  },
});

export const resizePage = defineTool({
  name: 'resize_page',
  description: `调整当前页面的视口大小。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    width: zod.number().describe('页面宽度（像素）'),
    height: zod.number().describe('页面高度（像素）'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    await page.setViewportSize({
      width: request.params.width,
      height: request.params.height,
    });
    response.appendResponseLine(
      `视口已调整为 ${request.params.width}x${request.params.height}`,
    );
  },
});

// ==================== emulate 网络节流预设（真实 CDP 限速） ====================

interface NetworkPreset {
  offline: boolean;
  latency: number;
  download: number;
  upload: number;
}

// 数值参考 Chrome DevTools / Puppeteer 预设（吞吐单位 bytes/s，latency 单位 ms）。
const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  Offline: {offline: true, latency: 0, download: 0, upload: 0},
  'Slow 3G': {offline: false, latency: 2000, download: 50000, upload: 50000},
  'Fast 3G': {offline: false, latency: 562.5, download: 180000, upload: 84375},
  'Slow 4G': {offline: false, latency: 300, download: 400000, upload: 400000},
  'Fast 4G': {offline: false, latency: 100, download: 1000000, upload: 1000000},
};

async function applyNetworkThrottling(
  session: CDPSession,
  preset: NetworkPreset,
): Promise<void> {
  await session.send('Network.enable', {});
  await session.send('Network.emulateNetworkConditions', {
    offline: preset.offline,
    latency: preset.latency,
    downloadThroughput: preset.download,
    uploadThroughput: preset.upload,
  });
}

export const emulate = defineTool({
  name: 'emulate',
  description: `模拟设备特性：视口大小、颜色方案、地理位置、网络节流、CPU 节流、User-Agent。网络 / CPU 节流通过 CDP 真实限速（会启用 Network 域）。`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    viewport: zod
      .string()
      .optional()
      .describe('模拟设备视口，格式为 "<width>x<height>"（如 "375x812"）。'),
    colorScheme: zod
      .enum(['dark', 'light', 'auto'])
      .optional()
      .describe('模拟暗色或亮色模式。设为 "auto" 重置为默认。'),
    geolocation: zod
      .string()
      .optional()
      .describe(
        '模拟地理位置，格式为 "<latitude>x<longitude>"（如 "37.7749x-122.4194"）。省略则不修改。',
      ),
    networkConditions: zod
      .enum(['Offline', 'Slow 3G', 'Fast 3G', 'Slow 4G', 'Fast 4G'])
      .optional()
      .describe(
        '网络节流预设（通过 CDP 真实限速，会启用 Network 域）。省略则不修改，传 "Fast 4G" 近似不限速。',
      ),
    cpuThrottlingRate: zod
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe('CPU 减速倍率（1-20，通过 CDP 真实限速）。省略或设为 1 禁用节流。'),
    userAgent: zod
      .string()
      .optional()
      .describe('模拟 User-Agent（通过 CDP）。设为空字符串清除覆盖。'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const results: string[] = [];

    // 视口
    if (request.params.viewport) {
      const [w, h] = request.params.viewport.split('x').map(Number);
      if (w && h) {
        await page.setViewportSize({width: w, height: h});
        results.push(`视口: ${w}x${h}`);
      }
    }

    // 颜色方案
    if (request.params.colorScheme) {
      if (request.params.colorScheme === 'auto') {
        await page.emulateMedia({colorScheme: null});
        results.push('颜色方案: 已重置');
      } else {
        await page.emulateMedia({colorScheme: request.params.colorScheme});
        results.push(`颜色方案: ${request.params.colorScheme}`);
      }
    }

    // 地理位置
    if (request.params.geolocation !== undefined) {
      const [lat, lon] = request.params.geolocation.split('x').map(Number);
      if (!isNaN(lat) && !isNaN(lon)) {
        await page.context().grantPermissions(['geolocation']);
        await page.context().setGeolocation({latitude: lat, longitude: lon});
        results.push(`地理位置: ${lat}, ${lon}`);
      }
    }

    // 网络节流（CDP 真实限速）
    if (request.params.networkConditions !== undefined) {
      const session = await context.getCdpSession(page);
      const preset = NETWORK_PRESETS[request.params.networkConditions];
      await applyNetworkThrottling(session, preset);
      results.push(`网络条件: ${request.params.networkConditions}（CDP 真实限速）`);
    }

    // CPU 节流（CDP 真实限速）
    if (request.params.cpuThrottlingRate !== undefined) {
      const session = await context.getCdpSession(page);
      await session.send('Emulation.setCPUThrottlingRate', {
        rate: request.params.cpuThrottlingRate,
      });
      results.push(`CPU 节流: ${request.params.cpuThrottlingRate}x（CDP 真实限速）`);
    }

    // User-Agent（通过 CDP）
    if (request.params.userAgent !== undefined) {
      const session = await context.getCdpSession(page);
      await session.send('Network.setUserAgentOverride', {
        userAgent: request.params.userAgent,
      });
      results.push(
        request.params.userAgent === ''
          ? 'User-Agent: 已清除'
          : `User-Agent: ${request.params.userAgent}`,
      );
    }

    if (results.length === 0) {
      response.appendResponseLine('未指定任何模拟参数。');
    } else {
      response.appendResponseLine('模拟设置已应用:');
      for (const r of results) {
        response.appendResponseLine(`  - ${r}`);
      }
    }
  },
});
