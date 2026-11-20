export const DEFAULT_OUTPUT_CAP = 8192

export function envPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function clampOutputCap(outputLimit, cap = DEFAULT_OUTPUT_CAP) {
  if (!Number.isFinite(outputLimit) || outputLimit <= 0) return cap
  return Math.min(cap, outputLimit)
}

export function withMaxTokens(body, maxTokens) {
  return { ...(body ?? {}), max_tokens: maxTokens }
}

export function capModelLimits(model, { cap = DEFAULT_OUTPUT_CAP, inputCap } = {}) {
  const output = clampOutputCap(model.limit?.output, cap)
  model.limit = { ...(model.limit ?? {}), output }
  if (inputCap !== undefined) {
    const headroom = model.limit.context ? model.limit.context - output : inputCap
    const declared = model.limit.input
    model.limit = {
      ...model.limit,
      input: Math.min(declared ?? Number.POSITIVE_INFINITY, Math.min(inputCap, headroom))
    }
  }
  return model
}
