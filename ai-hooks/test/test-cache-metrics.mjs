import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheMetrics } from '../bin/cache-metrics.mjs';

test('cache metrics report the observed rate and incomplete coverage separately', () => {
  const data = cacheMetrics([
    { inputTokens: 100, cacheReadTokens: 80 },
    { inputTokens: 50, cacheReadTokens: 0 },
    null
  ]);

  assert.equal(data.cacheMissTokens, 70);
  assert.equal(data.knownSteps, 2);
  assert.equal(data.unknownSteps, 1);
  assert.equal(data.complete, false);
  assert.equal(data.coverage, 2 / 3);
  assert.equal(data.hitRate, 80 / 150);
});

test('cache metrics reject an impossible cached-token counter from the rate', () => {
  const data = cacheMetrics([{ inputTokens: 10, cacheReadTokens: 11 }]);

  assert.equal(data.hitRate, null);
  assert.equal(data.complete, false);
  assert.equal(data.unknownSteps, 1);
});
