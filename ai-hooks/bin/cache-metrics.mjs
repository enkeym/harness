const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function cacheMetrics(samples) {
  if (!Array.isArray(samples)) throw new Error('Cache samples must be an array')
  const result = { inputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, knownSteps: 0, unknownSteps: 0, totalSteps: samples.length, coverage: null, complete: false, hitRate: null }
  for (const sample of samples) {
    const input = sample?.inputTokens
    const cacheRead = sample?.cacheReadTokens
    if (!numeric(input) || !numeric(cacheRead) || cacheRead > input) {
      result.unknownSteps++
      continue
    }
    result.inputTokens += input
    result.cacheReadTokens += cacheRead
    result.knownSteps++
  }
  result.cacheMissTokens = result.inputTokens - result.cacheReadTokens
  result.coverage = result.totalSteps ? result.knownSteps / result.totalSteps : null
  result.complete = result.unknownSteps === 0
  result.hitRate = result.inputTokens ? result.cacheReadTokens / result.inputTokens : null
  return result
}
