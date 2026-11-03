import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { nextOffPeakAt, isPeakAt, deepseekPricing } from "../opencode/cost-policy.mjs"
import { offPeakModelID } from "../opencode/model-routing.mjs"

const offPeakModel = (model) => {
  const [id, variant] = model.split("#")
  const separator = id.indexOf("/")
  if (separator < 0) return model
  const name = `${id.slice(0, separator)}/${offPeakModelID(id.slice(separator + 1))}`
  return variant === undefined ? name : `${name}#${variant}`
}

const args = process.argv.slice(2)
const check = args[0] === "--check"
if (check) args.shift()
if (args.shift() !== "--" || args.length === 0) {
  process.stderr.write("Usage: node bin/opencode-offpeak.mjs [--check] -- <opencode run arguments>\n")
  process.exitCode = 2
} else {
  const models = args.flatMap((arg, index) => arg === "--model" || arg === "-m" ? [args[index + 1] ?? ""] : arg.startsWith("--model=") ? [arg.slice(8)] : [])
  if (models.some(model => !/^deepseek\/[^/\s]+$/.test(model))) {
    process.stderr.write("Off-peak scheduling supports DeepSeek models only.\n")
    process.exitCode = 2
  } else {
    const scheduledAt = nextOffPeakAt()
    if (!models.length) args.unshift("--model", "deepseek/deepseek-flash#high")
    if (!isPeakAt(scheduledAt)) {
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "--model" || args[index] === "-m") args[index + 1] = offPeakModel(args[index + 1])
        else if (args[index].startsWith("--model=")) args[index] = `--model=${offPeakModel(args[index].slice(8))}`
      }
    }
    if (check) {
      const selected = args.flatMap((arg, index) => arg === "--model" || arg === "-m" ? [args[index + 1] ?? ""] : arg.startsWith("--model=") ? [arg.slice(8)] : [])
      process.stdout.write(`${JSON.stringify({ scheduledAt: scheduledAt.toISOString(), pricing: deepseekPricing, scope: "start-time-only", model: selected[0] ?? null })}\n`)
    } else {
      const abort = new AbortController()
      const cancel = () => abort.abort()
      process.once("SIGINT", cancel)
      process.once("SIGTERM", cancel)
      try {
        if (scheduledAt.getTime() > Date.now()) process.stderr.write(`Waiting for DeepSeek off-peak start: ${scheduledAt.toISOString()}\n`)
        while (nextOffPeakAt().getTime() > Date.now()) await setTimeout(Math.min(30000, nextOffPeakAt().getTime() - Date.now()), undefined, { signal: abort.signal })
      } catch (error) {
        if (!abort.signal.aborted) throw error
      } finally {
        process.removeListener("SIGINT", cancel)
        process.removeListener("SIGTERM", cancel)
      }
      if (abort.signal.aborted) process.exitCode = 130
      else {
        const child = spawn("opencode", ["run", ...args], { stdio: "inherit" })
        child.once("error", error => {
          process.stderr.write(`OpenCode batch could not start (${error.code ?? error.name}).\n`)
          process.exitCode = 1
        })
        child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1) })
      }
    }
  }
}
