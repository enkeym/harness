const OAUTH_BASE_URL = "https://auth.qwen.ai/api/oauth"
const OAUTH_DEVICE_URL = `${OAUTH_BASE_URL}/device/code`
const OAUTH_TOKEN_URL = `${OAUTH_BASE_URL}/token`
export const API_BASE_URL = "https://api.qwen.ai/compatible-mode/v1"
const WEB_ORIGIN = "https://chat.qwen.ai"
const CLIENT_ID = "qwen-code-cli"
const SCOPE = "model:invoke profile:read"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_EXPIRES_IN_SEC = 900
const POLL_INTERVAL_SEC = 5

export const OAUTH_METHOD_ID = "oauth"

export const FALLBACK_MODELS = ["qwen3.8-max"]
export const FALLBACK_CONTEXT = 1_000_000
export const FALLBACK_OUTPUT = 32_768

function oauthError(status, body, fallback) {
  const code = typeof body?.error === "string" ? body.error : undefined
  const description = typeof body?.error_description === "string" ? body.error_description : undefined
  const error = new Error(`qwen oauth ${code ?? status}: ${description ?? fallback}`)
  error.status = status
  if (code) error.code = code
  return error
}

async function postForm(url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

export async function startDeviceAuth() {
  const { status, body } = await postForm(OAUTH_DEVICE_URL, { client_id: CLIENT_ID, scope: SCOPE })
  if (status !== 200 || !body?.device_code || !body?.user_code) {
    throw oauthError(status, body, "не удалось начать авторизацию")
  }
  return body
}

function positiveSeconds(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function tokensFromResponse(body, scope) {
  const expiresIn = positiveSeconds(body?.expires_in, DEFAULT_EXPIRES_IN_SEC)
  return {
    access_token: body.access_token,
    refresh_token: typeof body?.refresh_token === "string" ? body.refresh_token : undefined,
    token_type: typeof body?.token_type === "string" ? body.token_type : "Bearer",
    scope: typeof body?.scope === "string" ? body.scope : scope,
    expires_in: expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

export async function pollDeviceToken(device) {
  let interval = Math.max(positiveSeconds(device.interval, POLL_INTERVAL_SEC), POLL_INTERVAL_SEC) * 1000
  const deadline = Date.now() + positiveSeconds(device.expires_in, DEFAULT_EXPIRES_IN_SEC) * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    const { status, body } = await postForm(OAUTH_TOKEN_URL, {
      grant_type: DEVICE_GRANT,
      client_id: CLIENT_ID,
      device_code: device.device_code,
    })
    if (status === 200 && body?.access_token) return tokensFromResponse(body, SCOPE)
    const code = typeof body?.error === "string" ? body.error : ""
    if (!code || code === "authorization_pending") continue
    if (code === "slow_down") {
      interval = Math.min(interval + 5000, 15000)
      continue
    }
    throw oauthError(status, body, "авторизация не удалась")
  }
  throw oauthError(0, {}, "время ожидания авторизации истекло")
}

export async function refreshTokens(refreshToken) {
  if (!refreshToken) throw oauthError(0, {}, "нет refresh-токена")
  const { status, body } = await postForm(OAUTH_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })
  if (status !== 200 || !body?.access_token) throw oauthError(status, body, "не удалось обновить токен")
  return tokensFromResponse(body, "")
}

export async function fetchModels(accessToken) {
  const response = await fetch(`${API_BASE_URL}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw oauthError(response.status, {}, "не удалось получить список моделей")
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
    if (
      typeof entry.output_window_tokens === "number" &&
      Number.isFinite(entry.output_window_tokens) &&
      entry.output_window_tokens > 0
    ) {
      detail.outputWindowSize = entry.output_window_tokens
    }
    if (Array.isArray(entry.supported_parameters)) {
      detail.thinking = entry.supported_parameters.includes("enable_thinking")
    }
    if (
      detail.modalities ||
      detail.contextWindowSize ||
      detail.outputWindowSize !== undefined ||
      detail.thinking !== undefined
    ) {
      metadata.push(detail)
    }
  }
  return { models, metadata }
}
