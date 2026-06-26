/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {CdpSessionProvider} from '../src/CdpSessionProvider.js';
import {NetworkCollector} from '../src/PageCollector.js';
import type {
  BrowserContext,
  HTTPRequest,
  Page,
} from '../src/third_party/index.js';

function createFakePage(): {page: Page; mainFrame: object} {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const mainFrame = {id: 'main'};
  const page = {
    on(event: string, cb: (arg: unknown) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return page;
    },
    off() {
      return page;
    },
    mainFrame: () => mainFrame,
    emit(event: string, arg: unknown) {
      for (const cb of listeners.get(event) ?? []) {
        cb(arg);
      }
    },
  };
  return {page: page as unknown as Page, mainFrame};
}

function createFakeRequest(url: string, frame: object): HTTPRequest {
  return {
    url: () => url,
    method: () => 'POST',
    isNavigationRequest: () => false,
    frame: () => frame,
  } as unknown as HTTPRequest;
}

function createCollector(): NetworkCollector {
  return new NetworkCollector(
    {} as unknown as BrowserContext,
    {} as unknown as CdpSessionProvider,
  );
}

test('preserved requests survive more than the old navigation window', () => {
  const collector = createCollector();
  const {page, mainFrame} = createFakePage();
  collector.addPage(page);

  // A request that belongs to the current navigation (e.g. the POST that
  // triggers a redirect). Its frame is not the main frame, so it is never
  // treated as a navigation request.
  const subframe = {id: 'sub'};
  const bundle = createFakeRequest('https://x/assets/js/bundle', subframe);
  (page as unknown as {emit(e: string, a: unknown): void}).emit(
    'request',
    bundle,
  );

  // Five subsequent main-frame navigations with no captured navigation request
  // — each pushes an empty bucket, which under the old fixed 4-bucket read
  // window would evict the bundle request entirely.
  for (let i = 0; i < 5; i++) {
    (page as unknown as {emit(e: string, a: unknown): void}).emit(
      'framenavigated',
      mainFrame,
    );
  }

  const preserved = collector.getData(page, true);
  assert.ok(
    preserved.includes(bundle),
    'preserved view should still reach the bundle request after 5 navigations',
  );

  const currentOnly = collector.getData(page, false);
  assert.ok(
    !currentOnly.includes(bundle),
    'default view should only show the current navigation',
  );
});
