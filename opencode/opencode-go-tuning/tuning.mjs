import { capModelLimits, envPositiveInt } from "../model-tuning.mjs"
import { contextPolicy } from "../../ai-hooks/bin/context-policy.mjs"

export const OPENCODE_GO_PROVIDER_ID = "opencode-go"

export function opencodeGoCaps(env = {}) {
  return {
    cap: envPositiveInt(env.OPENCODE_GO_OUTPUT_CAP, contextPolicy.maxOutputTokens),
    inputCap: envPositiveInt(env.OPENCODE_GO_INPUT_CAP, contextPolicy.opencode.maxTokens)
  }
}

export function tuneOpencodeGoModel(model, caps) {
  return capModelLimits(model, caps)
}
