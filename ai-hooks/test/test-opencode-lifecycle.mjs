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
  serialByKey,
  lifecycleJournalFile
} from "../../opencode/lifecycle-metrics.mjs"
import { observationTimeoutMs, observationWaitMs } from "../bin/context-policy.mjs"
import { createAcceptanceNotifier, handleSuccessfulTurn } from "../../opencode/harness.js"
import { planKey } from "../../opencode/plan-store.mjs"
import { registerQuestionGuard } from "../../opencode/question-guard.mjs"
import { registerEmptyResponseGuard } from "../../opencode/empty-response.mjs"

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

test("serialByKey keeps a hung task from blocking another key and frees its own queue", async () => {
  const enqueue = serialByKey()
  const order = []
  const hung = enqueue("ses_a", () =>
    awaitBounded(new Promise(() => {}), 40, () => [])
  )
  const other = await enqueue("ses_b", async () => {
    order.push("b")
    return ["warning"]
  })
  assert.deepEqual(other, ["warning"])
  assert.deepEqual(order, ["b"], "another session is not queued behind the hung one")
  assert.deepEqual(await hung, [], "the hung task is bounded")
  assert.equal(
    await enqueue("ses_a", async () => "next"),
    "next",
    "the same key accepts new work after its timeout"
  )

  const serialized = []
  await Promise.all([
    enqueue("ses_c", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      serialized.push(1)
    }),
    enqueue("ses_c", async () => serialized.push(2))
  ])
  assert.deepEqual(serialized, [1, 2], "one key runs strictly in order")

  const drained = []
  enqueue("ses_d", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    drained.push("first")
  })
  enqueue("ses_d", async () => drained.push("second"))
  await enqueue.drain()
  assert.deepEqual(
    drained,
    ["first", "second"],
    "drain waits for queued work instead of dropping it"
  )
})

test("observation wait comes from the config layer with an env override", () => {
  assert.equal(observationWaitMs(), 20000)
  assert.equal(observationTimeoutMs(), 300000)

  process.env.HARNESS_OBSERVATION_WAIT_MS = "250"
  process.env.HARNESS_OBSERVATION_TIMEOUT_MS = "900"
  try {
    assert.equal(observationWaitMs(), 250)
    assert.equal(observationTimeoutMs(), 900)
  } finally {
    delete process.env.HARNESS_OBSERVATION_WAIT_MS
    delete process.env.HARNESS_OBSERVATION_TIMEOUT_MS
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

function acceptanceFixture(t, first = "First open criterion") {
  const directory = sandbox(t, "harness-acceptance-")
  fs.mkdirSync(path.join(directory, ".opencode", "plans"), { recursive: true })
  const file = path.join(directory, ".opencode", "plans", "audit-task.md")
  fs.writeFileSync(
    file,
    "## Checkpoint\n\n- Текущий шаг: 1\n\n## Acceptance criteria\n\n" +
      `- A1 [not checked] ${first}\n` +
      "- A2 [not checked] Second open criterion\n"
  )
  const stored = new Map([
    [
      planKey("ses_open"),
      {
        version: 1,
        id: "audit-task",
        file,
        root: directory,
        sessionID: "ses_open",
        ownership: "managed",
        stage: "implementation",
        updatedAt: Date.now()
      }
    ]
  ])
  const calls = []
  let turn = null
  const context = {
    storage: {
      get: async key => stored.get(key),
      set: async (key, value) => stored.set(key, value),
      remove: async key => stored.delete(key)
    },
    session: {
      prompt: async value => calls.push({ method: "prompt", value }),
      generate: async value => calls.push({ method: "generate", value }),
      compact: async value => calls.push({ method: "compact", value }),
      synthetic: async value => calls.push({ method: "synthetic", value }),
      context: async () =>
        turn
          ? [
              {
                id: "msg_user",
                type: "user",
                content: [{ type: "text", text: "Continue" }]
              },
              {
                type: "assistant",
                content: [{ type: "text", text: turn }]
              }
            ]
          : []
    }
  }
  const notices = []
  const notify = createAcceptanceNotifier((title, message) =>
    notices.push({ title, message })
  )
  return {
    context,
    file,
    notices,
    notify,
    stored,
    calls,
    setTurn: value => {
      turn = value
    }
  }
}

test("a successful turn reports open acceptance once without a receipt or a model call", async t => {
  const f = acceptanceFixture(t)

  assert.equal(await f.notify(f.context, "ses_open"), true)
  assert.equal(await f.notify(f.context, "ses_open"), false)

  assert.equal(f.notices.length, 1)
  assert.match(f.notices[0].title, /Приёмка не завершена/)
  assert.match(f.notices[0].message, /A1/)
  assert.match(f.notices[0].message, /unfinished/i)
  assert.equal(f.stored.get(planKey("ses_open")).completedAt, undefined)
  assert.equal(f.calls.length, 0)
  assert.match(fs.readFileSync(f.file, "utf8"), /A1 \[not checked\]/)
})

test("a successful turn reports acceptance that is closed but not finalized", async t => {
  const f = acceptanceFixture(t)
  fs.writeFileSync(
    f.file,
    "## Checkpoint\n\n- Текущий шаг: 1\n\n## Acceptance criteria\n\n" +
      '- A1 [closed] First criterion | check: test node --test ai-hooks/test/test-brief.mjs -t "first" | test: node --test ai-hooks/test/test-brief.mjs -t "first" => 1 passed\n' +
      '- A2 [closed] Second criterion | check: test node --test ai-hooks/test/test-brief.mjs -t "second" | test: node --test ai-hooks/test/test-brief.mjs -t "second" => 1 passed\n'
  )

  assert.equal(await f.notify(f.context, "ses_open"), true)
  assert.equal(await f.notify(f.context, "ses_open"), false)

  assert.equal(f.notices.length, 1)
  assert.match(f.notices[0].message, /not finalized/i)
  assert.match(f.notices[0].message, /context_cache/)
  assert.equal(f.stored.get(planKey("ses_open")).completedAt, undefined)
  assert.equal(f.calls.length, 0)
})

test("the successful-turn handler runs guards and one acceptance notice without model work", async t => {
  const f = acceptanceFixture(t)
  const order = []

  await handleSuccessfulTurn({
    context: f.context,
    sessionID: "ses_open",
    source: { agent: "build" },
    questionGuard: { check: async () => order.push("question") },
    emptyResponseGuard: { check: async () => order.push("empty") },
    acceptanceNotifier: f.notify,
    settle: async () => order.push("settle")
  })

  assert.deepEqual(order, ["question", "empty", "settle"])
  assert.equal(f.notices.length, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.stored.get(planKey("ses_open")).completedAt, undefined)
})

test("a question, an agreed pause and an exact blocker start no model work", async t => {
  for (const [mode, criterion, turn, synthetic] of [
    [
      "question",
      "Which boundary should be checked?",
      "Проверки прошли.\n\nWhich boundary should be checked?",
      true
    ],
    [
      "agreed pause",
      "Pause after the current step",
      "Pause after the current step.\n\nNo work until the user agrees.",
      false
    ],
    [
      "exact blocker",
      "Blocked: the original section 1.4 is missing",
      "Blocked: the original section 1.4 is missing.\n\nNo work can continue.",
      false
    ]
  ])
    await t.test(mode, async t => {
      const f = acceptanceFixture(t, criterion)
      f.setTurn(turn)
      const questionGuard = await registerQuestionGuard(f.context)
      const emptyResponseGuard = await registerEmptyResponseGuard(f.context)

      await handleSuccessfulTurn({
        context: f.context,
        sessionID: "ses_open",
        source: { agent: "build" },
        questionGuard,
        emptyResponseGuard,
        acceptanceNotifier: f.notify,
        settle: async () => {}
      })

      assert.deepEqual(
        f.calls.filter(call =>
          ["prompt", "generate", "compact"].includes(call.method)
        ),
        [],
        `${mode} must not start model work`
      )
      assert.equal(
        f.calls.filter(call => call.method === "synthetic").length,
        synthetic ? 1 : 0
      )
      assert.equal(f.notices.length, 1)
      assert.match(f.notices[0].message, /A1/)
      assert.match(fs.readFileSync(f.file, "utf8"), new RegExp(criterion))
      assert.equal(f.stored.get(planKey("ses_open")).completedAt, undefined)
    })
})
