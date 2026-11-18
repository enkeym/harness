import { FALLBACK_CONTEXT, FALLBACK_OUTPUT } from "./oauth.mjs"
import { clampOutputCap, withMaxTokens } from "../model-tuning.mjs"

export const LOW_VARIANT_ID = "low"
export const HIGH_VARIANT_ID = "high"
export const REASONING_FIELD = "reasoning_content"

export function modelTuning(detail) {
  const context = detail?.contextWindowSize ?? FALLBACK_CONTEXT
  const outputLimit = detail?.outputWindowSize ?? FALLBACK_OUTPUT
  const cap = clampOutputCap(outputLimit)
  const input = ["text"]
  if (detail?.modalities?.image) input.push("image")
  if (detail?.modalities?.video) input.push("video")
  const thinking = detail?.thinking !== false
  const body = withMaxTokens(thinking ? { enable_thinking: true, reasoning_effort: "low" } : {}, cap)
  const variants = thinking
    ? [
        { id: LOW_VARIANT_ID, body },
        {
          id: HIGH_VARIANT_ID,
          body: withMaxTokens({ enable_thinking: true, reasoning_effort: "high" }, cap)
        }
      ]
    : []
  return {
    input,
    context,
    outputLimit,
    outputCap: cap,
    body,
    variants,
    compatibility: thinking ? { reasoningField: REASONING_FIELD } : undefined
  }
}
