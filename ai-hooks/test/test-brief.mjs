import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerBrief } from "../../opencode/brief.mjs"
import { registerHandoff } from "../../opencode/handoff.mjs"
import { registerTaskContext } from "../../opencode/task-context.mjs"
import { readBriefPolicy } from "../bin/brief-policy.mjs"

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brief-routing-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stored = new Map(), sessions = new Map(), prompts = [], hooks = {}, tools = new Map()
  const original = { providerID: "fixture", id: "daily", variant: "high" }
  sessions.set("source", { location: { directory }, model: original, agent: "build", permissions: [{ action: "edit", resource: "secret/**", effect: "deny" }] })
  const context = {
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)) },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    command: { transform: async edit => edit({ add() {} }) },
    tool: { transform: async edit => edit({ add: value => tools.set(value.name, value) }) },
    session: {
      hook: async (name, callback) => { hooks[name] = callback },
      wait: async () => {},
      get: async ({ sessionID }) => sessions.get(sessionID),
      context: async ({ sessionID }) => prompts.filter(value => value.sessionID === sessionID).map(value => ({ type: "user", text: value.text })),
      generate: async () => { throw new Error("Brief must reuse its explicit Handoff without an extra model request") },
      create: async value => { const id = `target-${sessions.size}`; sessions.set(id, value); return { id } },
      prompt: async value => { await hooks.prompt({ sessionID: value.sessionID, prompt: { text: value.text } }); prompts.push(value) }
    }
  }
  const policy = { enabled: true }
  return { directory, context, policy, original, sessions, stored, prompts, hooks, tools,
    call: (sessionID, stage, handoff = "Goal: fix module. No push. Plan path: .opencode/plans/task.md") => tools.get("brief_transition").execute({ stage, handoff }, { sessionID }) }
}

test("brief transfers only the Handoff to a fresh session that keeps the source model and permissions", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.context.session.prompt({ sessionID: "source", text: "PRIVATE_OLD_HISTORY" })
  await f.call("source", "plan")
  assert.equal(f.sessions.size, 1)
  const event = { sessionID: "source", tools: { write: {} }, system: [] }
  await f.hooks.context(event)
  assert.deepEqual(event.tools, {})

  await brief.settle("source", true)
  assert.deepEqual(f.sessions.get("target-1").model, f.original)
  assert.deepEqual(f.sessions.get("target-1").permissions, f.sessions.get("source").permissions)
  assert.doesNotMatch(f.prompts.at(-1).text, /PRIVATE_OLD_HISTORY/)
  assert.match(f.prompts.at(-1).text, /Planning phase/)
  assert.match(f.prompts.at(-1).text, /\.opencode\/plans\/task.md/)
  await f.call("target-1", "implement", "Executable plan: update module contract; verify existing callers. No push.")
  await brief.settle("target-1", true)

  assert.deepEqual(f.sessions.get("target-2").model, f.original)
  assert.deepEqual(f.sessions.get("target-2").permissions, f.sessions.get("source").permissions)
  assert.match(f.prompts.at(-1).text, /Executable plan/)
  assert.doesNotMatch(f.prompts.at(-1).text, /PRIVATE_OLD_HISTORY|Planning phase/)
  assert.equal(f.stored.get("handoff:source").transfer.summary, undefined)
  assert.equal(f.stored.get("handoff:source").summary, undefined)
  await brief.settle("source", true)
  assert.equal(f.sessions.size, 3)
})

test("brief preserves observed TokenSave evidence through planning and implementation without an agent save", async t => {
  const f = fixture(t)
  f.context.location = { directory: f.directory }
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "first\nsecond\n")
  const text = `file: source.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n     2\tsecond`
  const context = f.context.session.context
  f.context.session.context = async input => input.sessionID === "source"
    ? [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text: JSON.stringify([text], null, 2) }] } }] }]
    : context(input)
  const memory = await registerTaskContext(f.context)
  const brief = await registerBrief(f.context, await registerHandoff(f.context, undefined, memory), f.policy)

  await f.call("source", "plan")
  await brief.settle("source", true)
  await f.call("target-1", "implement", "Plan ready; next edit source.mjs:2")
  await brief.settle("target-1", true)

  const directory = path.join(f.directory, ".opencode/task-context")
  const files = fs.readdirSync(directory)
  assert.equal(files.length, 1)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"))
  assert.match(saved.checkpoint, /next edit source.mjs:2/)
  for (const sessionID of ["target-1", "target-2"]) {
    assert.match(f.prompts.find(value => value.sessionID === sessionID).text, /Cached ranges: source.mjs:2-2/)
    const restored = await f.tools.get("task_context").execute({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] }, { sessionID })
    assert.match(restored.content, /2\tsecond/)
  }
})

test("routine turns, disabled routing, errors and cancellation create no continuation", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await brief.settle("source", true)
  assert.equal(f.sessions.size, 1)
  await assert.rejects(f.call("source", "implement"), /No planning phase/)
  await f.call("source", "plan")
  await brief.settle("source", false)
  assert.equal(f.sessions.size, 1)
  await f.call("source", "plan")
  await f.hooks.prompt({ sessionID: "source", prompt: { text: "Changed requirements" } })
  await brief.settle("source", true)
  assert.equal(f.sessions.size, 1)
  const disabled = fixture(t)
  await registerBrief(disabled.context, () => { throw new Error("disabled") }, { enabled: false })
  assert.equal(disabled.tools.size, 0)
})

test("delivery failures reuse the existing target and concurrent requests do not fork the task", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const results = await Promise.allSettled([f.call("source", "plan"), f.call("source", "plan")])
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1)
  const prompt = f.context.session.prompt
  f.context.session.prompt = async () => { throw new Error("transport lost") }
  await assert.rejects(brief.settle("source", true), /transport lost/)
  assert.equal(f.sessions.size, 2)
  f.context.session.prompt = prompt
  await brief.settle("source", true)
  assert.equal(f.sessions.size, 2)
  assert.equal(f.prompts.length, 1)
  await assert.rejects(f.call("target-1", "plan"), /Already planning/)
})

test("brief waits for a manual Handoff and delivers the queued phase exactly once", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  const waiting = Promise.withResolvers()
  const release = Promise.withResolvers()
  f.context.session.wait = async () => { waiting.resolve(); await release.promise }
  const manual = handoff({ sessionID: "source", prompt: { text: "" } })
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
  assert.equal(f.sessions.size, 2)
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.sessions.get("target-1").model, f.original)
  assert.equal(f.stored.get("brief:source").submitted, true)
  await f.call("target-1", "implement")
  await brief.settle("target-1", true)
  assert.deepEqual(f.sessions.get("target-2").model, f.original)
})

test("manual Handoff during planning retains the original implementation model", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.context.session.generate = async () => ({ text: "Plan in progress. Preserve the goal and no push." })

  await handoff({ sessionID: "target-1", prompt: { text: "manual.md" } })
  await f.call("target-2", "implement")
  await brief.settle("target-2", true)

  assert.deepEqual(f.sessions.get("target-2").model, f.original)
  assert.deepEqual(f.sessions.get("target-3").model, f.original)
})

test("new steering while waiting cancels delivery without restoring the stale queue", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  f.context.session.wait = async () => f.hooks.prompt({ sessionID: "source", prompt: { text: "New constraints" } })

  await brief.settle("source", true)

  assert.equal(f.sessions.size, 1)
  assert.equal(f.stored.get("brief:source").submitted, undefined)
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("accepted delivery is not replayed and retries preserve work already queued in the target", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const prompt = f.context.session.prompt
  f.context.session.prompt = async value => { await prompt(value); throw new Error("response lost") }
  await f.call("source", "plan")
  await assert.rejects(brief.settle("source", true), /response lost/)
  await f.call("target-1", "implement")
  f.context.session.prompt = prompt

  await brief.settle("source", true)
  assert.equal(f.prompts.length, 1)
  assert.equal(f.stored.get("brief:target-1").pending.brief.stage, "implementation")
  await brief.settle("target-1", true)
  assert.deepEqual(f.sessions.get("target-2").model, f.original)
})

test("brief policy validates configured model identifiers and effort", t => {
  const f = fixture(t)
  const file = path.join(f.directory, "policy.json")
  fs.writeFileSync(file, JSON.stringify({ codex: { planner: { model: "sol", effort: "invalid" } } }))
  assert.throws(() => readBriefPolicy("codex", file), /Invalid brief routing policy/)
  assert.equal(readBriefPolicy("codex").planner.effort, "medium")
  assert.equal(readBriefPolicy("opencode").enabled, true)
  assert.equal(readBriefPolicy("opencode").planner, undefined)
})
