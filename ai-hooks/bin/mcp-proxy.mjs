#!/usr/bin/env node
// JSON-lines stdio bridge: compact TokenSave catalogs; start Playwright on demand.
import fs from "node:fs"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import {
  boundTextResult,
  classify,
  contextOutputDir,
  hash,
  reserveTextBudget,
  redactDiagnostic,
  plainTextResult,
  utf8Prefix
} from "./context-state.mjs"
import { mcpPolicy as policy, retryAllowed, retryDelay } from "./mcp-policy.mjs"
import { execFileSync } from "node:child_process"

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
const playwrightCompat = options.includes("--playwright-compat")
const existingTabsOnly = options.includes("--existing-tabs-only")
const backendArgs = args.slice(split + 2)
const extensionTokenRequired =
  playwrightCompat && backendArgs.includes("--extension")
const symbolAliases = new Map([
  ["tokensave_body", ["symbol", "node_id"]],
  ["tokensave_callers", ["symbol", "node_id"]],
  ["tokensave_callees", ["symbol", "node_id"]],
  ["tokensave_impact", ["symbol", "node_id"]],
  ["tokensave_similar", ["symbol"]],
  ["tokensave_type_hierarchy", ["symbol", "node_id"]],
  ["tokensave_node", ["node_id"]],
  ["tokensave_signature", ["node_id"]],
  ["tokensave_derives", ["node_id"]]
])
if ((playwrightCompat || existingTabsOnly) && !catalog)
  throw new Error("--playwright-compat and --existing-tabs-only require --catalog")
if (existingTabsOnly && !playwrightCompat)
  throw new Error("--existing-tabs-only requires --playwright-compat")
if (playwrightCompat) {
  for (const tool of catalog.tools) {
    const schema = tool.inputSchema
    if (tool.name === "browser_tabs") {
      schema.required = (schema.required || []).filter((key) => key !== "action")
      schema.properties.action.default = "list"
      if (existingTabsOnly) {
        schema.properties.action.enum = schema.properties.action.enum.filter((action) => action !== "new")
        schema.properties.action.description = "List or select an attached tab; opening new tabs is disabled."
      }
    } else if (tool.name === "browser_click") {
      schema.properties.ref = { type: "string", description: "Alias for target" }
      schema.required = (schema.required || []).filter((key) => key !== "target")
      schema.anyOf = [{ required: ["target"] }, { required: ["ref"] }]
    } else if (tool.name === "browser_evaluate") {
      schema.properties.expression = { type: "string", description: "JavaScript expression to evaluate" }
      schema.required = (schema.required || []).filter((key) => key !== "function")
      schema.anyOf = [{ required: ["function"] }, { required: ["expression"] }]
    } else if (tool.name === "browser_take_screenshot") {
      schema.required = (schema.required || []).filter((key) => key !== "scale")
    }
  }
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (request, result) =>
  send({ jsonrpc: "2.0", id: request.id, result })
const pending = new Map()
const requestTimers = new Map()
const retryTimers = new Set()
const calls = new Map()
const failures = new Map()
const reads = new Map()

function dropPending(id) {
  if (!pending.has(id)) return false
  pending.delete(id)
  clearTimeout(requestTimers.get(id))
  requestTimers.delete(id)
  calls.delete(id)
  return true
}
const generationFile = process.env.HARNESS_CONTEXT_GENERATION_FILE
const artifactDir = contextOutputDir()
let generation
const artifactTool = {
  name: "harness_read_result",
  description:
    "Read a full_result artifact from this proxy. offset and bytes select a UTF-8 byte range; full=true returns the complete original MCP result without truncation.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      bytes: { type: "integer", minimum: 1 },
      full: { type: "boolean" }
    },
    required: ["path"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
}
function artifactCall(message) {
  if (
    message.method !== "tools/call" ||
    message.params?.name !== artifactTool.name
  )
    return false
  try {
    const input = message.params.arguments || {}
    if (
      typeof input.path !== "string" ||
      path.dirname(input.path) !== artifactDir ||
      !/^[a-f0-9-]{36}\.json$/.test(path.basename(input.path)) ||
      Object.keys(input).some(
        (key) => !["path", "offset", "bytes", "full"].includes(key)
      ) ||
      (input.full !== undefined && typeof input.full !== "boolean") ||
      !Number.isSafeInteger(input.offset ?? 0) ||
      (input.offset ?? 0) < 0 ||
      !Number.isSafeInteger(input.bytes ?? policy.resultBytes) ||
      (input.bytes ?? policy.resultBytes) < 1
    )
      throw new Error("Invalid artifact arguments")
    const fd = fs.openSync(
      input.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    let result
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new Error("Artifact must be a private regular file")
      result = JSON.parse(fs.readFileSync(fd, "utf8"))
    } finally {
      fs.closeSync(fd)
    }
    if (input.full) reply(message, result)
    else {
      const data = Buffer.from(
        result.content.map((block) => block.text).join("")
      )
      const offset = input.offset ?? 0
      if (
        offset > data.length ||
        (offset < data.length && (data[offset] & 0xc0) === 0x80)
      )
        throw new Error(
          "offset must be on a UTF-8 boundary within the artifact"
        )
      const text = utf8Prefix(
        data.subarray(offset).toString("utf8"),
        input.bytes ?? policy.resultBytes
      )
      if (!text && offset < data.length)
        throw new Error("bytes must fit at least one UTF-8 character")
      reply(message, {
        content: [{ type: "text", text }],
        structuredContent: {
          text,
          offset,
          nextOffset: offset + Buffer.byteLength(text),
          totalBytes: data.length
        }
      })
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: redactDiagnostic(error.message) }
    })
  }
  return true
}
function currentGeneration() {
  let next
  try {
    const state = JSON.parse(fs.readFileSync(generationFile, "utf8"))
    next =
      state.v === 1 &&
      typeof state.task === "string" &&
      state.task.length > 0 &&
      Number.isSafeInteger(state.generation) &&
      state.generation >= 0
        ? JSON.stringify(state)
        : null
  } catch {
    next = null
  }
  if (next !== generation) {
    reads.clear()
    generation = next
  }
  return next
}
function readKey(params) {
  const project =
    typeof params.graph_root === "string"
      ? params.graph_root
      : process.cwd()
  let branch
  try {
    branch = execFileSync(
      "git",
      ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"],
      { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
  } catch {
    branch = ""
  }
  const identity = { ...params }
  delete identity.if_digest
  delete identity.force
  return hash(
    JSON.stringify([
      path.resolve(project),
      identity,
      command,
      args.slice(split + 2),
      params.graph_root,
      params.graph_branch,
      branch
    ])
  )
}
function prepareCall(message) {
  if (message.method !== "tools/call") return true
  const params = message.params || {}
  if (playwrightCompat) {
    const input = params.arguments || {}
    if (
      extensionTokenRequired &&
      params.name?.startsWith("browser_") &&
      !process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
    ) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message:
            "Playwright extension token is missing. Put the token from the extension into PLAYWRIGHT_MCP_EXTENSION_TOKEN and start a new session."
        }
      })
      return false
    }
    if (params.name === "browser_tabs" && input.action === undefined)
      input.action = "list"
    if (existingTabsOnly && params.name === "browser_tabs" && input.action === "new") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "New tabs are disabled. Attach the existing page to this Playwright client and select it." } })
      return false
    }
    else if (params.name === "browser_click" && input.target === undefined && input.ref !== undefined)
      input.target = input.ref
    else if (params.name === "browser_evaluate" && input.function === undefined && input.expression !== undefined)
      input.function = `() => (${input.expression})`
    else if (params.name === "browser_take_screenshot" && input.scale === undefined)
      input.scale = "css"
    if (params.name === "browser_click") delete input.ref
    if (params.name === "browser_evaluate") delete input.expression
    params.arguments = input
  }
  const aliases = symbolAliases.get(params.name)
  if (aliases) {
    const input = params.arguments || {}
    if (aliases.includes("symbol") && input.symbol === undefined && input.name !== undefined)
      input.symbol = input.name
    if (aliases.includes("node_id") && input.node_id === undefined && input.id !== undefined)
      input.node_id = input.id
    delete input.name
    delete input.id
    params.arguments = input
  }
  if (params.name === "tokensave_read") {
    const input = params.arguments || {}
    if (typeof input.lines === "string") {
      const range = /^(\d+)\s*(?:[,;]\s*|\s+)(\d+)$/.exec(input.lines.trim())
      if (range) {
        input.lines = `${range[1]}-${range[2]}`
        params.arguments = input
      }
    }
  }
  const safe =
    /^(tokensave_(read|search|files|context|callers|callees|impact|status)|rag_(search|status))$/.test(
      params.name
    )
  const normalize = (value) =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, normalize(value[key])])
          )
        : value
  const roots =
    (params.name?.startsWith("rag_")
      ? params.arguments?.project
      : params.arguments?.graph_root) ||
    process.cwd()
  const indexState = safe
    ? [roots].flat().map((root) => {
        if (typeof root !== "string") return null
        const database = params.name?.startsWith("rag_")
          ? ".ragsave/rag.db"
          : ".tokensave/tokensave.db"
        for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
          try {
            const file = path.join(dir, database)
            const stat = fs.statSync(file)
            let wal
            try {
              const info = fs.statSync(`${file}-wal`)
              wal = [info.ino, info.size, info.mtimeMs]
            } catch {}
            return [file, stat.ino, stat.size, stat.mtimeMs, wal]
          } catch {}
          if (dir === path.dirname(dir)) return null
        }
      })
    : null
  const key = hash(
    JSON.stringify(
      normalize([
        command,
        args.slice(split + 2),
        process.cwd(),
        indexState,
        params
      ])
    )
  )
  const previous = failures.get(key)
  if (
    policy.errorsEnabled &&
    safe &&
    previous?.count >= 2 &&
    (Date.now() < previous.until || previous.probing)
  ) {
    const response = structuredClone(previous.message)
    const note = ` [harness: repeated ${previous.kind} error suppressed temporarily; retry after ${new Date(previous.until).toISOString()}]`
    if (response.error) response.error.message += note
    else
      response.result.content = [
        ...(response.result.content || []),
        { type: "text", text: note }
      ]
    send({ ...response, id: message.id })
    return false
  }
  if (previous?.count >= 2) previous.probing = true
  const heldGeneration = currentGeneration()
  const rangeKey =
    policy.digestsEnabled && heldGeneration && params.name === "tokensave_read"
      ? readKey(params.arguments || {})
      : null
  const held = rangeKey && reads.get(rangeKey)
  const autoDigest = Boolean(
    policy.digestsEnabled &&
    heldGeneration &&
    held &&
    !params.arguments?.force &&
    !Object.hasOwn(params.arguments || {}, "if_digest")
  )
  if (autoDigest) params.arguments = { ...params.arguments, if_digest: held }
  calls.set(message.id, {
    message,
    key,
    safe,
    rangeKey,
    autoDigest,
    generation: heldGeneration,
    retries: 0
  })
  return true
}
let child
let initialization
let starting
let closing = false
let handshakeTimer
let shutdownTimer
const handshakeId = "harness:initialize"

function transform(message, method) {
  if (
    method === "initialize" &&
    message.result?.serverInfo?.name === "tokensave"
  )
    delete message.result.capabilities?.resources
  if (
    message.method === "notifications/tools/list_changed" ||
    method === "tools/list"
  )
    reads.clear()
  if (policy.outputEnabled && method === "tools/call" && message.result) {
    const result = message.result
    let budget = policy.resultBytes
    if (
      currentGeneration() &&
      process.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE &&
      plainTextResult(result)
    ) {
      const requested = Math.min(
        budget,
        result.content.reduce((n, b) => n + Buffer.byteLength(b.text), 0)
      )
      try {
        fs.accessSync(
          process.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE,
          fs.constants.R_OK | fs.constants.W_OK
        )
        budget = Math.min(
          budget,
          reserveTextBudget(
            process.env.HARNESS_CONTEXT_OUTPUT_BUDGET_FILE,
            requested,
            policy.turnBytes
          )
        )
      } catch {
        console.error(
          "mcp-proxy: turn budget unavailable; using per-result limit"
        )
      }
    }
    try {
      message.result = boundTextResult(result, budget, artifactDir, policy)
    } catch {
      console.error(
        "mcp-proxy: artifact unavailable; returning complete backend result"
      )
    }
  }
  // Some clients append initialize.instructions to every tool description. The
  // harness already supplies this routing guidance once through its skills.
  if (
    compact &&
    method === "initialize" &&
    message.result?.instructions?.startsWith(
      "tokensave is a code-graph MCP server."
    )
  ) {
    delete message.result.instructions
  }
  if (
    compact &&
    method === "tools/list" &&
    Array.isArray(message.result?.tools)
  ) {
    for (const tool of message.result.tools) {
      if (typeof tool.description === "string") {
        tool.description = tool.description.split(
          "\n\ntokensave is a code-graph MCP server."
        )[0]
      }
    }
  }
  if (method === "tools/list" && Array.isArray(message.result?.tools))
    message.result.tools.push(artifactTool)
  return message
}

function write(message) {
  const call = calls.get(message.id)
  if (
    message.method === "tools/call" &&
    call?.autoDigest &&
    currentGeneration() !== call.generation
  ) {
    delete message.params.arguments.if_digest
    call.autoDigest = false
    call.generation = currentGeneration()
  }
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    if (catalog && ["EPIPE", "ECONNRESET"].includes(error.code)) restartBackend(error)
    else fail(error)
  }
}

function backendAlive(target = child) {
  if (!target?.pid) return false
  if (process.platform === "win32")
    return target.exitCode === null && target.signalCode === null
  try {
    process.kill(-target.pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}
function terminateBackend(target, signal) {
  try {
    if (process.platform === "win32") {
      if (target.exitCode === null && target.signalCode === null)
        execFileSync("taskkill", ["/pid", String(target.pid), "/t", "/f"], {
          stdio: "ignore"
        })
    } else process.kill(-target.pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH")
      console.error(
        `mcp-proxy: backend shutdown failed: ${redactDiagnostic(error.message)}`
      )
  }
}
function stop() {
  if (closing) return
  closing = true
  clearTimeout(handshakeTimer)
  for (const timer of requestTimers.values()) clearTimeout(timer)
  requestTimers.clear()
  for (const timer of retryTimers) clearTimeout(timer)
  retryTimers.clear()
  pending.clear()
  calls.clear()
  process.stdin.destroy()
  if (child?.pid) {
    if (process.platform === "win32") {
      terminateBackend(child, "SIGKILL")
      return
    }
    child.stdin.end()
    shutdownTimer = setTimeout(() => {
      terminateBackend(child, "SIGTERM")
      if (backendAlive(child))
        shutdownTimer = setTimeout(
          () => terminateBackend(child, "SIGKILL"),
          policy.shutdownGraceMs
        )
    }, policy.shutdownGraceMs)
  }
}

function restartBackend(error) {
  if (closing) return
  console.error(`mcp-proxy: ${redactDiagnostic(error.message)}`)
  const previous = child
  const previousStarting = starting
  child = undefined
  starting = undefined
  clearTimeout(handshakeTimer)
  for (const id of pending.keys()) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message }
    })
  }
  pending.clear()
  for (const timer of requestTimers.values()) clearTimeout(timer)
  requestTimers.clear()
  for (const timer of retryTimers) clearTimeout(timer)
  retryTimers.clear()
  calls.clear()
  previousStarting?.resolve()
  if (previous?.pid) terminateBackend(previous, "SIGKILL")
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
  const launched = spawn(command, args.slice(split + 2), {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "inherit"]
  })
  child = launched
  launched.on("error", (error) => {
    if (child === launched) fail(error)
  })
  launched.stdin.on("error", (error) => {
    if (child !== launched || closing) return
    if (catalog && ["EPIPE", "ECONNRESET"].includes(error.code)) restartBackend(error)
    else fail(error)
  })
  launched.on("exit", (code, signal) => {
    if (child !== launched) return
    clearTimeout(handshakeTimer)
    if (!closing) fail(new Error(`MCP backend exited (${signal || code})`))
    if (!backendAlive(launched)) clearTimeout(shutdownTimer)
    process.exitCode = code || process.exitCode || (signal ? 1 : 0)
    process.stdin.destroy()
  })
  createInterface({ input: launched.stdout }).on("line", (line) => {
    if (child !== launched) return
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
    if (!message.method && !pending.has(message.id)) return
    const call = !message.method && calls.get(message.id)
    if (
      call?.autoDigest &&
      message.result &&
      !message.result.isError &&
      currentGeneration() !== call.generation
    ) {
      delete call.message.params.arguments.if_digest
      call.autoDigest = false
      call.generation = currentGeneration()
      write(call.message)
      return
    }
    try {
      message = transform(message, method)
    } catch (error) {
      fail(error)
      return
    }
    if (call) {
      const failed = message.error || message.result?.isError
      if (failed) {
        const kind =
          message.error?.code === -32602
            ? "argument"
            : classify(
                message.error?.message ||
                  JSON.stringify(message.result?.content)
              )
        if (retryAllowed(kind, call.safe, call.retries, policy)) {
          const delay = retryDelay(call.retries++, policy)
          const timer = setTimeout(() => {
            retryTimers.delete(timer)
            if (!closing && pending.has(call.message.id)) write(call.message)
          }, delay)
          retryTimers.add(timer)
          return
        }
        if (
          policy.errorsEnabled &&
          call.safe &&
          ["permission", "missing", "argument"].includes(kind)
        ) {
          const signature = hash(
            JSON.stringify(message.error || message.result)
          )
          const previous = failures.get(call.key)
          const count =
            previous?.signature === signature ? previous.count + 1 : 1
          failures.set(call.key, {
            count,
            signature,
            kind,
            until: Date.now() + policy.circuitMs,
            message
          })
          if (failures.size > policy.failureEntries)
            failures.delete(failures.keys().next().value)
        } else failures.delete(call.key)
      } else {
        failures.delete(call.key)
        if (
          call.rangeKey &&
          call.generation &&
          currentGeneration() === call.generation
        ) {
          const text =
            message.result?.content
              ?.filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n") || ""
          const digest = text.match(/^digest: ([a-f0-9]{64})$/m)?.[1]
          if (digest && !message.result?._meta?.harnessFullResult)
            reads.set(call.rangeKey, digest)
          if (reads.size > policy.readEntries)
            reads.delete(reads.keys().next().value)
        }
      }
      calls.delete(message.id)
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      pending.delete(message.id)
      clearTimeout(requestTimers.get(message.id))
      requestTimers.delete(message.id)
    }
    send(message)
  })
}

async function ready() {
  if (!catalog) {
    if (!closing && !backendAlive()) launch()
    return
  }
  if (!starting) {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    starting = { promise, resolve }
    launch()
    write({
      ...initialization,
      id: handshakeId,
      params: {
        ...initialization.params,
        protocolVersion: catalog.initialize.protocolVersion
      }
    })
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
  if (artifactCall(message)) return
  if (message.method === "notifications/cancelled") {
    if (!dropPending(message.params?.requestId)) return
    if (catalog ? starting?.ready : backendAlive()) write(message)
    return
  }
  if (catalog && message.method === "initialize") {
    initialization = message
    reply(message, catalog.initialize)
    return
  }
  if (catalog && message.method === "notifications/initialized") return
  if (catalog && message.method === "ping") {
    reply(message, {})
    return
  }
  if (catalog && message.method === "tools/list") {
    reply(message, { tools: [...catalog.tools, artifactTool] })
    return
  }
  if (catalog && !starting && message.method?.startsWith("notifications/")) return
  if (!prepareCall(message)) return
  if (Object.hasOwn(message, "id") && message.method) {
    pending.set(message.id, message.method)
    requestTimers.set(
      message.id,
      setTimeout(() => {
        const error = new Error(
          "MCP backend request timed out; completion unknown"
        )
        if (catalog) restartBackend(error)
        else fail(error)
      }, policy.requestTimeoutMs)
    )
  }
  ready()
    .then(() => {
      if (closing) return
      if (Object.hasOwn(message, "id") && message.method && !pending.has(message.id)) return
      write(message)
    })
    .catch(fail)
})
input.on("close", stop)
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
