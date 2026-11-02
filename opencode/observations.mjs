import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const validNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const counterKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]

function counters(value) {
  const result = { input: value?.input, output: value?.output, reasoning: value?.reasoning, cacheRead: value?.cache?.read, cacheWrite: value?.cache?.write }
  if (!Object.values(result).every(validNumber)) throw new Error("Unsupported OpenCode tokens schema")
  return result
}

function toolSummary(tool) {
  const input = tool.state?.input
  const content = tool.state?.content
  const code = input?.code
  const mentions = typeof code === "string" ? [...new Set(code.match(/(?:tokensave|rag)_[a-z_]+/g) ?? [])] : []
  return {
    id: tool.id, name: tool.name, status: tool.state?.status ?? null,
    time: tool.time ?? null,
    durationMs: validNumber(tool.time?.completed) && validNumber(tool.time?.created) ? tool.time.completed - tool.time.created : null,
    inputFingerprint: input ? hash(JSON.stringify(input)) : null,
    outputBytes: Array.isArray(content) ? Buffer.byteLength(JSON.stringify(content)) : null,
    retrieval: {
      mentionedTools: mentions, mentionsAreExecutionProof: false,
      mode: ["lines", "full", "map", "signatures"].includes(input?.mode) ? input.mode : null,
      range: typeof input?.lines === "string" && /^\d+(-\d+)?$/.test(input.lines) ? input.lines : null,
      limit: validNumber(input?.limit) ? input.limit : null,
      pathFingerprint: typeof (input?.file ?? input?.path) === "string" ? hash(input.file ?? input.path) : null
    }
  }
}

export function summarizeSession({ info, messages, previousSequence = [], messageCoverage = "complete-pages" }, version) {
  if (version !== "2.2.5") throw new Error(`Unsupported OpenCode observation version: ${version}`)
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(info?.id) || !info.location?.directory || !Array.isArray(messages)) throw new Error("Unsupported OpenCode session schema")
  const ids = new Set()
  const gaps = new Set(["price-not-validated", "task-acceptance-unknown", "workload-not-classified", "parent-inclusive-accounting-unverified", "auxiliary-request-breakdown-unavailable", "retrieval-scope-needs-review"])
  const native = { cost: validNumber(info.cost) ? info.cost : null, tokens: counters(info.tokens) }
  const messageSum = { cost: 0, tokens: Object.fromEntries(counterKeys.map((key) => [key, 0])) }
  let usageComplete = true
  let costComplete = true
  const current = messages.map((message) => {
    if (!message.id || ids.has(message.id)) throw new Error("Duplicate or missing OpenCode message ID")
    ids.add(message.id)
    const step = { id: message.id, type: message.type, time: message.time ?? null, model: message.model ?? null, agent: message.agent ?? null }
    if (message.type !== "assistant") return step
    const usage = message.tokens === undefined ? null : counters(message.tokens)
    const cost = validNumber(message.cost) ? message.cost : null
    return { ...step, tokens: usage, nativeReportedUSD: cost, finish: message.finish ?? null, retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : null, failed: Boolean(message.error), tools: (message.content ?? []).filter((part) => part.type === "tool").map(toolSummary) }
  })
  const sequence = [...new Map([...previousSequence, ...current].map((step) => [step.id, step])).values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  for (const step of sequence.filter((step) => step.type === "assistant")) {
    if (step.tokens === null) usageComplete = false
    else for (const key of counterKeys) messageSum.tokens[key] += step.tokens[key]
    if (step.nativeReportedUSD === null) costComplete = false
    else messageSum.cost += step.nativeReportedUSD
  }
  if (messageCoverage !== "complete-pages") gaps.add("context-snapshots-need-full-history-check")
  if (!usageComplete) {
    gaps.add("message-usage-missing")
    messageSum.tokens = null
  }
  if (!costComplete) {
    gaps.add("message-cost-missing")
    messageSum.cost = null
  }
  const delta = {
    cost: native.cost !== null && messageSum.cost !== null ? native.cost - messageSum.cost : null,
    tokens: messageSum.tokens ? Object.fromEntries(counterKeys.map((key) => [key, native.tokens[key] - messageSum.tokens[key]])) : null
  }
  if (delta.tokens && Object.values(delta.tokens).some((value) => value !== 0)) gaps.add("session-message-usage-mismatch")
  if (delta.cost !== null && Math.abs(delta.cost) > 1e-10) gaps.add("session-message-cost-mismatch")
  if (native.cost === 0 && Object.values(native.tokens).some((value) => value > 0)) gaps.add("zero-cost-with-usage")
  return {
    schemaVersion: 1, client: "opencode", clientVersion: version, source: "native-session-api", messageCoverage,
    observedAt: new Date().toISOString(), sessionID: info.id, parentID: info.parentID ?? null, fork: info.fork ?? null,
    project: info.location.directory, time: info.time, nativeOutcome: info.outcome ?? null,
    money: { currency: "USD", nativeReportedUSD: native.cost, validatedUSD: null, priceSource: null },
    accounting: { native, messageSum, delta, familyTotal: null, tokenFieldsAreSeparate: true },
    sequence,
    delegation: { childIDs: [], childrenComplete: false },
    assessment: { accepted: null, workload: null, checks: [], corrections: [] },
    gaps: [...gaps], readyForOptimization: false
  }
}

export function observationDirectory(directory, stateDirectory = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state")) {
  return path.join(stateDirectory, "harness/optimize/opencode", hash(directory).slice(0, 16))
}

async function pages(read) {
  const data = []
  const seen = new Set()
  let cursor
  do {
    const page = await read(cursor)
    if (!Array.isArray(page?.data) || !page.cursor || typeof page.cursor !== "object") throw new Error("Unsupported OpenCode pagination schema")
    data.push(...page.data)
    cursor = page.cursor.next
    if (cursor && seen.has(cursor)) throw new Error("Cyclic OpenCode pagination")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return data
}

async function save(record, stateDirectory) {
  const base = observationDirectory(record.project, stateDirectory)
  const directory = path.join(base, "sessions")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(base, 0o700)
  await fs.chmod(directory, 0o700)
  const file = path.join(directory, `${record.sessionID}.json`)
  try {
    const previous = JSON.parse(await fs.readFile(file, "utf8"))
    record.assessment = previous.assessment ?? record.assessment
    record.handoff = record.handoff ?? previous.handoff ?? null
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return file
}

export async function collectObservations(api, sessionID, { stateDirectory, directory } = {}) {
  const visited = new Set()
  const files = []
  const collect = async (id) => {
    if (visited.has(id)) throw new Error("Cyclic OpenCode session family")
    visited.add(id)
    const info = await api.get(id)
    if (visited.size === 1 && directory && path.resolve(info.location.directory) !== path.resolve(directory)) return
    const messages = await pages((cursor) => api.messages(id, cursor))
    let previousSequence = []
    if (api.messageCoverage === "active-context") {
      const file = path.join(observationDirectory(info.location.directory, stateDirectory), "sessions", `${info.id}.json`)
      try {
        previousSequence = JSON.parse(await fs.readFile(file, "utf8")).sequence
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
    const record = summarizeSession({ info, messages, previousSequence, messageCoverage: api.messageCoverage }, api.version)
    record.handoff = api.handoff ? await api.handoff(id) : null
    try {
      const models = await api.prices(info.location.directory)
      const used = new Set(record.sequence.filter((step) => step.model).map((step) => `${step.model.providerID}/${step.model.id}`))
      record.priceSnapshot = { capturedAt: record.observedAt, source: "opencode-model-registry", validatedForBilling: false, models: models.filter((model) => used.has(`${model.providerID}/${model.id}`)).map((model) => ({ providerID: model.providerID, id: model.id, cost: model.cost })) }
    } catch {
      record.priceSnapshot = null
      record.gaps.push("model-price-snapshot-unavailable")
    }
    let children = []
    try {
      children = await pages((cursor) => api.children(id, cursor))
      if (children.some((child) => child.parentID !== id)) throw new Error("Invalid child filter")
      record.delegation.childIDs = [...new Set(children.map((child) => child.id))]
      record.delegation.childrenComplete = true
    } catch {
      children = []
      record.gaps.push("children-unavailable")
    }
    for (const child of children) {
      try {
        await collect(child.id)
      } catch {
        record.delegation.childrenComplete = false
        record.gaps.push("child-observation-unavailable")
      }
    }
    files.push(await save(record, stateDirectory))
  }
  await collect(sessionID)
  return files
}

export function observationAPI(context) {
  return {
    version: context.app.version,
    messageCoverage: "active-context",
    prices: () => context.model.list(),
    handoff: async (sessionID) => {
      const target = await context.storage.get(`handoff:${sessionID}`)
      return target?.id ? { targetID: target.id, submitted: Boolean(target.submitted) } : null
    },
    get: (sessionID) => context.session.get({ sessionID }),
    messages: async (sessionID) => ({ data: await context.session.context({ sessionID }), cursor: {} }),
    children: (parentID, cursor) => context.session.list({ parentID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) })
  }
}
