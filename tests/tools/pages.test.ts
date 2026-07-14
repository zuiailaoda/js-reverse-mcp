/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {normalizeToolError} from '../../src/ToolError.js';
import {
  navigatePage,
  selectPage,
  waitForNavigationOrPause,
} from '../../src/tools/pages.js';

function createDebuggerState() {
  let enabled = true;
  let paused = false;
  return {
    debugger_: {
      isEnabled: () => enabled,
      isPaused: () => paused,
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
  };
}

test('waits for navigation when debugger does not pause', async () => {
  const state = createDebuggerState();

  const result = await waitForNavigationOrPause(
    Promise.resolve(),
    state.debugger_,
    async () => undefined,
  );

  assert.deepEqual(result, {status: 'completed', value: undefined});
});

test('returns paused only after the stopped navigation settles', async () => {
  const state = createDebuggerState();
  const navigation = Promise.withResolvers<void>();
  let stopCalls = 0;
  let settled = false;

  setTimeout(() => {
    state.setPaused(true);
  }, 0);

  const resultPromise = waitForNavigationOrPause(
    navigation.promise,
    state.debugger_,
    async () => {
      stopCalls++;
    },
  );
  void resultPromise.then(() => {
    settled = true;
  });

  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(stopCalls, 1);
  assert.equal(settled, false);
  navigation.reject(new Error('navigation stopped'));
  const result = await resultPromise;

  assert.deepEqual(result, {status: 'paused'});
});

// [LOCAL FORK] Upstream returns paused WITHOUT resuming; this fork auto-clears
// breakpoints and resumes, then re-waits for load (see tools/navigationHealing.ts).
// Test rewritten to assert the fork's auto-heal behavior.
test('navigate_page auto-heals when paused at a breakpoint', async () => {
  let resumeCalls = 0;
  let reloadCalls = 0;
  let waitLoadCalls = 0;
  let includePages = false;
  const lines: string[] = [];
  const navigation = Promise.withResolvers<void>();

  await navigatePage.handler(
    {params: {type: 'reload', timeout: undefined}},
    {
      appendResponseLine: (value: string) => lines.push(value),
      setIncludePages: (value: boolean) => {
        includePages = value;
      },
    } as never,
    {
      getSelectedPage: () => ({
        reload: () => {
          reloadCalls++;
          return navigation.promise;
        },
        url: () => 'https://example.test/',
        waitForLoadState: async () => {
          waitLoadCalls++;
        },
      }),
      debuggerContext: {
        isEnabled: () => true,
        isPaused: () => true,
        clearScripts: () => undefined,
        getXHRBreakpoints: () => [],
        getBreakpoints: () => [],
        resume: () => {
          resumeCalls++;
          return Promise.resolve();
        },
        restoreXHRBreakpoints: async () => undefined,
      },
      stopPageLoading: async () => {
        navigation.reject(new Error('navigation stopped'));
      },
    } as never,
  );

  assert.equal(resumeCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(waitLoadCalls, 1);
  assert.equal(includePages, true);
  assert.match(lines.join('\n'), /Auto-recovery/);
});

test('navigate_page propagates navigation failures into the error envelope', async () => {
  const navigationError = new Error('Navigation timed out after 10ms');
  await assert.rejects(
    navigatePage.handler(
      {params: {type: 'reload', timeout: 10}},
      {appendResponseLine: () => undefined} as never,
      {
        getSelectedPage: () => ({
          reload: async () => {
            throw navigationError;
          },
          url: () => 'https://example.test/',
        }),
        debuggerContext: {
          isEnabled: () => false,
          isPaused: () => false,
        },
      } as never,
    ),
    error => {
      const normalized = normalizeToolError(error);
      return normalized.code === 'TIMEOUT' && normalized.retryable;
    },
  );
});

test('navigate_page gives browser failures a stable CDP error code', async () => {
  await assert.rejects(
    navigatePage.handler(
      {params: {type: 'reload', timeout: 10}},
      {appendResponseLine: () => undefined} as never,
      {
        getSelectedPage: () => ({
          reload: async () => {
            throw new Error('net::ERR_NAME_NOT_RESOLVED');
          },
          url: () => 'https://invalid.test/',
        }),
        debuggerContext: {
          isEnabled: () => false,
          isPaused: () => false,
        },
      } as never,
    ),
    error => {
      const normalized = normalizeToolError(error);
      return normalized.code === 'CDP_ERROR' && normalized.retryable;
    },
  );
});

test('navigate_page rebuilds scripts and rejects a back-navigation no-op', async () => {
  let clearScriptsCalls = 0;
  let reinitCalls = 0;
  const lines: string[] = [];

  await assert.rejects(
    navigatePage.handler(
      {params: {type: 'back', timeout: 10}},
      {appendResponseLine: (line: string) => lines.push(line)} as never,
      {
        getSelectedPage: () => ({
          goBack: async () => null,
          url: () => 'https://example.test/',
        }),
        debuggerContext: {
          isEnabled: () => true,
          isPaused: () => false,
          clearScripts: () => {
            clearScriptsCalls++;
          },
        },
        reinitDebugger: async () => {
          reinitCalls++;
        },
      } as never,
    ),
    error => {
      const normalized = normalizeToolError(error);
      return normalized.code === 'PRECONDITION_FAILED';
    },
  );

  assert.equal(clearScriptsCalls, 1);
  assert.equal(reinitCalls, 1);
  assert.doesNotMatch(lines.join('\n'), /Successfully navigated back/);
});

test('navigate_page accepts a null same-document history response', async () => {
  let url = 'https://example.test/#new';
  let reinitCalls = 0;
  let includePages = false;
  await navigatePage.handler(
    {params: {type: 'back', timeout: 10}},
    {
      appendResponseLine: () => undefined,
      setIncludePages: () => {
        includePages = true;
      },
    } as never,
    {
      getSelectedPage: () => ({
        goBack: async () => {
          url = 'https://example.test/#old';
          return null;
        },
        url: () => url,
      }),
      debuggerContext: {
        isEnabled: () => true,
        isPaused: () => false,
        clearScripts: () => undefined,
        restoreXHRBreakpoints: async () => undefined,
      },
      reinitDebugger: async () => {
        reinitCalls++;
      },
    } as never,
  );
  assert.equal(reinitCalls, 1);
  assert.equal(includePages, true);
});

test('navigate_page rebuilds the script cache after a failed navigation', async () => {
  let reinitCalls = 0;
  await assert.rejects(
    navigatePage.handler(
      {params: {type: 'reload', timeout: 10}},
      {appendResponseLine: () => undefined} as never,
      {
        getSelectedPage: () => ({
          reload: async () => {
            throw new Error('net::ERR_FAILED');
          },
          url: () => 'https://example.test/',
        }),
        debuggerContext: {
          isEnabled: () => true,
          isPaused: () => false,
          clearScripts: () => undefined,
        },
        reinitDebugger: async () => {
          reinitCalls++;
        },
      } as never,
    ),
  );
  assert.equal(reinitCalls, 1);
});

test('select_page waits for debugger reinitialization before returning', async () => {
  const selected = Promise.withResolvers<void>();
  const page = {
    bringToFront: async () => undefined,
    url: () => 'https://example.test/',
  };
  let settled = false;
  const call = selectPage
    .handler(
      {params: {pageIdx: 0}},
      {setIncludePages: () => undefined} as never,
      {
        getPageByIdx: () => page,
        selectPage: () => selected.promise,
      } as never,
    )
    .finally(() => {
      settled = true;
    });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  selected.resolve();
  await call;
  assert.equal(settled, true);
});
