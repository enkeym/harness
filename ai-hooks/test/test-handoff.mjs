import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { escalateStalledSession, registerHandoff } from "../../opencode/handoff.mjs"
import { parseHandoffRoute, resolveHandoffModel, stripHandoffRoute } from "../../opencode/model-routing.mjs"

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
    storage: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: {
      wait: async () => {},
      get: async () => ({ location: { directory }, agent: "build", model: { id: "model", providerID: "fixture" }, title: "Source" }),
      generate: async () => ({ text: "Continue the remaining plan." }),
      create: async (value) => { const target = { ...value, id: `target-${created.length}` }; created.push(target); return target },
      prompt: async (value) => prompts.push(value),
      synthetic: async () => {}
    }
  }
  return { context, directory, events, created, prompts, run: (text = "") => execute({ sessionID: "source", prompt: { text } }) }
}

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

for (const failure of [false, true]) {
  test(`DeepSeek Handoff restores its source model after ${failure ? "a generation failure" : "Flash generation and continuation"}`, async (t) => {
    const f = fixture(t)
    const original = await f.context.session.get()
    const source = { ...original, model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "max" } }
    let model = source.model
    f.context.session.get = async () => source
    f.context.session.switchModel = async (value) => { model = value.model }
    f.context.session.generate = async () => {
      assert.equal(model.id, "deepseek-flash")
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

test("Handoff route parser and model selection cover escalation rules", () => {
  const escalated = parseHandoffRoute("## Objective\n- Fix it.\n\nHARNESS-ROUTE: progress=stalled next=investigate\n")
  const ordinary = parseHandoffRoute("HARNESS-ROUTE: progress=advancing next=concrete")
  assert.deepEqual(escalated, { progress: "stalled", next: "investigate" })
  assert.deepEqual(ordinary, { progress: "advancing", next: "concrete" })
  assert.equal(parseHandoffRoute("HARNESS-ROUTE: maybe cause=unknown leads=no next=investigate"), null)
  assert.equal(parseHandoffRoute("HARNESS-ROUTE: pro cause=unknown"), null)
  assert.equal(parseHandoffRoute("No marker"), null)
  assert.equal(parseHandoffRoute("HARNESS-ROUTE: progress=maybe next=investigate"), null)
  assert.equal(parseHandoffRoute("HARNESS-ROUTE: progress=stalled next=investigate\nQuoted example, not a final marker."), null)
  assert.equal(stripHandoffRoute("## Objective\n- Fix it.\n\nHARNESS-ROUTE: pro cause=unknown leads=no next=investigate\n"), "## Objective\n- Fix it.")
  const flash = { providerID: "deepseek", id: "deepseek-flash" }
  const pro = { providerID: "deepseek", id: "deepseek-v4-pro" }
  for (const route of [
    { progress: "stalled", next: "concrete" },
    escalated
  ]) assert.equal(resolveHandoffModel(flash, route, null).id, "deepseek-v4-pro")
  assert.equal(resolveHandoffModel(flash, ordinary, null).id, "deepseek-flash")
  for (const route of [
    { progress: "advancing", next: "investigate" },
    { progress: "advancing", next: "done" },
    { progress: "stalled", next: "done" }
  ]) assert.equal(resolveHandoffModel(flash, route, null).id, "deepseek-flash")
  assert.equal(resolveHandoffModel(flash, null, null).id, "deepseek-flash")
  assert.equal(resolveHandoffModel(pro, ordinary, null).id, "deepseek-v4-pro")
  assert.equal(resolveHandoffModel(pro, null, "flash").id, "deepseek-flash")
  assert.equal(resolveHandoffModel(flash, ordinary, "pro").id, "deepseek-v4-pro")
})

test("Handoff escalates stalled DeepSeek investigation to Pro", async (t) => {
  const f = fixture(t)
  const source = await f.context.session.get()
  f.context.session.get = async () => ({ ...source, model: { providerID: "deepseek", id: "deepseek-flash" } })
  f.context.session.generate = async () => ({ text: "## Objective\n- Fix the bug.\n\nHARNESS-ROUTE: progress=stalled next=investigate\n" })
  await registerHandoff(f.context)
  await f.run()

  assert.equal(f.created[0].model.id, "deepseek-v4-pro")
  assert.doesNotMatch(f.prompts[0].text, /HARNESS-ROUTE/)
  assert.match(fs.readFileSync(path.join(f.directory, "HANDOFF.md"), "utf8"), /Fix the bug/)
})

test("Handoff keeps Flash for an ordinary DeepSeek task and honors --route", async (t) => {
  const f = fixture(t)
  const source = await f.context.session.get()
  f.context.session.get = async () => ({ ...source, model: { providerID: "deepseek", id: "deepseek-flash" } })
  f.context.session.generate = async () => ({ text: "## Objective\n- Continue the plan.\n\nHARNESS-ROUTE: progress=advancing next=concrete\n" })
  await registerHandoff(f.context)
  await f.run()
  assert.equal(f.created[0].model.id, "deepseek-flash")

  const second = fixture(t)
  second.context.session.get = async () => ({ ...source, model: { providerID: "deepseek", id: "deepseek-flash" } })
  second.context.session.generate = async () => ({ text: "## Objective\n- Continue the plan.\n\nHARNESS-ROUTE: progress=advancing next=concrete\n" })
  await registerHandoff(second.context)
  await second.run("--route=pro")
  assert.equal(second.created[0].model.id, "deepseek-v4-pro")
})

test("stalled completed Flash turns transfer once to Pro before another attempt", async (t) => {
  const f = fixture(t)
  f.context.location = { directory: f.directory }
  f.context.session.get = async () => ({ location: f.context.location, agent: "build", model: { providerID: "deepseek", id: "deepseek-flash" } })
  f.context.session.context = async () => [{ type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "Checked A and B without progress.\nHARNESS-ROUTE: progress=stalled next=investigate" }] }, { type: "idle", outcome: "succeeded" }]
  f.context.session.generate = async () => ({ text: "Checked A and B. Continue investigation." })
  const handoff = await registerHandoff(f.context)
  await escalateStalledSession(f.context, "source", handoff)
  await escalateStalledSession(f.context, "source", handoff)
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].model.id, "deepseek-v4-pro")
  assert.equal(f.prompts.length, 1)
})

test("automatic escalation ignores advancing, completed, failed and unrelated sessions", async (t) => {
  const f = fixture(t)
  f.context.location = { directory: f.directory }
  const source = { location: f.context.location, agent: "build", model: { providerID: "deepseek", id: "deepseek-flash" } }
  const stalled = { type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "HARNESS-ROUTE: progress=stalled next=investigate" }] }
  let info = source
  let last = stalled
  f.context.session.get = async () => info
  f.context.session.context = async () => [last]
  let transfers = 0
  const handoff = async () => { transfers++ }
  for (const patch of [
    { parentID: "parent" }, { agent: "ask" },
    { location: { directory: "/another-project" } },
    { model: { providerID: "deepseek", id: "deepseek-v4-pro" } },
    { model: { providerID: "fixture", id: "deepseek-flash" } }
  ]) {
    info = { ...source, ...patch }
    await escalateStalledSession(f.context, "source", handoff)
  }
  info = source
  for (const message of [
    { ...stalled, time: {} }, { ...stalled, error: { message: "failed" } },
    { ...stalled, type: "user" },
    { ...stalled, content: [{ type: "text", text: "HARNESS-ROUTE: progress=advancing next=investigate" }] },
    { ...stalled, content: [{ type: "text", text: "HARNESS-ROUTE: progress=stalled next=done" }] }
  ]) {
    last = message
    await escalateStalledSession(f.context, "source", handoff)
  }
  assert.equal(transfers, 0)
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
