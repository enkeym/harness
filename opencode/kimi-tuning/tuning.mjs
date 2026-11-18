import { clampOutputCap, envPositiveInt, withMaxTokens } from "../model-tuning.mjs"

export const KIMI_PROVIDER_ID = "kimi-for-coding-oauth"

export function kimiCaps(env = {}) {
  const cap = envPositiveInt(env.KIMI_OUTPUT_CAP, 8192)
  const input = envPositiveInt(env.KIMI_INPUT_CAP, 0)
  return { cap, inputCap: input > 0 ? input : undefined }
}

export function tuneKimiModel(model, caps) {
  const output = clampOutputCap(model.limit?.output, caps.cap)
  model.limit = { ...(model.limit ?? {}), output }
  const inputCap = caps.inputCap
  if (inputCap !== undefined) {
    const headroom = model.limit.context ? model.limit.context - output : inputCap
    const declared = model.limit.input
    model.limit = {
      ...model.limit,
      input: Math.min(declared ?? Number.POSITIVE_INFINITY, Math.min(inputCap, headroom))
    }
  }
  model.settings = { ...(model.settings ?? {}), body: withMaxTokens(model.settings?.body, output) }
  model.variants = (model.variants ?? []).map((variant) => ({ ...variant, body: withMaxTokens(variant.body, output) }))
  return model
}
