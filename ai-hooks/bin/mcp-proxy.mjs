#!/usr/bin/env node
// JSON-lines stdio bridge: compact TokenSave catalogs; start Playwright on demand.
import fs from "node:fs"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from 'node:path'
import os from 'node:os'
import { boundTextResult, classify, hash, reserveTextBudget, redactDiagnostic } from './context-state.mjs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const split = args.indexOf("--")
const options = args.slice(0, split)
const command = args[split + 1]
if (split < 0 || !command)
  throw new Error(
    "usage: mcp-proxy.mjs [--compact] [--catalog file] -- command [args]"
  )
const catalogAt = options.indexOf("--catalog")
const catalog =
  catalogAt < 0
    ? null
    : JSON.parse(fs.readFileSync(options[catalogAt + 1], "utf8"))
if (
  catalog &&
  (catalog.command !== command ||
    JSON.stringify(catalog.args) !== JSON.stringify(args.slice(split + 2)))
) {
  throw new Error("MCP command changed; refresh the pinned tool catalog")
}
const compact = options.includes("--compact")
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (request, result) =>
  send({ jsonrpc: "2.0", id: request.id, result })
const pending = new Map()
const calls = new Map()
const failures = new Map()
const reads = new Map()
const generationFile = process.env.HARNESS_CONTEXT_GENERATION_FILE
const artifactDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'harness/context-output')
let generation
function currentGeneration() {
  let next
  try { next = fs.readFileSync(generationFile, 'utf8') } catch { next = null }
  if (next !== generation) { reads.clear(); generation = next }
  return next
}
function readKey(params) {
  let branch
  try { branch = execFileSync('git', ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { branch = '' }
  const file = params.file || params.path
  const canonicalFile = file ? path.resolve(process.cwd(), file) : file
  return hash(JSON.stringify([fs.realpathSync(process.cwd()), canonicalFile, params.mode || 'full', params.lines, params.start, params.end, command, args.slice(split + 2), params.graph_root, params.graph_branch, branch]))
}
function prepareCall(message) {
  if (!generationFile || message.method !== 'tools/call') return true
  const params = message.params || {}
  const safe = /^(tokensave_(read|search|files|context|callers|callees|impact|status)|rag_(search|status))$/.test(params.name)
  const key = hash(JSON.stringify(params))
  if (safe && (failures.get(key)?.count || 0) >= 2) {
    const previous = failures.get(key).message
    send({ ...previous, id: message.id })
    console.error('context: deterministic read circuit open; change arguments/backend before retry')
    return false
  }
  const heldGeneration = currentGeneration()
  const rangeKey = params.name === 'tokensave_read' ? readKey(params.arguments || {}) : null
  const held = rangeKey && reads.get(rangeKey)
  if (heldGeneration && held && !params.arguments.force && !params.arguments.if_digest) params.arguments.if_digest = held
  calls.set(message.id, { message, key, safe, rangeKey, generation: heldGeneration, retries: 0 })
  return true
}
let child
let initialization
let starting
let closing = false
let handshakeTimer
const handshakeId = "harness:initialize"

function transform(message, method) {
  if (message.method === 'notifications/tools/list_changed' || method === 'tools/list') reads.clear()
  if (generationFile && method === 'tools/call' && message.result) {
    const result = message.result
    let budget = 13000
    if (process.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE && !result.isError && !result.structuredContent &&
        Array.isArray(result.content) && result.content.every(b => b.type === 'text' && !/^[\s]*[\[{]/.test(b.text))) {
      const requested = result.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0)
      budget = reserveTextBudget(process.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE, requested)
    }
    message.result = boundTextResult(result, budget, artifactDir)
  }
  // Codex appends initialize.instructions to every tool description. The
  // harness already supplies this routing guidance once through its skills.
  if (compact && method === 'initialize' && message.result?.instructions?.startsWith('tokensave is a code-graph MCP server.')) {
    delete message.result.instructions;
  }
  if (compact && method === 'tools/list' && Array.isArray(message.result?.tools)) {
    for (const tool of message.result.tools) {
      if (typeof tool.description === "string") {
        tool.description = tool.description.split(
          "\n\ntokensave is a code-graph MCP server."
        )[0]
      }
    }
  }
  return message
}

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function stop() {
  if (closing) return
  closing = true
  clearTimeout(handshakeTimer)
  process.stdin.destroy()
  if (child) {
    child.stdin.end()
    const timer = setTimeout(() => child.kill("SIGTERM"), 1000)
    timer.unref()
  }
}

function fail(error) {
  if (closing) return
  console.error(`mcp-proxy: ${redactDiagnostic(error.message)}`)
  for (const id of pending.keys()) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message }
    })
  }
  pending.clear()
  process.exitCode = 1
  stop()
  process.stdin.destroy()
}

function launch() {
  child = spawn(command, args.slice(split + 2), {
    stdio: ["pipe", "pipe", "inherit"]
  })
  child.on("error", fail)
  child.stdin.on("error", fail)
  child.on("exit", (code, signal) => {
    clearTimeout(handshakeTimer)
    if (!closing) fail(new Error(`MCP backend exited (${signal || code})`))
    process.exitCode = code || process.exitCode || (signal ? 1 : 0)
    process.stdin.destroy()
  })
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      fail(new Error("MCP backend emitted invalid JSON"))
      return
    }
    if (
      catalog &&
      !starting.ready &&
      message.id === handshakeId &&
      !message.method
    ) {
      clearTimeout(handshakeTimer)
      if (message.error) {
        fail(new Error(message.error.message))
        return
      }
      if (
        message.result?.protocolVersion !== catalog.initialize.protocolVersion
      ) {
        fail(new Error("MCP protocol changed; refresh the pinned tool catalog"))
        return
      }
      write({ jsonrpc: "2.0", method: "notifications/initialized" })
      starting.ready = true
      starting.resolve()
      return
    }
    const method = !message.method ? pending.get(message.id) : undefined
    try { message = transform(message, method) }
    catch (error) { fail(error); return }
    const call = !message.method && calls.get(message.id)
    if (call) {
      const failed = message.error || message.result?.isError
      if (failed) {
        const kind = classify(message.error?.message || JSON.stringify(message.result?.content))
        if (call.safe && kind === 'transport' && call.retries < 2) {
          call.retries++
          setTimeout(() => { if (!closing) write(call.message) }, 100 * 2 ** call.retries)
          return
        }
        if (call.safe && kind !== 'transport') {
          failures.set(call.key, { count: (failures.get(call.key)?.count || 0) + 1, message })
          if (failures.size > 64) failures.delete(failures.keys().next().value)
        }
      } else {
        failures.delete(call.key)
        if (call.rangeKey && call.generation && currentGeneration() === call.generation) {
          const text = message.result?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || ''
          const digest = text.match(/^digest: ([a-f0-9]{64})$/m)?.[1]
          // Only remember text that is really delivered intact to this generation.
          if (digest && !message.result?._meta?.harnessFullResult && Buffer.byteLength(text) <= 13000) reads.set(call.rangeKey, digest)
          if (reads.size > 512) reads.delete(reads.keys().next().value)
        }
      }
      calls.delete(message.id)
    }
    if (Object.hasOwn(message, "id") && !message.method)
      pending.delete(message.id)
    send(message)
  })
}

async function ready() {
  if (!catalog) return
  if (!starting) {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    starting = { promise, resolve }
    launch()
    write({ ...initialization, id: handshakeId })
    handshakeTimer = setTimeout(
      () => fail(new Error("MCP backend initialization timed out")),
      10000
    )
    handshakeTimer.unref()
  }
  await starting.promise
}

if (!catalog) launch()
const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" }
    })
    return
  }
  if (catalog && message.method === "initialize") {
    initialization = message
    reply(message, catalog.initialize)
    return
  }
  if (catalog && message.method === "notifications/initialized") return
  if (catalog && !starting) {
    if (message.method === "ping") {
      reply(message, {})
      return
    }
    if (message.method === "tools/list") {
      reply(message, { tools: catalog.tools })
      return
    }
    if (message.method?.startsWith("notifications/")) return
  }
  if (!prepareCall(message)) return
  if (Object.hasOwn(message, "id") && message.method)
    pending.set(message.id, message.method)
  ready()
    .then(() => {
      if (!closing) write(message)
    })
    .catch(fail)
})
input.on("close", stop)
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
