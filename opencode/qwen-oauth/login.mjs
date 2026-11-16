#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import {
  CLIENT_ID,
  GRANT_TYPE,
  OAUTH_BASE_URL,
  SCOPE,
  API_BASE_URL,
  authorizationUrl,
  credentialsPath,
  fetchModels,
  postForm,
  writeCredentials
} from "./oauth.mjs"

const device = await postForm(`${OAUTH_BASE_URL}/device/code`, { client_id: CLIENT_ID, scope: SCOPE })
if (device.status !== 200 || !device.body.device_code) {
  console.error(`Не удалось начать авторизацию (${device.status}):`, JSON.stringify(device.body))
  process.exit(1)
}

const authorization = device.body
const target = authorizationUrl(authorization.user_code)
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
try {
  spawn(opener, [target], { stdio: "ignore", detached: true }).unref()
} catch {
  console.log("Не удалось открыть браузер автоматически.")
}

console.log(`\nОткройте: ${target}`)
console.log(`Код: ${authorization.user_code}`)
console.log(
  `Код действует ${Math.round(authorization.expires_in / 60)} мин. Не запускайте скрипт повторно — это аннулирует текущий код.\n`
)

const deadline = Date.now() + authorization.expires_in * 1000
let wait = Math.max(authorization.interval ?? 5, 5) * 1000

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, wait))
  const result = await postForm(`${OAUTH_BASE_URL}/token`, {
    grant_type: GRANT_TYPE,
    client_id: CLIENT_ID,
    device_code: authorization.device_code
  })

  if (result.status === 200 && result.body.access_token) {
    const tokens = {
      access_token: result.body.access_token,
      refresh_token: result.body.refresh_token,
      token_type: result.body.token_type ?? "Bearer",
      scope: result.body.scope ?? SCOPE,
      expires_in: result.body.expires_in ?? 3600,
      expiresAt: Date.now() + (result.body.expires_in ?? 3600) * 1000
    }
    const catalog = await fetchModels(tokens.access_token)
    const file = credentialsPath()
    await mkdir(dirname(file), { recursive: true })
    await writeCredentials({
      revision: randomUUID(),
      baseUrl: API_BASE_URL,
      clientId: CLIENT_ID,
      ...(catalog.models.length ? { models: catalog.models } : {}),
      ...(catalog.metadata.length ? { modelMetadata: catalog.metadata } : {}),
      tokens
    })
    console.log(`Готово. Вход сохранён в ${file}`)
    if (catalog.models.length) console.log(`Доступные модели: ${catalog.models.join(", ")}`)
    console.log("Выполните `opencode reload` и выберите модель qwen/<model>.")
    process.exit(0)
  }

  const error = result.body.error ?? ""
  if (error === "slow_down") {
    wait = Math.min(wait + 5000, 15000)
    continue
  }
  if (error && error !== "authorization_pending") {
    console.error(`Авторизация не удалась: ${result.body.error_description ?? error}`)
    process.exit(1)
  }
}

console.error("Время ожидания авторизации истекло")
process.exit(1)
