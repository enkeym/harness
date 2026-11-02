import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerHandoff } from "../../opencode/handoff.mjs"

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
  return { context, events, created, prompts, run: () => execute({ sessionID: "source", prompt: { text: "" } }) }
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
    if (!failure) assert.equal(f.created[0].model.id, "deepseek-flash")
  })
}

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
