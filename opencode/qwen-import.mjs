import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mergeConfig, readConfig } from "./config.mjs"

export function importQwen(current, directory, check) {
  const qwenHome = process.env.QWEN_HOME || path.join(os.homedir(), ".qwen")
  const file = path.join(qwenHome, "settings.json")
  if (!fs.existsSync(file)) throw new Error(`Qwen settings not found: ${file}`)
  const qwen = readConfig(file)
  const providers = {}
  const keys = []
  for (const model of qwen.modelProviders?.openai ?? []) {
    if (!model.id || !model.baseUrl || !model.envKey)
      throw new Error("Qwen OpenAI model requires id, baseUrl and envKey")
    const url = new URL(model.baseUrl)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Unsupported Qwen provider URL")
    if (!["chat-completions", "responses", undefined].includes(model.wireApi))
      throw new Error(`Unsupported Qwen wireApi: ${model.wireApi}`)
    const existing = Object.entries(current.providers ?? {}).find(
      ([, value]) =>
        value.package === "@ai-sdk/openai" &&
        value.settings?.baseURL === model.baseUrl
    )
    const id =
      existing?.[0] ??
      `qwen-${url.hostname
        .replace(/^api\./, "")
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-z0-9-]/g, "-")}`
    if (providers[id] && providers[id].settings.baseURL !== model.baseUrl)
      throw new Error(`Qwen provider name collision: ${id}`)
    if (
      current.providers?.[id] &&
      current.providers[id].settings?.baseURL !== model.baseUrl
    )
      throw new Error(`Existing provider name collision: ${id}`)
    providers[id] ??= {
      name: id,
      package: "@ai-sdk/openai",
      env: [model.envKey],
      settings: { baseURL: model.baseUrl },
      models: {}
    }
    const provider = providers[id]
    const api = model.wireApi === "responses" ? "responses" : "chat"
    provider.models = {
      ...provider.models,
      [model.id]: {
        name: model.name ?? model.id,
        modelID: model.id,
        settings: { api }
      }
    }
    if (
      !current.providers?.[id]?.settings?.apiKey &&
      !provider.settings.apiKey
    ) {
      const key = process.env[model.envKey]
      if (!key)
        throw new Error(
          `Qwen API key is missing from environment: ${model.envKey}`
        )
      const keyFile = path.join(
        directory,
        "keys",
        `import-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
      )
      if (fs.existsSync(keyFile))
        throw new Error(`Refusing to overwrite existing key file: ${keyFile}`)
      provider.settings.apiKey = `{file:${keyFile}}`
      keys.push([keyFile, key])
    }
  }
  if (!Object.keys(providers).length)
    throw new Error("No Qwen OpenAI providers configured")
  const desired = mergeConfig({ providers }, current)
  const selected = qwen.model?.name
  if (!desired.model && selected) {
    const entry = Object.entries(desired.providers).find(([, value]) =>
      Object.hasOwn(value.models ?? {}, selected)
    )
    if (entry) desired.model = `${entry[0]}/${selected}`
  }
  if (!check) {
    for (const [keyFile, key] of keys) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 })
      fs.writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" })
    }
  }
  return desired
}
