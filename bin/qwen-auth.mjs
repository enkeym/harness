#!/usr/bin/env node
import { spawn } from "node:child_process"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { credentialsPath, fetchModels, loadCredentials, readCredentials } from "../opencode/qwen-oauth/oauth.mjs"

const command = process.argv[2] ?? "login"

async function login() {
  const script = fileURLToPath(new URL("../opencode/qwen-oauth/login.mjs", import.meta.url))
  const child = spawn(process.execPath, [script], { stdio: "inherit" })
  const code = await new Promise((resolve) => child.on("exit", resolve))
  process.exit(code ?? 1)
}

async function status() {
  const stored = await readCredentials()
  if (!stored?.tokens?.access_token) {
    console.log("Вход не выполнен. Запустите: qwen-auth login")
    process.exit(1)
  }
  const credentials = await loadCredentials()
  const models = credentials?.models ?? (await fetchModels(credentials?.tokens?.access_token)).models
  const expiresAt = credentials?.tokens?.expiresAt
  console.log(`Аккаунт: ${credentials?.clientId ?? "qwen-code-cli"}`)
  console.log(`Файл: ${credentialsPath()}`)
  if (expiresAt) console.log(`Токен действителен до: ${new Date(expiresAt).toLocaleString()}`)
  console.log(`Модели: ${models.length ? models.join(", ") : "неизвестно"}`)
  console.log(`Модель OpenCode: qwen/${models[0] ?? "qwen3.8-max"}`)
}

async function logout() {
  await rm(credentialsPath(), { force: true })
  console.log("Вход удалён. Запустите `opencode reload`, чтобы убрать провайдер qwen.")
}

if (command === "login") await login()
else if (command === "status") await status()
else if (command === "logout") await logout()
else {
  console.error("Использование: qwen-auth [login|status|logout]")
  process.exit(2)
}
