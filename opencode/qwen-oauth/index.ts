import { Model, Plugin, Provider } from "@opencode/plugin"
import {
  API_BASE_URL,
  CLIENT_ID,
  FALLBACK_CONTEXT,
  FALLBACK_MODELS,
  FALLBACK_OUTPUT,
  loadCredentials
} from "./oauth.mjs"

const PROVIDER_ID = "qwen"

function buildModels(credentials) {
  const metadata = new Map((credentials?.modelMetadata ?? []).map((entry) => [entry.id, entry]))
  const ids = credentials?.models?.length ? credentials.models : FALLBACK_MODELS
  return ids.map((id) => {
    const extra = metadata.get(id)
    const model = Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(id))
    const input = ["text"]
    if (extra?.modalities?.image) input.push("image")
    if (extra?.modalities?.video) input.push("video")
    model.name = id
    model.capabilities = { tools: true, input, output: ["text"] }
    model.limit = { context: extra?.contextWindowSize ?? FALLBACK_CONTEXT, output: FALLBACK_OUTPUT }
    model.cost = []
    model.time = { released: Date.now() }
    return model
  })
}

export default Plugin.define({
  id: "qwen.oauth",
  async setup(ctx) {
    let credentials = await loadCredentials()

    const register = async () => {
      const current = credentials
      const models = buildModels(current)
      await ctx.provider.transform((editor) => {
        const info = {
          ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
          name: "Qwen",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: API_BASE_URL,
            ...(current?.tokens ? { apiKey: current.tokens.access_token } : {})
          }
        }
        if (editor.get(PROVIDER_ID)) {
          editor.update(PROVIDER_ID, (provider) => {
            provider.activation = info.activation
            provider.package = info.package
            provider.settings = info.settings
          })
          editor.models.set(PROVIDER_ID, models)
          return
        }
        editor.add({ info, models })
      })
    }

    await register()

    const timer = setInterval(async () => {
      const next = await loadCredentials()
      if (!next) return
      const changed =
        next.tokens?.access_token !== credentials?.tokens?.access_token ||
        (next.models?.length ?? 0) !== (credentials?.models?.length ?? 0)
      if (!changed) return
      credentials = next
      await register()
      await ctx.provider.reload()
    }, 60_000)

    return () => clearInterval(timer)
  }
})
