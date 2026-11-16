#!/usr/bin/env node
import { spawn } from "node:child_process"

const command = process.argv[2] ?? "login"
const provider = "qwen"

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn("opencode", args, { stdio: "inherit" })
    child.on("error", (error) => {
      console.error(`Не удалось запустить opencode: ${error.message}`)
      resolve(1)
    })
    child.on("exit", (code) => resolve(code ?? 1))
  })

if (command === "login") {
  process.exit(await run(["auth", "login", provider]))
} else if (command === "status") {
  process.exit(await run(["auth", "list"]))
} else if (command === "logout") {
  process.exit(await run(["auth", "logout", provider]))
} else {
  console.error("Использование: qwen-auth [login|status|logout]")
  process.exit(2)
}
