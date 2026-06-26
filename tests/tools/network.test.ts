/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {zod} from '../../src/third_party/index.js';
import {listNetworkRequests} from '../../src/tools/network.js';

test('outputPart defaults to "all" when omitted', () => {
  // Regression: ".default('all').optional()" let undefined short-circuit the
  // default, so omitting outputPart produced undefined and crashed the export.
  const schema = zod.object(listNetworkRequests.schema);
  const parsed = schema.parse({reqid: 1, outputFile: '/tmp/x.json'});

  assert.equal(parsed.outputPart, 'all');
});

test('includePreservedRequests defaults to false when omitted', () => {
  const schema = zod.object(listNetworkRequests.schema);
  const parsed = schema.parse({});

  assert.equal(parsed.includePreservedRequests, false);
});
