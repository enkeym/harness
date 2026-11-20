import { capModelLimits, envPositiveInt } from "../model-tuning.mjs"

export const OPENCODE_GO_PROVIDER_ID = "opencode-go"

export function opencodeGoCaps(env = {}) {
  return {
    cap: envPositiveInt(env.OPENCODE_GO_OUTPUT_CAP, 8192),
    inputCap: envPositiveInt(env.OPENCODE_GO_INPUT_CAP, 120_000)
  }
}

export function tuneOpencodeGoModel(model, caps) {
  return capModelLimits(model, caps)
}
