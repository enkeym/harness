import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerBrief } from "../../opencode/brief.mjs"
import { registerHandoff } from "../../opencode/handoff.mjs"
import { registerContextCache } from "../../opencode/evidence-cache.mjs"
import { finishCompaction } from "../../opencode/session-compaction.mjs"
import { readBriefPolicy } from "../bin/brief-policy.mjs"

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brief-routing-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  t.after(() => finishCompaction("source"))
  const stored = new Map(), sessions = new Map(), hooks = {}, tools = new Map(), compacted = [], prompts = []
  const original = { providerID: "fixture", id: "daily", variant: "high" }
  sessions.set("source", { location: { directory }, model: original, agent: "build", permissions: [{ action: "edit", resource: "secret/**", effect: "deny" }] })
  let compact = async (value) => ({ id: value.id })
  const context = {
    location: { directory },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)), remove: async key => stored.delete(key) },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    command: { transform: async edit => edit({ add() {} }) },
    tool: { transform: async edit => edit({ add: value => tools.set(value.name, value) }) },
    session: {
      hook: async (name, callback) => { hooks[name] = callback },
      wait: async () => {},
      get: async ({ sessionID }) => sessions.get(sessionID),
      context: async () => [],
      generate: async () => { throw new Error("Brief must reuse its explicit Handoff without an extra model request") },
      prompt: async value => { prompts.push(value) },
      compact: value => { compacted.push(value); return compact(value) },
      switchModel: async () => { assert.fail("Handoff must not switch models") }
    }
  }
  const policy = { enabled: true }
  return {
    directory,
    context,
    policy,
    original,
    sessions,
    stored,
    hooks,
    tools,
    compacted,
    prompts,
    setCompact: value => { compact = value },
    finish: () => finishCompaction("source"),
    call: (sessionID, stage, handoff = "Goal: fix module. No push. Plan path: .opencode/plans/task.md") => tools.get("brief_transition").execute({ stage, handoff }, { sessionID })
  }
}

test("brief compacts the source session and keeps the plan bound to it", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.call("source", "plan")
  const event = { sessionID: "source", tools: { write: {} }, system: [] }
  await f.hooks.context(event)
  assert.deepEqual(event.tools, {})

  await brief.settle("source", true)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
  assert.equal(f.compacted[0].sessionID, "source")
  const planningContext = { sessionID: "source", system: [] }
  await f.hooks.context(planningContext)
  const planningSystem = planningContext.system.map(value => value.text).join("\n")
  assert.equal((planningSystem.match(/Planning phase\./g) ?? []).length, 1)
  assert.match(planningSystem, /Task plan: \.opencode\/plans\/[a-z0-9-]+\.md/)
  const plans = fs.readdirSync(path.join(f.directory, ".opencode/plans"))
  assert.equal(plans.length, 1)
  const planFile = path.join(f.directory, ".opencode/plans", plans[0])
  assert.match(fs.readFileSync(planFile, "utf8"), /Goal: fix module\. No push\./)
  f.finish()
  await f.call("source", "implement", "Executable plan: update module contract; verify existing callers. No push.")
  await brief.settle("source", true)

  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 2)
  assert.match(fs.readFileSync(planFile, "utf8"), /Executable plan: update module contract/)
  assert.match(fs.readFileSync(planFile, "utf8"), /Goal: fix module\. No push\./)
  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").pending, undefined)
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 2)
})

test("brief preserves observed TokenSave evidence through planning and implementation without an agent save", async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "first\nsecond\n")
  const text = `file: source.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n     2\tsecond`
  f.context.session.context = async () => [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text: JSON.stringify([text], null, 2) }] } }] }]
  const memory = await registerContextCache(f.context)
  const brief = await registerBrief(f.context, await registerHandoff(f.context, undefined, memory), f.policy)

  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()
  await f.call("source", "implement", "Plan ready; next edit source.mjs:2")
  await brief.settle("source", true)

  const directory = path.join(f.directory, ".opencode/context-cache")
  const files = fs.readdirSync(directory)
  assert.equal(files.length, 1)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"))
  assert.ok(saved.sources.some(source => source.file === "source.mjs"))
  assert.match(saved.plan, /^\.opencode\/plans\//)
  const plans = fs.readdirSync(path.join(f.directory, ".opencode/plans"))
  assert.equal(plans.length, 1)
  assert.match(fs.readFileSync(path.join(f.directory, ".opencode/plans", plans[0]), "utf8"), /next edit source.mjs:2/)
  const restored = await f.tools.get("context_cache").execute({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] }, { sessionID: "source" })
  assert.match(restored.content, /2\tsecond/)
  assert.match((await f.tools.get("context_cache").execute({ action: "restore" }, { sessionID: "other" })).content, /No saved/)
})

test("routine turns, disabled routing, errors and cancellation compact nothing", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 0)
  await assert.rejects(f.call("source", "implement"), /No planning phase/)
  await f.call("source", "plan")
  await brief.settle("source", false)
  assert.equal(f.compacted.length, 0)
  await f.call("source", "plan")
  await f.hooks.prompt({ sessionID: "source", prompt: { text: "Changed requirements" } })
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 0)
  const disabled = fixture(t)
  await registerBrief(disabled.context, () => { throw new Error("disabled") }, { enabled: false })
  assert.equal(disabled.tools.size, 0)
})

test("compaction failures keep the queued phase and concurrent requests do not fork", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const results = await Promise.allSettled([f.call("source", "plan"), f.call("source", "plan")])
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1)
  let attempts = 0
  f.setCompact(async () => { attempts++; throw new Error("compaction lost") })
  await assert.rejects(brief.settle("source", true), /compaction lost/)
  assert.ok(f.stored.get("brief:source").pending)
  f.setCompact(async value => { attempts++; return { id: value.id } })
  await brief.settle("source", true)
  assert.equal(attempts, 2)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.stored.get("brief:source").stage, "planning")
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("brief waits for a manual Handoff and compacts once", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  const waiting = Promise.withResolvers()
  const release = Promise.withResolvers()
  f.context.session.wait = async () => { waiting.resolve(); await release.promise }
  const manual = handoff({ sessionID: "source" })
  await waiting.promise
  await f.call("source", "plan")
  let settled = false
  const automatic = brief.settle("source", true).then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  const whileWaiting = structuredClone(f.stored.get("brief:source"))
  const settledWhileWaiting = settled

  release.resolve()
  await Promise.all([manual, automatic])

  assert.equal(settledWhileWaiting, false)
  assert.equal(whileWaiting.submitted, undefined)
  assert.ok(whileWaiting.pending)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
  assert.equal(f.stored.get("brief:source").stage, "planning")
  f.finish()
  await f.call("source", "implement")
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 2)
})

test("manual Handoff during planning keeps the session model", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()

  await handoff({ sessionID: "source" })
  f.finish()
  await f.call("source", "implement")
  await brief.settle("source", true)

  assert.equal(f.sessions.size, 1)
  assert.deepEqual(f.sessions.get("source").model, f.original)
  assert.equal(f.compacted.length, 3)
})

test("new steering while waiting cancels delivery without restoring the stale queue", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  f.context.session.wait = async () => f.hooks.prompt({ sessionID: "source", prompt: { text: "New constraints" } })

  await brief.settle("source", true)

  assert.equal(f.compacted.length, 0)
  assert.equal(f.stored.get("brief:source").submitted, undefined)
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("a compaction failure is retried without losing the authorized implementation", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  f.setCompact(async () => { throw new Error("compaction unavailable") })
  await assert.rejects(brief.settle("source", true), /compaction unavailable/)
  f.setCompact(async value => ({ id: value.id }))
  await brief.settle("source", true)
  f.finish()
  await f.call("source", "implement", "Executable plan: edit the module")
  await brief.settle("source", true)

  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").pending, undefined)
  assert.match(fs.readFileSync(path.join(f.directory, ".opencode/plans", fs.readdirSync(path.join(f.directory, ".opencode/plans"))[0]), "utf8"), /Executable plan: edit the module/)
})

test("a continuation cannot restart planning or fork an authorized implementation", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()
  await assert.rejects(f.call("source", "plan"), /Already planning/)
  await f.call("source", "implement", "Plan ready; edit the module next")
  await brief.settle("source", true)

  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").planned, true)
  assert.equal(f.stored.get("brief:source").implemented, true)
  await assert.rejects(f.call("source", "plan"), /Implementation is authorized/)
  await assert.rejects(f.call("source", "implement"), /Implementation is already authorized/)
  await f.hooks.prompt({ sessionID: "source", prompt: { text: "Continue" } })
  await assert.rejects(f.call("source", "plan"), /Implementation is authorized/)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 2)
})

test("separate plugin instances deliver one compaction", async t => {
  const f = fixture(t)
  const first = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const second = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")

  const results = await Promise.allSettled([
    first.settle("source", true),
    second.settle("source", true)
  ])

  assert.deepEqual(results.map(value => value.status), ["fulfilled", "fulfilled"])
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
})

test("brief policy validates configured model identifiers and effort", t => {
  const f = fixture(t)
  const file = path.join(f.directory, "policy.json")
  fs.writeFileSync(file, JSON.stringify({ opencode: { enabled: true, planner: { providerID: "provider", id: "model" } } }))
  assert.equal(readBriefPolicy("opencode", file).planner.id, "model")
  assert.equal(readBriefPolicy("opencode").enabled, true)
  assert.equal(readBriefPolicy("opencode").planner, undefined)
})
