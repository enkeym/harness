import { capModelLimits, envPositiveInt, withMaxTokens } from "../model-tuning.mjs"

export const KIMI_PROVIDER_ID = "kimi-for-coding-oauth"

export function kimiCaps(env = {}) {
  const cap = envPositiveInt(env.KIMI_OUTPUT_CAP, 8192)
  const input = envPositiveInt(env.KIMI_INPUT_CAP, 0)
  return { cap, inputCap: input > 0 ? input : undefined }
}

export function tuneKimiModel(model, caps) {
  capModelLimits(model, caps)
  const output = model.limit.output
  model.settings = { ...(model.settings ?? {}), body: withMaxTokens(model.settings?.body, output) }
  model.variants = (model.variants ?? []).map((variant) => ({ ...variant, body: withMaxTokens(variant.body, output) }))
  return model
}
