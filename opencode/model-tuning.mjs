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
