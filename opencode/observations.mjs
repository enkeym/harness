import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { deepseekPricing, deepseekPricingWindowAt } from "./cost-policy.mjs"
import { readJSON, writePrivateJSON } from "./local-state.mjs"
import { taskContextKey } from "./task-context.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const validNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const counterKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]

export function supportedObservationVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof version === "string" ? version : "")
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major === 2 && minor === 2 && patch >= 5
}

export function requestTypeOf(step) {
  if (step.type === "compaction") return "compaction"
  if (step.usageKind === "auxiliary") return "auxiliary"
  return typeof step.type === "string" ? step.type : null
}

export function describeRequest(step, { sessionId = null, taskId = null } = {}) {
  const tokens = step.tokens ?? null
  const modelId = step.model?.id ?? null
  const pricing = tokens && modelId
    ? deepseekPricingWindowAt(modelId, tokens, step.nativeReportedUSD, step.time?.created)
    : null
  return {
    timestamp: validNumber(step.time?.created) ? new Date(step.time.created).toISOString() : null,
    sessionId,
    requestId: step.requestId ?? null,
    taskId,
    model: modelId ? `${step.model.providerID ?? "unknown"}/${modelId}` : null,
    reasoningVariant: step.model?.variant ?? null,
    inputTokens: tokens?.input ?? null,
    cacheReadTokens: tokens?.cacheRead ?? null,
    cacheMissTokens: tokens?.input ?? null,
    outputTokens: tokens?.output ?? null,
    reasoningTokens: tokens?.reasoning ?? null,
    costUSD: step.nativeReportedUSD ?? null,
    pricingWindow: pricing?.window ?? null,
    pricingWindowSource: pricing?.source ?? null,
    pricingWindowClockAgrees: pricing?.agreesWithClock ?? null,
    requestType: requestTypeOf(step),
    toolCalls: Array.isArray(step.tools) ? step.tools.length : 0,
    durationMs: validNumber(step.time?.completed) && validNumber(step.time?.created) ? step.time.completed - step.time.created : null,
    compactionEvent: step.type === "compaction"
  }
}

function counters(value) {
  const result = { input: value?.input, output: value?.output, reasoning: value?.reasoning, cacheRead: value?.cache?.read, cacheWrite: value?.cache?.write }
  if (!Object.values(result).every(validNumber)) throw new Error("Unsupported OpenCode tokens schema")
  return result
}

export async function requestObservation(run, operation, params) {
  const args = ["api", operation, ...Object.entries(params).flatMap(([key, value]) => ["--param", `${key}=${value}`])]
  const { stdout } = await run("opencode", args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
  try {
    return JSON.parse(stdout)
  } catch (error) {
    if (!(error instanceof SyntaxError) || !Number.isInteger(params.limit) || params.limit <= 1) throw error
    return requestObservation(run, operation, { ...params, limit: Math.max(1, Math.floor(params.limit / 10)) })
  }
}

function sumUsage(steps) {
  const result = { cost: 0, tokens: Object.fromEntries(counterKeys.map(key => [key, 0])) }
  for (const step of steps) {
    if (step.tokens == null) result.tokens = null
    else if (result.tokens) for (const key of counterKeys) result.tokens[key] += step.tokens[key]
    if (step.nativeReportedUSD == null) result.cost = null
    else if (result.cost !== null) result.cost += step.nativeReportedUSD
  }
  return result
}

function usageDifference(native, observed) {
  return {
    cost: native.cost !== null && observed.cost !== null ? native.cost - observed.cost : null,
    tokens: observed.tokens ? Object.fromEntries(counterKeys.map(key => [key, native.tokens[key] - observed.tokens[key]])) : null
  }
}

function toolSummary(tool) {
  const input = tool.state?.input
  const content = tool.state?.content
  const code = input?.code
  const command = input?.command ?? input?.cmd ?? code
  const text = Array.isArray(content) ? content.filter(part => typeof part.text === "string").map(part => part.text).join("") : null
  const mentions = typeof code === "string" ? [...new Set(code.match(/(?:tokensave|rag)_[a-z_]+/g) ?? [])] : []
  return {
    id: tool.id, name: tool.name, status: tool.state?.status ?? null,
    time: tool.time ?? null,
    durationMs: validNumber(tool.time?.completed) && validNumber(tool.time?.created) ? tool.time.completed - tool.time.created : null,
    inputFingerprint: input ? hash(JSON.stringify(input)) : null,
    outputBytes: Array.isArray(content) ? Buffer.byteLength(JSON.stringify(content)) : null,
    outputFingerprint: Array.isArray(content) ? hash(JSON.stringify(content)) : null,
    outputTextBytes: text === null ? null : Buffer.byteLength(text),
    outputTextLines: text === null ? null : text ? text.split("\n").length : 0,
    briefOutput: typeof command === "string" && /(?:^|[\s/])brief-output\.sh(?:\s|$)/.test(command),
    retrieval: {
      mentionedTools: mentions, mentionsAreExecutionProof: false,
      mode: ["lines", "full", "map", "signatures"].includes(input?.mode) ? input.mode : null,
      range: typeof input?.lines === "string" && /^\d+(-\d+)?$/.test(input.lines) ? input.lines : null,
      limit: validNumber(input?.limit) ? input.limit : null,
      pathFingerprint: typeof (input?.file ?? input?.path) === "string" ? hash(input.file ?? input.path) : null
    }
  }
}

export function summarizeSession({ info, messages, previousSequence = [], messageCoverage = "complete-pages", taskId = null }, version) {
  if (!supportedObservationVersion(version)) throw new Error(`Unsupported OpenCode observation version: ${version}`)
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(info?.id) || !info.location?.directory || !Array.isArray(messages)) throw new Error("Unsupported OpenCode session schema")
  const ids = new Set()
  const gaps = new Set(["price-not-validated", "task-acceptance-unknown", "workload-not-classified", "parent-inclusive-accounting-unverified", "retrieval-scope-needs-review"])
  const native = { cost: validNumber(info.cost) ? info.cost : null, tokens: counters(info.tokens) }
  const current = messages.map((message) => {
    if (!message.id || ids.has(message.id)) throw new Error("Duplicate or missing OpenCode message ID")
    ids.add(message.id)
    const step = {
      id: message.id, type: message.type, time: message.time ?? null, model: message.model ?? null, agent: message.agent ?? null,
      requestId: typeof message.native?.responseId === "string" ? message.native.responseId : null,
      reasoningVariant: typeof message.model?.variant === "string" ? message.model.variant : null
    }
    if (message.type !== "assistant" && message.type !== "compaction" && message.tokens === undefined && message.cost === undefined) return step
    const usage = message.tokens === undefined ? null : counters(message.tokens)
    const cost = validNumber(message.cost) ? message.cost : null
    const priced = message.type !== "assistant"
      ? { ...step, usageKind: "auxiliary", tokens: usage, nativeReportedUSD: cost, status: message.status ?? null, reason: message.reason ?? null }
      : { ...step, tokens: usage, nativeReportedUSD: cost, finish: message.finish ?? null, retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : null, failed: Boolean(message.error), tools: (message.content ?? []).filter((part) => part.type === "tool").map(toolSummary) }
    return { ...priced, request: describeRequest(priced, { sessionId: info.id, taskId }) }
  })
  const sequence = [...new Map([...previousSequence, ...current].map((step) => [step.id, step])).values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const assistants = sequence.filter(step => step.type === "assistant")
  const auxiliary = sequence.filter(step => step.usageKind === "auxiliary" || step.type === "compaction")
  const messageSum = sumUsage(assistants)
  const auxiliarySum = sumUsage(auxiliary)
  const observedSum = sumUsage([...assistants, ...auxiliary])
  if (messageCoverage !== "complete-pages") gaps.add("context-snapshots-need-full-history-check")
  if (messageSum.tokens === null) {
    gaps.add("message-usage-missing")
  }
  if (messageSum.cost === null) {
    gaps.add("message-cost-missing")
  }
  if (auxiliarySum.tokens === null || auxiliarySum.cost === null) gaps.add("auxiliary-usage-missing")
  const delta = usageDifference(native, messageSum)
  const residual = usageDifference(native, observedSum)
  if ((residual.tokens && Object.values(residual.tokens).some(value => value !== 0)) || (residual.cost !== null && Math.abs(residual.cost) > 1e-10)) gaps.add("unallocated-native-usage")
  if (delta.tokens && Object.values(delta.tokens).some((value) => value !== 0)) gaps.add("session-message-usage-mismatch")
  if (delta.cost !== null && Math.abs(delta.cost) > 1e-10) gaps.add("session-message-cost-mismatch")
  if (native.cost === 0 && Object.values(native.tokens).some((value) => value > 0)) gaps.add("zero-cost-with-usage")
  if (sequence.some((step) => step.request?.pricingWindowClockAgrees === false)) gaps.add("pricing-window-mismatch")
  return {
    schemaVersion: 2, client: "opencode", clientVersion: version, source: "native-session-api", messageCoverage,
    observedAt: new Date().toISOString(), sessionID: info.id, parentID: info.parentID ?? null, fork: info.fork ?? null, taskId,
    project: info.location.directory, time: info.time, nativeOutcome: info.outcome ?? null,
    money: { currency: "USD", nativeReportedUSD: native.cost, validatedUSD: null, priceSource: null },
    accounting: { native, messageSum, auxiliarySum, observedSum, delta, residual, familyTotal: null, tokenFieldsAreSeparate: true, tokenSemantics: { input: "cache-miss", cacheRead: "cache-hit", output: "excludes-reasoning", reasoning: "billed-as-output" } },
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
  return writePrivateJSON(file, record)
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
    const previous = await readJSON(path.join(observationDirectory(info.location.directory, stateDirectory), "sessions", `${info.id}.json`), null)
    const previousSequence = api.messageCoverage === "active-context" ? previous?.sequence ?? [] : []
    let taskId = null
    try {
      taskId = api.task ? await api.task(id) : null
    } catch {
      taskId = null
    }
    const record = summarizeSession({ info, messages, previousSequence, messageCoverage: api.messageCoverage, taskId }, api.version)
    record.handoff = (api.handoff ? await api.handoff(id) : null) ?? previous?.handoff ?? null
    if (record.handoff && previous?.handoff) record.handoff.targetIDs = [...new Set([...(previous.handoff.targetIDs ?? []), previous.handoff.targetID, ...(record.handoff.targetIDs ?? []), record.handoff.targetID].filter(Boolean))]
    try {
      const models = await api.prices(info.location.directory)
      const used = new Set(record.sequence.filter((step) => step.model).map((step) => `${step.model.providerID}/${step.model.id}`))
      const snapshotModels = models.filter((model) => used.has(`${model.providerID}/${model.id}`)).map((model) => ({ providerID: model.providerID, id: model.id, cost: model.cost }))
      const deepseekModels = snapshotModels.filter((model) => model.providerID === "deepseek")
      record.priceSnapshot = { capturedAt: record.observedAt, source: "opencode-model-registry", validatedForBilling: snapshotModels.length > 0 && deepseekModels.length === snapshotModels.length && deepseekPricing.validatedForBilling, models: snapshotModels }
      if (deepseekModels.length > 0) {
        record.priceSnapshot.timeDependentPricing = deepseekPricing
      }
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
    const continuations = [...new Set([record.handoff?.targetID, ...(record.handoff?.targetIDs ?? [])].filter(Boolean))]
    for (const targetID of continuations) {
      if (visited.has(targetID)) continue
      try {
        await collect(targetID)
      } catch {
        record.gaps.push("handoff-observation-unavailable")
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
    task: async (sessionID) => {
      const id = await context.storage.get(taskContextKey(sessionID))
      return typeof id === "string" ? id : null
    },
    handoff: async (sessionID) => {
      const target = await context.storage.get(`handoff:${sessionID}`)
      return target ? { targetID: target.id ?? null, targetIDs: [...new Set([...(target.previousIDs ?? []), ...(target.id ? [target.id] : [])])], submitted: Boolean(target.submitted), summaryHits: target.summaryHits ?? 0, continuationHits: target.continuationHits ?? 0 } : null
    },
    get: (sessionID) => context.session.get({ sessionID }),
    messages: async (sessionID) => ({ data: await context.session.context({ sessionID }), cursor: {} }),
    children: (parentID, cursor) => context.session.list({ parentID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) })
  }
}
