import { Model, Plugin, Provider, type Credential } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import {
  API_BASE_URL,
  FALLBACK_CONTEXT,
  FALLBACK_MODELS,
  FALLBACK_OUTPUT,
  OAUTH_METHOD_ID,
  authorizationUrl,
  fetchModels,
  pollDeviceToken,
  refreshTokens,
  startDeviceAuth
} from "./oauth.mjs"
import { sanitizeChatStream } from "./sse.mjs"

const PROVIDER_ID = "qwen"
const PROVIDER_NAME = "Qwen"
const STORAGE_CATALOG_KEY = "catalog"
const RESYNC_DELAY_MS = 750

type ModelDetail = {
  id: string
  modalities?: Record<string, boolean>
  contextWindowSize?: number
}

type Catalog = {
  version: 1
  models: string[]
  metadata: ModelDetail[]
}

type State = {
  catalog: Catalog
  connection: ConnectionInfo | undefined
}

function isModelDetail(value: unknown): value is ModelDetail {
  if (!value || typeof value !== "object") return false
  const detail = value as ModelDetail
  return (
    typeof detail.id === "string" &&
    (detail.modalities === undefined ||
      (typeof detail.modalities === "object" && detail.modalities !== null)) &&
    (detail.contextWindowSize === undefined || typeof detail.contextWindowSize === "number")
  )
}

function isCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== "object") return false
  const catalog = value as Partial<Catalog>
  return (
    catalog.version === 1 &&
    Array.isArray(catalog.models) &&
    catalog.models.every((id) => typeof id === "string") &&
    Array.isArray(catalog.metadata) &&
    catalog.metadata.every(isModelDetail)
  )
}

function credentialFromTokens(methodID: string, tokens: { access_token: string; refresh_token?: string; expires_in: number }): Credential.OAuth {
  return {
    type: "oauth",
    methodID: methodID as Credential.OAuth["methodID"],
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? "",
    expires: Date.now() + tokens.expires_in * 1000
  }
}

function providerInfo() {
  return {
    ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
    name: PROVIDER_NAME,
    integrationID: PROVIDER_ID as Provider.Info["integrationID"],
    activation: "auto" as const,
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: API_BASE_URL }
  }
}

function buildModels(catalog: Catalog) {
  const metadata = new Map(catalog.metadata.map((entry) => [entry.id, entry]))
  const ids = catalog.models.length ? catalog.models : FALLBACK_MODELS
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
    const state: State = { catalog: { version: 1, models: [], metadata: [] }, connection: undefined }
    const refreshes = new Map<string, Promise<Credential.OAuth>>()

    try {
      const cached = await ctx.storage.get(STORAGE_CATALOG_KEY)
      if (isCatalog(cached)) state.catalog = cached
    } catch {}

    const rememberCatalog = async (catalog: Catalog) => {
      state.catalog = catalog
      try {
        await ctx.storage.set(STORAGE_CATALOG_KEY, catalog as never)
      } catch {}
    }

    const refresh = (credential: Credential.OAuth): Promise<Credential.OAuth> => {
      const key = credential.refresh
      const pending = refreshes.get(key)
      if (pending) return pending
      const promise = (async () => {
        try {
          const tokens = await refreshTokens(credential.refresh)
          return credentialFromTokens(credential.methodID, tokens)
        } finally {
          refreshes.delete(key)
        }
      })()
      refreshes.set(key, promise)
      return promise
    }

    const sync = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      state.connection = connection
      if (!connection) {
        await ctx.provider.reload()
        return
      }
      const credential = await ctx.integration.connection.resolve(connection)
      const access = credential?.type === "oauth" ? credential.access : credential?.key
      if (!access) {
        await ctx.provider.reload()
        return
      }
      const catalog = await fetchModels(access)
      await rememberCatalog({ version: 1, models: catalog.models, metadata: catalog.metadata })
      await ctx.provider.reload()
    }

    const syncQuietly = async () => {
      try {
        await sync()
      } catch (error) {
        console.warn(`[qwen.oauth] model sync failed: ${error instanceof Error ? error.message : String(error)}`)
        try {
          await ctx.provider.reload()
        } catch {}
      }
    }

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = PROVIDER_NAME
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Qwen (device flow)" },
        authorize: async () => {
          const device = await startDeviceAuth()
          return {
            mode: "auto",
            url: authorizationUrl(device.user_code),
            instructions: `Откройте ссылку и подтвердите код ${device.user_code}. Это окно продолжит автоматически.`,
            expiresAt: Date.now() + device.expires_in * 1000,
            callback: pollDeviceToken(device).then((tokens) => credentialFromTokens(OAUTH_METHOD_ID, tokens))
          }
        },
        refresh,
        label: () => "Qwen subscription"
      })
    })

    await ctx.provider.transform((editor) => {
      const info = providerInfo()
      const models = buildModels(state.catalog)
      const sourceConnection = state.connection
      if (editor.get(PROVIDER_ID)) {
        editor.update(PROVIDER_ID, (provider) => {
          provider.name = info.name
          provider.integrationID = info.integrationID
          provider.activation = info.activation
          provider.package = info.package
          provider.settings = info.settings
        })
        editor.models.set(PROVIDER_ID, models)
        return
      }
      editor.add({ info, models, ...(sourceConnection ? { sourceConnection } : {}) })
    })

    await ctx.session.hook(
      "http.response",
      (event) => {
        const contentType = event.response.headers.get("content-type") ?? ""
        if (!contentType.includes("text/event-stream") || !event.response.body) return
        const headers = new Headers(event.response.headers)
        headers.delete("content-encoding")
        headers.delete("content-length")
        event.response = new Response(sanitizeChatStream(event.response.body), {
          status: event.response.status,
          statusText: event.response.statusText,
          headers
        })
      },
      { providerID: PROVIDER_ID }
    )

    void syncQuietly()

    const controller = new AbortController()
    let resyncTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleResync = () => {
      if (resyncTimer) clearTimeout(resyncTimer)
      resyncTimer = setTimeout(() => {
        resyncTimer = undefined
        void syncQuietly()
      }, RESYNC_DELAY_MS)
      resyncTimer.unref?.()
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "credential.updated" || event.type === "credential.switched" || event.type === "integration.updated") {
            scheduleResync()
          }
        }
      } catch {}
    })()

    return () => {
      controller.abort()
      if (resyncTimer) clearTimeout(resyncTimer)
    }
  }
})
