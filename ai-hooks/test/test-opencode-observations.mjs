import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectObservations, summarizeSession, observationDirectory, requestObservation } from "../../opencode/observations.mjs"

const tokens = (input = 10) => ({ input, output: 2, reasoning: 3, cache: { read: 5, write: 0 } })
const info = (id = "ses_root") => ({ id, location: { directory: "/project" }, time: { created: 1, updated: 10 }, cost: 0, tokens: tokens(12), outcome: "succeeded" })
const message = (id = "msg_1") => ({ id, type: "assistant", model: { providerID: "deepseek", id: "deepseek-v4-pro" }, agent: "build", time: { created: 2, completed: 5 }, cost: 0, tokens: tokens(), content: [{ type: "reasoning", text: "private reasoning" }, { type: "tool", id: "tool_1", name: "read", state: { status: "completed", input: { file: "private.txt" }, content: [{ type: "text", text: "secret output" }] }, time: { created: 3, completed: 4 } }] })

test("observations keep unknown prices and usage differences without counting reasoning twice", () => {
  const record = summarizeSession({ info: info(), messages: [message()] }, "2.2.5")

  assert.equal(record.money.validatedUSD, null)
  assert.equal(record.money.nativeReportedUSD, 0)
  assert.equal(record.accounting.delta.tokens.input, 2)
  assert.equal(record.accounting.messageSum.tokens.output, 2)
  assert.equal(record.accounting.messageSum.tokens.reasoning, 3)
  assert.ok(record.gaps.includes("zero-cost-with-usage"))
  assert.ok(record.gaps.includes("session-message-usage-mismatch"))
  assert.equal(record.assessment.accepted, null)
  assert.equal(record.readyForOptimization, false)
  assert.equal(record.sequence[0].tools[0].durationMs, 1)
  assert.doesNotMatch(JSON.stringify(record), /private reasoning|secret output|private.txt/)
})

test("observations reject unsupported schemas and duplicate messages instead of plausible totals", () => {
  assert.throws(() => summarizeSession({ info: info(), messages: [message(), message()] }, "2.2.5"), /Duplicate/)
  assert.throws(() => summarizeSession({ info: info(), messages: [message()] }, "1.0.0"), /Unsupported/)
  const partial = message()
  delete partial.tokens.cache.write
  assert.throws(() => summarizeSession({ info: info(), messages: [partial] }, "2.2.5"), /tokens/)
})

test("observations allocate compaction usage and leave unexplained native usage separate", () => {
  const auxiliary = { ...message("msg_compaction"), type: "compaction", status: "succeeded", reason: "context", summary: "private summary" }
  const record = summarizeSession({ info: { ...info(), tokens: tokens(25) }, messages: [message(), auxiliary] }, "2.2.5")

  assert.equal(record.accounting.messageSum.tokens.input, 10)
  assert.equal(record.accounting.auxiliarySum.tokens.input, 10)
  assert.equal(record.accounting.observedSum.tokens.input, 20)
  assert.equal(record.accounting.residual.tokens.input, 5)
  assert.equal(record.sequence[1].status, "succeeded")
  assert.ok(record.gaps.includes("unallocated-native-usage"))
  assert.doesNotMatch(JSON.stringify(record), /private summary|secret output/)
})

test("native observation requests shrink malformed pages without swallowing command errors", async () => {
  const run = async (command, args) => {
    const limit = args.find(value => value.startsWith("limit="))
    return { stdout: limit === "limit=1" ? '{"data":[{"id":"last"}],"cursor":{}}' : '{"data":[' }
  }

  const page = await requestObservation(run, "session.message.list", { sessionID: "ses_root", limit: 100, cursor: "previous" })
  assert.equal(page.data[0].id, "last")
  assert.deepEqual(page.cursor, {})
  await assert.rejects(requestObservation(async () => { throw new Error("permission denied") }, "session.message.list", { limit: 100 }), /permission denied/)
  await assert.rejects(requestObservation(async () => ({ stdout: "{" }), "session.message.list", { limit: 1 }), SyntaxError)
})

test("collector paginates children and messages, upserts private records and preserves assessment", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "harness-observations-"))
  t.after(() => fs.rm(state, { recursive: true, force: true }))
  const api = {
    version: "2.2.5",
    get: async (id) => ({ ...info(id), ...(id === "ses_child" ? { parentID: "ses_root" } : {}) }),
    messages: async (id, cursor) => cursor
      ? { data: [{ id: `${id}_switch`, type: "model-switched", time: { created: 6 }, model: { providerID: "deepseek", id: "deepseek-flash" } }], cursor: {} }
      : { data: [message(`${id}_msg`)], cursor: { next: "page2" } },
    children: async (id, cursor) => id !== "ses_root" || cursor
      ? { data: [], cursor: {} }
      : { data: [{ ...info("ses_child"), parentID: "ses_root" }], cursor: { next: "page2" } }
  }

  const paths = await collectObservations(api, "ses_root", { stateDirectory: state })
  assert.equal(paths.length, 2)
  const rootPath = path.join(observationDirectory("/project", state), "sessions", "ses_root.json")
  const record = JSON.parse(await fs.readFile(rootPath, "utf8"))
  assert.deepEqual(record.delegation.childIDs, ["ses_child"])
  assert.equal(record.delegation.childrenComplete, true)
  assert.equal(record.sequence.length, 2)
  assert.equal(record.accounting.familyTotal, null)
  record.assessment.accepted = true
  record.handoff = { targetID: "ses_next", targetIDs: ["ses_next"], submitted: true }
  await fs.writeFile(rootPath, JSON.stringify(record))
  const refreshed = await collectObservations(api, "ses_root", { stateDirectory: state })
  assert.equal(refreshed.length, 3)
  assert.ok(refreshed.some(file => file.endsWith("ses_next.json")))
  assert.equal(JSON.parse(await fs.readFile(rootPath)).handoff.targetID, "ses_next")
  assert.equal(JSON.parse(await fs.readFile(rootPath)).assessment.accepted, true)
  assert.equal((await fs.stat(rootPath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(rootPath))).mode & 0o777, 0o700)
  api.handoff = async id => id === "ses_root" ? { targetID: "ses_latest", targetIDs: ["ses_latest"], submitted: true } : null

  await collectObservations(api, "ses_root", { stateDirectory: state })

  const bounded = JSON.parse(await fs.readFile(rootPath))
  assert.deepEqual(bounded.handoff.targetIDs, ["ses_next", "ses_latest"])
  assert.equal(bounded.handoff.targetID, "ses_latest")
})

test("collector does not certify missing children or cyclic pagination", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "harness-observations-"))
  t.after(() => fs.rm(state, { recursive: true, force: true }))
  const api = {
    version: "2.2.5",
    get: async () => info(),
    messages: async () => ({ data: [message()], cursor: {} }),
    children: async () => { throw new Error("unavailable") }
  }
  const [file] = await collectObservations(api, "ses_root", { stateDirectory: state })
  const record = JSON.parse(await fs.readFile(file))
  assert.equal(record.delegation.childrenComplete, false)
  assert.ok(record.gaps.includes("children-unavailable"))
  api.messages = async () => ({ data: [], cursor: { next: "repeated" } })
  await assert.rejects(collectObservations(api, "ses_root", { stateDirectory: state }), /pagination/)
})

test("context snapshots preserve earlier steps across compaction and full pages replace stale history", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "harness-observations-"))
  t.after(() => fs.rm(state, { recursive: true, force: true }))
  let messages = [message()]
  const api = {
    version: "2.2.5", messageCoverage: "active-context",
    get: async () => info(),
    messages: async () => ({ data: messages, cursor: {} }),
    children: async () => ({ data: [], cursor: {} }),
    prices: async () => [{ providerID: "deepseek", id: "deepseek-v4-pro", cost: [{ input: 1, output: 2 }], settings: { apiKey: "private-key" } }]
  }
  const [file] = await collectObservations(api, "ses_root", { stateDirectory: state })
  messages = [message("msg_2")]
  await collectObservations(api, "ses_root", { stateDirectory: state })
  let record = JSON.parse(await fs.readFile(file))
  assert.deepEqual(record.sequence.map((step) => step.id), ["msg_1", "msg_2"])
  assert.equal(record.accounting.messageSum.tokens.input, 20)
  assert.equal(record.priceSnapshot.validatedForBilling, true)
  assert.equal(record.priceSnapshot.models[0].cost[0].output, 2)
  assert.doesNotMatch(JSON.stringify(record), /private-key/)
  assert.ok(record.gaps.includes("context-snapshots-need-full-history-check"))
  delete api.messageCoverage
  await collectObservations(api, "ses_root", { stateDirectory: state })
  record = JSON.parse(await fs.readFile(file))
  assert.deepEqual(record.sequence.map((step) => step.id), ["msg_2"])
  assert.equal(record.messageCoverage, "complete-pages")
})
