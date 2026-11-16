import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const OAUTH_BASE_URL = "https://auth.qwen.ai/api/oauth"
export const API_BASE_URL = "https://api.qwen.ai/compatible-mode/v1"
export const WEB_ORIGIN = "https://chat.qwen.ai"
export const CLIENT_ID = "qwen-code-cli"
export const SCOPE = "model:invoke profile:read"
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
export const REFRESH_WINDOW_MS = 5 * 60 * 1000

export const FALLBACK_MODELS = ["qwen3.8-max"]
export const FALLBACK_CONTEXT = 1_000_000
export const FALLBACK_OUTPUT = 32_768

export const credentialsPath = () =>
  process.env.QWEN_OAUTH_CREDENTIALS || join(homedir(), ".qwen", "subscription_credentials.json")

export async function postForm(url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

export function authorizationUrl(userCode) {
  const url = new URL("/authorize", WEB_ORIGIN)
  url.searchParams.set("user_code", userCode)
  url.searchParams.set("client", "cli")
  url.searchParams.set("entry", "qwen_code")
  url.searchParams.set("paywallScene", "cli")
  return url.toString()
}

export async function readCredentials() {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8"))
  } catch {
    return undefined
  }
}

export async function writeCredentials(credentials) {
  const target = credentialsPath()
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 })
  await rename(temporary, target)
}

export async function fetchModels(accessToken) {
  try {
    const response = await fetch(`${API_BASE_URL}/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return { models: [], metadata: [] }
    const body = await response.json()
    const data = Array.isArray(body?.data) ? body.data : []
    const models = []
    const metadata = []
    for (const entry of data) {
      const id = typeof entry?.id === "string" ? entry.id : undefined
      if (!id || models.includes(id)) continue
      models.push(id)
      const detail = { id }
      if (Array.isArray(entry.input_modalities)) {
        detail.modalities = {}
        for (const modality of entry.input_modalities) {
          if (modality !== "text") detail.modalities[modality] = true
        }
      }
      if (typeof entry.context_window_tokens === "number") detail.contextWindowSize = entry.context_window_tokens
      if (detail.modalities || detail.contextWindowSize) metadata.push(detail)
    }
    return { models, metadata }
  } catch {
    return { models: [], metadata: [] }
  }
}

export async function refreshCredentials(credentials) {
  const refresh = credentials?.tokens?.refresh_token
  if (!refresh) return undefined
  try {
    const { status, body } = await postForm(`${OAUTH_BASE_URL}/token`, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    })
    if (status !== 200 || !body.access_token) return undefined
    const next = {
      ...credentials,
      tokens: {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? refresh,
        token_type: body.token_type ?? "Bearer",
        scope: body.scope ?? credentials.tokens?.scope ?? "",
        expires_in: body.expires_in ?? 3600,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      },
    }
    await writeCredentials(next)
    return next
  } catch {
    return undefined
  }
}

export async function loadCredentials() {
  let credentials = await readCredentials()
  if (!credentials?.tokens?.access_token) return undefined
  if (credentials.tokens.expiresAt - Date.now() < REFRESH_WINDOW_MS) {
    credentials = (await refreshCredentials(credentials)) ?? credentials
  }
  return credentials
}
