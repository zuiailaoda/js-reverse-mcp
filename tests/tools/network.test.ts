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

test('includePreservedRequests defaults to true when omitted', () => {
  // Default true so cross-navigation requests (e.g. the POST that triggered a
  // redirect) are visible without the AI needing to know the flag.
  const schema = zod.object(listNetworkRequests.schema);
  const parsed = schema.parse({});

  assert.equal(parsed.includePreservedRequests, true);
});

test('methods accepts valid HTTP verbs and rejects unknown ones', () => {
  const schema = zod.object(listNetworkRequests.schema);

  const parsed = schema.parse({methods: ['GET', 'POST']});
  assert.deepEqual(parsed.methods, ['GET', 'POST']);

  assert.throws(() => schema.parse({methods: ['FETCH']}));
});

test('methods is unset when omitted (no filtering)', () => {
  const schema = zod.object(listNetworkRequests.schema);
  const parsed = schema.parse({});

  assert.equal(parsed.methods, undefined);
});
