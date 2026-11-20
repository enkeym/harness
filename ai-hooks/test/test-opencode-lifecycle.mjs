import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { collectObservations } from "../../opencode/observations.mjs"
import {
  recordLifecycle,
  awaitBounded,
  lifecycleJournalFile
} from "../../opencode/lifecycle-metrics.mjs"
import { observationWaitMs } from "../bin/context-policy.mjs"

const tokens = (input = 10) => ({ input, output: 2, reasoning: 3, cache: { read: 5, write: 0 } })
const message = (id = "msg_1") => ({ id, type: "assistant", model: { providerID: "deepseek", id: "deepseek-v4-pro" }, agent: "build", time: { created: 2, completed: 5 }, cost: 0, tokens: tokens(), content: [{ type: "tool", id: "tool_1", name: "read", state: { status: "completed", input: { file: "private.txt" }, content: [{ type: "text", text: "secret output" }] }, time: { created: 3, completed: 4 } }] })

function sandbox(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const readJournal = async (directory, stateDirectory) =>
  fs
    .readFileSync(lifecycleJournalFile(directory, stateDirectory), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

test("lifecycle journal appends stage entries as private NDJSON", async (t) => {
  const directory = sandbox(t, "harness-lifecycle-")
  const stateDirectory = sandbox(t, "harness-state-")

  await recordLifecycle({ sessionID: "ses_a", stage: "turn-finished", type: "session.execution.succeeded" }, { directory, stateDirectory })
  await recordLifecycle({ sessionID: "ses_a", stage: "observe-end", durationMs: 12, files: 1, pages: 2, warnings: 0 }, { directory, stateDirectory })

  const entries = await readJournal(directory, stateDirectory)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].stage, "turn-finished")
  assert.equal(entries[1].pages, 2)
  assert.ok(entries.every((entry) => typeof entry.at === "string"))
  assert.equal(fs.statSync(lifecycleJournalFile(directory, stateDirectory)).mode & 0o777, 0o600)
})

test("lifecycle recording never rejects when the journal cannot be written", async (t) => {
  const directory = sandbox(t, "harness-lifecycle-")
  const blocker = path.join(directory, "blocker")
  fs.writeFileSync(blocker, "not a directory")

  await recordLifecycle({ sessionID: "ses_b", stage: "turn-finished" }, { directory, stateDirectory: blocker })
})

test("two parallel sessions append separate journal entries", async (t) => {
  const directory = sandbox(t, "harness-lifecycle-")
  const stateDirectory = sandbox(t, "harness-state-")

  await Promise.all([
    recordLifecycle({ sessionID: "ses_1", stage: "settle", durationMs: 3 }, { directory, stateDirectory }),
    recordLifecycle({ sessionID: "ses_2", stage: "settle", durationMs: 4 }, { directory, stateDirectory })
  ])

  const entries = await readJournal(directory, stateDirectory)
  assert.deepEqual(entries.map((entry) => entry.sessionID).sort(), ["ses_1", "ses_2"])
})

test("disabled lifecycle metrics skip the journal and keep execution correct", async (t) => {
  const directory = sandbox(t, "harness-lifecycle-")
  const stateDirectory = sandbox(t, "harness-state-")
  process.env.HARNESS_LIFECYCLE_METRICS = "off"
  try {
    await recordLifecycle({ sessionID: "ses_c", stage: "turn-finished" }, { directory, stateDirectory })

    assert.equal(fs.existsSync(lifecycleJournalFile(directory, stateDirectory)), false)
  } finally {
    delete process.env.HARNESS_LIFECYCLE_METRICS
  }
})

test("awaitBounded returns the settled value, rethrows rejection and bounds a hung task", async () => {
  assert.deepEqual(await awaitBounded(Promise.resolve(["warning"]), 5000), ["warning"])
  await assert.rejects(awaitBounded(Promise.reject(new Error("boom")), 5000), /boom/)

  const started = Date.now()
  const result = await awaitBounded(new Promise(() => {}), 30, () => [])
  assert.deepEqual(result, [])
  assert.ok(Date.now() - started < 2000)
})

test("observation wait comes from the config layer with an env override", () => {
  assert.equal(observationWaitMs(), 20000)

  process.env.HARNESS_OBSERVATION_WAIT_MS = "250"
  try {
    assert.equal(observationWaitMs(), 250)
  } finally {
    delete process.env.HARNESS_OBSERVATION_WAIT_MS
  }
})

test("collectObservations counts pages and saved files into stats", async (t) => {
  const directory = sandbox(t, "harness-lifecycle-")
  const stateDirectory = sandbox(t, "harness-state-")
  const api = {
    version: "2.3.0",
    messageCoverage: "active-context",
    get: async (id) => ({ id, location: { directory }, time: { created: 1, updated: 10 }, cost: 0, tokens: tokens(12), outcome: "succeeded" }),
    messages: async () => ({ data: [message()], cursor: {} }),
    children: async () => ({ data: [], cursor: {} }),
    prices: async () => { throw new Error("offline") },
    task: async () => null,
    handoff: async () => null
  }

  const stats = {}
  const files = await collectObservations(api, "ses_root", { stateDirectory, directory, stats })

  assert.equal(files.length, 1)
  assert.ok(fs.existsSync(files[0]))
  assert.equal(stats.pages, 2)
})
