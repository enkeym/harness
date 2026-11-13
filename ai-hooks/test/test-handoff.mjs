import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerHandoff } from "../../opencode/handoff.mjs"
import { registerContextCache } from "../../opencode/evidence-cache.mjs"
import { createPlan, planReference } from "../../opencode/plan-store.mjs"
import { finishCompaction } from "../../opencode/session-compaction.mjs"
import { cachePolicy } from "../../opencode/cache-policy.mjs"

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-handoff-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  t.after(() => finishCompaction("source"))
  const stored = new Map()
  const events = []
  const compacted = []
  const prompts = []
  let execute
  let compact
  const context = {
    location: { directory },
    command: { transform: async (edit) => edit({ add: (command) => { execute = command.execute } }) },
    rpc: { register: async () => ({ events: { emit: async (name, data) => events.push({ name, data }) } }) },
    storage: {
      get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value),
      remove: async (key) => stored.delete(key)
    },
    session: {
      wait: async () => {},
      hook: async () => {},
      context: async ({ sessionID } = {}) => !sessionID || sessionID === "source" ? [{ id: "msg_source", type: "user", content: [{ type: "text", text: "Continue" }] }] : [],
      get: async () => ({ location: { directory }, agent: "build", model: { id: "model", providerID: "fixture" }, title: "Source" }),
      generate: async () => ({ text: "Continue the remaining plan." }),
      prompt: async (value) => { prompts.push(value) },
      switchModel: async () => { assert.fail("Handoff must not switch models") }
    }
  }
  compact = async () => {}
  context.session.compact = (value) => { compacted.push(value); return compact(value) }
  return {
    context,
    directory,
    stored,
    events,
    compacted,
    prompts,
    setCompact: (value) => { compact = value },
    run: (text = "") => execute({ sessionID: "source", prompt: { text } })
  }
}

test("Handoff compacts the same session and reuses the managed plan", async (t) => {
  const f = fixture(t)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Managed plan: implement step 2; edit source.mjs next",
    stage: "implementation"
  })
  f.context.session.generate = async () => { assert.fail("A managed plan must bypass summary generation") }
  await registerHandoff(f.context)

  await f.run()

  assert.equal(f.compacted.length, 1)
  assert.equal(f.compacted[0].sessionID, "source")
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].delivery, "steer")
  assert.match(f.prompts[0].text, /Task plan: \.opencode\/plans\//)
  assert.doesNotMatch(f.prompts[0].text, /implement step 2/i)
  assert.match(fs.readFileSync(plan.file, "utf8"), /implement step 2/i)
  assert.equal(fs.existsSync(path.join(f.directory, ".opencode/HANDOFF.md")), false)
  assert.equal(f.events.at(-1).data.status, "ready")
  assert.equal(f.events.at(-1).data.targetID, undefined)
})

test("Handoff rejects raw configuration and oversized generated summaries", async (t) => {
  for (const summary of ["PRIVATE_TOKEN=example-value", "A".repeat(cachePolicy.taskCheckpointChars + 1)]) {
    const f = fixture(t)
    f.context.session.generate = async () => ({ text: summary })
    await registerHandoff(f.context)

    await assert.rejects(f.run(), /shorten the Handoff/)

    assert.equal(f.compacted.length, 0)
    assert.equal(fs.existsSync(path.join(f.directory, ".opencode/HANDOFF.md")), false)
  }
})

test("Handoff caches observed ranges and keeps them bound to the same session", async (t) => {
  const f = fixture(t)
  let run
  let generations = 0
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "first\nsecond\n")
  const text = `file: source.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n     2\tsecond`
  f.context.tool = { transform: async edit => edit({ add: tool => { run = tool.execute } }) }
  f.context.session.context = async ({ sessionID }) => sessionID === "source"
    ? [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text }] } }] }]
    : []
  f.context.session.generate = async () => { generations++; return { text: "Next edit source.mjs:2" } }
  const memory = await registerContextCache(f.context)
  await registerHandoff(f.context, undefined, memory)

  await f.run()

  assert.equal(generations, 1)
  assert.equal(f.compacted.length, 1)
  const restored = await run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] }, { sessionID: "source" })
  assert.match(restored.content, /2\tsecond/)
})

test("Handoff creates a managed plan when the session has none", async (t) => {
  const f = fixture(t)
  await registerHandoff(f.context)

  await f.run()

  const plans = fs.readdirSync(path.join(f.directory, ".opencode/plans"))
  assert.equal(plans.length, 1)
  assert.match(fs.readFileSync(path.join(f.directory, ".opencode/plans", plans[0]), "utf8"), /Continue the remaining plan/)
  assert.equal(fs.existsSync(path.join(f.directory, ".opencode/HANDOFF.md")), false)
})

test("Handoff reports an empty summary without compacting", async (t) => {
  const f = fixture(t)
  f.context.session.generate = async () => ({ text: " " })
  await registerHandoff(f.context)

  await assert.rejects(f.run(), /Empty Handoff/)
  assert.equal(f.compacted.length, 0)
  assert.equal(f.events.at(-1).data.status, "error")
})

test("the plan reference carries the path without the plan body", () => {
  const reference = planReference({
    root: "/project",
    file: "/project/.opencode/plans/user-plan.md",
    id: "user-plan"
  })
  assert.match(reference, /Task plan: \.opencode\/plans\/user-plan\.md/)
  assert.doesNotMatch(reference, /##/)
})

test("the generated checkpoint marks a truncated objective line", async (t) => {
  const f = fixture(t)
  const long = await createPlan(f.context, {
    sessionID: "long",
    directory: f.directory,
    objective: "A".repeat(400),
    stage: "implementation"
  })
  const short = await createPlan(f.context, {
    sessionID: "short",
    directory: f.directory,
    objective: "Short objective",
    stage: "implementation"
  })

  const longCheckpoint = fs.readFileSync(long.file, "utf8").split("\n")[2]
  const shortCheckpoint = fs.readFileSync(short.file, "utf8").split("\n")[2]

  assert.equal(longCheckpoint, `- Текущий шаг: 1 — ${"A".repeat(200)}…`)
  assert.equal(shortCheckpoint, "- Текущий шаг: 1 — Short objective")
})

test("Handoff adopts an explicit user plan path and keeps it unmanaged", async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.directory, ".opencode/plans"), { recursive: true })
  const file = path.join(f.directory, ".opencode/plans/user-plan.md")
  fs.writeFileSync(file, "## Checkpoint\n\n- Next step\n\n## Оставшиеся шаги\n\n### 1. Keep working\n")
  f.context.session.generate = async () => { assert.fail("An explicit plan must bypass summary generation") }
  await registerHandoff(f.context)

  await f.run(".opencode/plans/user-plan.md")

  assert.equal(f.compacted.length, 1)
  assert.match(f.prompts[0].text, /Task plan: \.opencode\/plans\/user-plan\.md/)
  assert.doesNotMatch(f.prompts[0].text, /Keep working/)
  assert.equal((await f.context.storage.get("plan:source")).ownership, "user")
  assert.equal(fs.readFileSync(file, "utf8").includes("Keep working"), true)
})

test("Handoff rejects an explicit plan outside the plans directory", async (t) => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.directory, ".opencode/plans"), { recursive: true })
  fs.writeFileSync(path.join(f.directory, ".opencode/other.md"), "## Objective\n\nOutside\n")
  await registerHandoff(f.context)

  await assert.rejects(f.run(".opencode/other.md"), /inside \.opencode\/plans/)
  assert.equal(f.compacted.length, 0)
})

test("Handoff reuses one compaction request while it is pending", async (t) => {
  const f = fixture(t)
  let release
  let started
  const pending = new Promise((resolve) => { started = resolve })
  const createPlanForSession = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Managed plan",
    stage: "implementation"
  })
  f.context.session.generate = async () => { assert.fail("A managed plan must bypass summary generation") }
  f.setCompact(async (value) => {
    started()
    await new Promise((resolve) => { release = resolve })
    return { id: value.id }
  })
  await registerHandoff(f.context)

  const first = f.run()
  await pending
  assert.equal(await f.run(), false)
  release()
  await first

  assert.equal(f.compacted.length, 1)
  assert.ok(createPlanForSession.file)
})

test("Handoff retries after a failed compaction", async (t) => {
  const f = fixture(t)
  await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Managed plan",
    stage: "implementation"
  })
  f.setCompact(async () => { throw new Error("Compaction unavailable") })
  await registerHandoff(f.context)

  await assert.rejects(f.run(), /Compaction unavailable/)
  assert.equal(f.events.at(-1).data.status, "error")

  let attempts = 0
  f.setCompact(async (value) => { attempts++; return { id: value.id } })
  assert.equal(await f.run(), true)
  assert.equal(attempts, 1)
})

test("Handoff preserves the session model and variant", async (t) => {
  const f = fixture(t)
  const source = await f.context.session.get()
  f.context.session.get = async () => ({ ...source, model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" } })
  f.context.session.generate = async () => ({ text: "Remaining plan" })
  await registerHandoff(f.context)

  await f.run()

  assert.equal(f.compacted[0].sessionID, "source")
  assert.deepEqual((await f.context.session.get()).model, { providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" })
})

test("Handoff reports when same-session compaction is unavailable", async (t) => {
  const f = fixture(t)
  await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Managed plan",
    stage: "implementation"
  })
  delete f.context.session.compact
  await registerHandoff(f.context)

  await assert.rejects(f.run(), /does not expose same-session compaction/)
  assert.equal(f.events.at(-1).data.status, "error")
})

test("Handoff UI shows progress without navigating to another session", async () => {
  const { default: plugin } = await import("../../opencode/tui.js")
  let listener
  const current = { type: "session", sessionID: "source" }
  const notifications = []
  const routes = []
  const cleanup = await plugin.setup({
    client: { rpc: () => ({ events: { on: (name, callback) => { listener = callback; return () => { listener = undefined } } } }) },
    ui: {
      toast: { show: (value) => notifications.push(value) },
      router: { current: () => current, navigate: (value) => routes.push(value) }
    }
  })
  listener({ data: { sessionID: "source", status: "preparing", message: "Preparing Handoff" } })
  assert.equal(notifications[0].message, "Preparing Handoff")
  listener({ data: { sessionID: "source", status: "ready", message: "Ready" } })
  assert.deepEqual(routes, [])
  listener({ data: { sessionID: "source", status: "ready", targetID: "target", message: "Ready" } })
  assert.deepEqual(routes, [{ type: "session", sessionID: "target" }])
  cleanup()
  assert.equal(listener, undefined)
})

test("finishCompaction releases a completed request", async (t) => {
  const f = fixture(t)
  await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Managed plan",
    stage: "implementation"
  })
  await registerHandoff(f.context)
  await f.run()
  finishCompaction("source")
  await f.run()

  assert.equal(f.compacted.length, 2)
})
