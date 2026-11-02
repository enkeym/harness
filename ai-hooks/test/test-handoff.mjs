import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerHandoff } from "../../opencode/handoff.mjs"
import { resolveHandoffModel, stripHandoffRoute } from "../../opencode/model-routing.mjs"
import { cachePolicy } from "../../opencode/cache-policy.mjs"

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-handoff-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stored = new Map()
  const events = []
  const created = []
  const prompts = []
  let execute
  const context = {
    command: { transform: async (edit) => edit({ add: (command) => { execute = command.execute } }) },
    rpc: { register: async () => ({ events: { emit: async (name, data) => events.push({ name, data }) } }) },
    storage: {
      get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value),
      scan: async ({ prefix, after, limit }) => {
        const entries = [...stored].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === limit ? entries.at(-1).key : undefined }
      }
    },
    session: {
      wait: async () => {},
      context: async ({ sessionID } = {}) => !sessionID || sessionID === "source" ? [{ id: "msg_source", type: "user", content: [{ type: "text", text: "Continue" }] }] : [],
      get: async () => ({ location: { directory }, agent: "build", model: { id: "model", providerID: "fixture" }, title: "Source" }),
      generate: async () => ({ text: "Continue the remaining plan." }),
      create: async (value) => { const target = { ...value, id: `target-${created.length}` }; created.push(target); return target },
      prompt: async (value) => prompts.push(value),
      synthetic: async () => {}
    }
  }
  return { context, directory, stored, events, created, prompts, run: (text = "") => execute({ sessionID: "source", prompt: { text } }) }
}

test("Handoff recreates a deleted continuation instead of reopening a missing ID", async (t) => {
  const f = fixture(t)
  let generations = 0
  f.context.session.generate = async () => ({ text: `Summary ${++generations}` })
  await registerHandoff(f.context)
  await f.run()
  const get = f.context.session.get
  f.context.session.get = async (input) => {
    if (input.sessionID === "target-0") throw { _tag: "Session.NotFoundError" }
    return get(input)
  }

  await f.run()

  assert.equal(generations, 2)
  assert.equal(f.created.length, 2)
  assert.equal(f.events.at(-1).data.targetID, "target-1")
  assert.equal(f.stored.get("handoff:source").summary, undefined)
})

test("Handoff preserves a pending summary when a deleted target must be recreated", async (t) => {
  const f = fixture(t)
  let generations = 0
  f.context.session.generate = async () => ({ text: `Summary ${++generations}` })
  const prompt = f.context.session.prompt
  f.context.session.prompt = async () => { throw new Error("connection lost") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /connection lost/)
  const get = f.context.session.get
  f.context.session.get = async (input) => {
    if (input.sessionID === "target-0") throw { _tag: "SessionNotFoundError" }
    return get(input)
  }
  f.context.session.prompt = prompt

  await f.run()

  assert.equal(generations, 1)
  assert.equal(f.created.length, 2)
  assert.equal(f.prompts[0].sessionID, "target-1")
})

test("Handoff never recreates a target on a transient lookup failure", async (t) => {
  const f = fixture(t)
  await registerHandoff(f.context)
  await f.run()
  const get = f.context.session.get
  f.context.session.get = async (input) => {
    if (input.sessionID === "target-0") throw new Error("service unavailable")
    return get(input)
  }

  await assert.rejects(f.run(), /service unavailable/)

  assert.equal(f.created.length, 1)
  assert.equal(f.events.at(-1).data.status, "error")
})

test("Handoff does not resend a restore prompt accepted before an RPC failure", async (t) => {
  const f = fixture(t)
  f.context.session.prompt = async value => { f.prompts.push(value); throw new Error("response lost") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /response lost/)
  const context = f.context.session.context
  f.context.session.context = async input => input.sessionID === "target-0"
    ? [{ type: "user", text: f.prompts[0].text }]
    : context(input)

  await f.run()

  assert.equal(f.prompts.length, 1)
  assert.equal(f.stored.get("handoff:source").submitted, true)
  assert.equal(f.stored.get("handoff:source").summary, undefined)
})

test("Handoff stops expired accepted transfers before creating another continuation", async (t) => {
  for (const reload of [false, true]) {
    const f = fixture(t)
    f.context.session.prompt = async value => { f.prompts.push(value); throw new Error("response lost") }
    await registerHandoff(f.context)
    await assert.rejects(f.run(), /response lost/)
    const context = f.context.session.context
    f.context.session.context = async input => input.sessionID === "target-0"
      ? [{ type: "user", text: f.prompts[0].text }]
      : context(input)
    f.stored.get("handoff:source").generatedAt = Date.now() - cachePolicy.pendingHandoffMs
    if (reload) await registerHandoff(f.context)

    await assert.rejects(f.run(), /inspect continuation target-0 before retrying/)

    assert.equal(f.created.length, 1)
    assert.equal(f.prompts.length, 1)
    assert.equal(f.stored.get("handoff:source").id, "target-0")
  }
})

test("Handoff removes expired pending text and bounds previous IDs without removing fresh text", async (t) => {
  const f = fixture(t)
  const previousIDs = Array.from({ length: cachePolicy.previousHandoffs + 5 }, (_, i) => `old-${i}`)
  f.stored.set("handoff:expired", { generatedAt: Date.now() - cachePolicy.pendingHandoffMs, summary: "Expired private text", submitted: false, previousIDs })
  f.stored.set("handoff:fresh", { generatedAt: Date.now(), summary: "Fresh retry text", submitted: false, previousIDs })
  for (let i = 0; i < cachePolicy.scanEntries; i++) f.stored.set(`handoff:unused-${i}`, { generatedAt: 0, summary: "Expired", submitted: false })
  const archived = []

  await registerHandoff(f.context, async id => archived.push(id))

  assert.equal(f.stored.get("handoff:expired").summary, undefined)
  assert.equal(f.stored.get("handoff:fresh").summary, "Fresh retry text")
  assert.equal(f.stored.get("handoff:fresh").previousIDs.length, cachePolicy.previousHandoffs)
  assert.equal(f.stored.get(`handoff:unused-${cachePolicy.scanEntries - 1}`).summary, undefined)
  assert.deepEqual(archived.sort(), ["expired", "fresh"])
})

test("Handoff does not resend when a pending continuation has lost delivery evidence after compaction", async t => {
  const f = fixture(t)
  f.context.session.prompt = async value => { f.prompts.push(value); throw new Error("response lost") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /response lost/)
  const context = f.context.session.context
  f.context.session.context = async input => input.sessionID === "target-0"
    ? [{ type: "compaction", summary: "Prior history replaced" }]
    : context(input)

  await assert.rejects(f.run(), /delivery is uncertain/)

  assert.equal(f.prompts.length, 1)
  assert.equal(f.stored.get("handoff:source").submitted, false)
})

test("Handoff regenerates an expired pending summary before retry", async (t) => {
  const f = fixture(t)
  const create = f.context.session.create
  f.context.session.create = async () => { throw new Error("create failed") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /create failed/)
  f.stored.get("handoff:source").generatedAt = Date.now() - cachePolicy.pendingHandoffMs
  f.context.session.create = create
  f.context.session.generate = async () => ({ text: "Fresh regenerated plan" })

  await f.run()

  assert.match(f.prompts[0].text, /Fresh regenerated plan/)
})

test("Handoff reopens its continuation after repeated calls and plugin reload", async (t) => {
  const f = fixture(t)
  await registerHandoff(f.context)
  await f.run()
  await f.run()
  await registerHandoff(f.context)
  await f.run()

  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
  assert.equal(f.events.at(-1).data.targetID, f.created[0].id)
})

test("Handoff reports an empty summary without creating a continuation", async (t) => {
  const f = fixture(t)
  f.context.session.generate = async () => ({ text: " " })
  await registerHandoff(f.context)

  await assert.rejects(f.run(), /Empty Handoff/)
  assert.equal(f.created.length, 0)
  assert.equal(f.events.at(-1).data.status, "error")
})

test("Handoff reuses a generated summary after create failure and invalidates changed context", async t => {
  const f = fixture(t)
  let generations = 0
  f.context.session.generate = async () => { generations++; return { text: "Remaining plan" } }
  const create = f.context.session.create
  f.context.session.create = async () => { throw new Error("Create unavailable") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /Create unavailable/)
  f.context.session.create = create
  await registerHandoff(f.context)
  await f.run()
  assert.equal(generations, 1)
  f.context.session.context = async () => [{ id: "msg_new", type: "user", content: [{ type: "text", text: "Changed plan" }] }]
  await f.run()
  assert.equal(generations, 2)
  assert.equal(f.created.length, 2)
  assert.equal(f.prompts.length, 2)
})

test("Handoff reuses its summary after file failure and invalidates changed permissions and route", async t => {
  const f = fixture(t)
  let generations = 0
  let source = await f.context.session.get()
  f.context.session.get = async () => source
  f.context.session.generate = async () => { generations++; return { text: "Remaining plan" } }
  await registerHandoff(f.context)
  await assert.rejects(f.run("notes/HANDOFF.md"), { code: "ENOENT" })
  fs.mkdirSync(path.join(f.directory, "notes"))
  await f.run("notes/HANDOFF.md")
  assert.equal(generations, 1)
  source = { ...source, permissions: [{ permission: "edit", action: "deny" }] }
  await f.run("notes/HANDOFF.md")
  assert.equal(generations, 2)
  await f.run("notes/HANDOFF.md --route=pro")
  assert.equal(generations, 3)
  assert.equal(f.created.length, 3)
})

for (const failure of [false, true]) {
  test(`DeepSeek Handoff preserves its selected model after ${failure ? "a generation failure" : "generation and continuation"}`, async (t) => {
    const f = fixture(t)
    const original = await f.context.session.get()
    const source = { ...original, model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" } }
    let model = source.model
    f.context.session.get = async () => source
    f.context.session.switchModel = async () => { assert.fail("Handoff must not switch models") }
    f.context.session.generate = async () => {
      assert.equal(model.id, "deepseek-v4-pro")
      if (failure) throw new Error("Provider unavailable")
      return { text: "Accepted remaining plan" }
    }
    await registerHandoff(f.context)

    if (failure) await assert.rejects(f.run(), /Provider unavailable/)
    else await f.run()

    assert.deepEqual(model, source.model)
    assert.equal(f.created.length, failure ? 0 : 1)
    if (!failure) assert.deepEqual(f.created[0].model, source.model)
  })
}

test("Handoff preserves the selected model unless the user explicitly overrides it", () => {
  const flash = { providerID: "deepseek", id: "deepseek-flash", variant: "high" }
  const pro = { providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" }
  const custom = { providerID: "custom", id: "model" }
  assert.equal(resolveHandoffModel(flash), flash)
  assert.equal(resolveHandoffModel(pro), pro)
  assert.equal(resolveHandoffModel(custom, "pro"), custom)
  assert.equal(resolveHandoffModel(flash, "pro").id, "deepseek-v4-pro")
  assert.equal(resolveHandoffModel(pro, "flash").id, "deepseek-flash")
  assert.equal(stripHandoffRoute("Remaining work\nHARNESS-ROUTE: progress=stalled next=investigate"), "Remaining work")
})

test("Handoff ignores legacy escalation markers and honors a manual model override", async (t) => {
  for (const override of ["", "--route=pro"]) {
    const f = fixture(t)
    const source = await f.context.session.get()
    f.context.session.get = async () => ({ ...source, model: { providerID: "deepseek", id: "deepseek-flash" } })
    f.context.session.generate = async () => ({ text: "Continue investigation.\nHARNESS-ROUTE: progress=stalled next=investigate" })
    await registerHandoff(f.context)
    await f.run(override)
    assert.equal(f.created[0].model.id, override ? "deepseek-v4-pro" : "deepseek-flash")
    assert.doesNotMatch(f.prompts[0].text, /HARNESS-ROUTE/)
  }
})

test("Handoff ignores duplicate calls while generating the note", async (t) => {
  const f = fixture(t)
  let release
  let started
  const generating = new Promise((resolve) => { started = resolve })
  f.context.session.generate = () => {
    started()
    return new Promise((resolve) => { release = () => resolve({ text: "Remaining plan" }) })
  }
  await registerHandoff(f.context)
  const first = f.run()
  await generating
  await f.run()
  release()
  await first

  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
})

test("Handoff retries a rejected prompt in the already created session", async (t) => {
  const f = fixture(t)
  const submit = f.context.session.prompt
  f.context.session.prompt = async () => { throw new Error("Submission failed") }
  await registerHandoff(f.context)
  await assert.rejects(f.run(), /Submission failed/)
  f.context.session.prompt = submit
  await f.run()

  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
  assert.match(f.prompts[0].text, /Continue the remaining plan/)
})

test("Handoff UI shows progress and opens the continuation only from its source", async () => {
  const { default: plugin } = await import("../../opencode/tui.js")
  let listener
  let current = { type: "session", sessionID: "source" }
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
  listener({ data: { sessionID: "source", status: "ready", targetID: "target", message: "Ready" } })
  assert.deepEqual(routes, [{ type: "session", sessionID: "target" }])
  current = { type: "session", sessionID: "other" }
  listener({ data: { sessionID: "source", status: "ready", targetID: "target", message: "Ready" } })
  assert.equal(routes.length, 1)
  cleanup()
  assert.equal(listener, undefined)
})
