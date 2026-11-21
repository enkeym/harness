import assert from "node:assert/strict"
import { test } from "node:test"
import {
  NOTICE,
  emptyCompletion,
  registerEmptyResponseGuard
} from "../../opencode/empty-response.mjs"

const user = (id, text) => ({ id, type: "user", text })
const say = (id, text) => ({
  id,
  type: "assistant",
  finish: "stop",
  content: [{ type: "text", text }]
})
const reasoning = (id, text = "ganti日十全）**） -.1 buttons-- -") => ({
  id,
  type: "assistant",
  finish: "stop",
  content: [{ type: "reasoning", text }]
})
const tool = (id, name = "read") => ({
  id,
  type: "assistant",
  finish: "tool-calls",
  content: [{ type: "tool", id: `t-${name}`, name, state: { status: "completed" } }]
})

function fixture(messages) {
  const notices = []
  let current = messages
  const context = {
    session: {
      context: async () => current,
      synthetic: async ({ sessionID, text }) => notices.push({ sessionID, text })
    }
  }
  return {
    context,
    notices,
    set(next) {
      current = next
    }
  }
}

test("a reply with text is answered", () => {
  assert.equal(emptyCompletion([user("u1", "x"), say("a1", "Готово.")]), null)
  assert.equal(emptyCompletion([user("u1", "x"), say("a1", "  \n ")]), "a1")
})

test("a tool call is not an empty reply", () => {
  assert.equal(emptyCompletion([user("u1", "x"), tool("a1")]), null)
})

test("a reasoning-only stop is an empty reply", () => {
  assert.equal(emptyCompletion([user("u1", "x"), reasoning("a1")]), "a1")
})

test("only a finished assistant reply counts", () => {
  assert.equal(emptyCompletion([user("u1", "x")]), null)
  assert.equal(
    emptyCompletion([user("u1", "x"), { ...reasoning("a1"), finish: "error" }]),
    null
  )
  assert.equal(
    emptyCompletion([user("u1", "x"), { ...reasoning("a1"), error: "boom" }]),
    null
  )
})

test("a truncated length finish is not retried even without text", () => {
  const partial = { ...say("a1", "Partial answer"), finish: "length" }
  const empty = { ...reasoning("a2"), finish: "length" }
  assert.equal(emptyCompletion([user("u1", "x"), partial]), null)
  assert.equal(emptyCompletion([user("u1", "x"), empty]), null)
})

test("an empty reply gets one continuation notice", async () => {
  const f = fixture([user("u1", "x"), reasoning("a1")])
  const guard = await registerEmptyResponseGuard(f.context)
  assert.equal(await guard.check("ses_1", { id: "ses_1" }), "a1")
  assert.deepEqual(f.notices, [{ sessionID: "ses_1", text: NOTICE }])
})

test("the same empty reply is not retried twice", async () => {
  const f = fixture([user("u1", "x"), reasoning("a1")])
  const guard = await registerEmptyResponseGuard(f.context)
  await guard.check("ses_1", { id: "ses_1" })
  assert.equal(await guard.check("ses_1", { id: "ses_1" }), null)
  assert.equal(f.notices.length, 1)
})

test("a later empty reply is retried once the session answers", async () => {
  const f = fixture([user("u1", "x"), reasoning("a1")])
  const guard = await registerEmptyResponseGuard(f.context)
  await guard.check("ses_1", { id: "ses_1" })
  f.set([user("u1", "x"), reasoning("a1"), user("u2", "continue"), say("a2", "Готово.")])
  assert.equal(await guard.check("ses_1", { id: "ses_1" }), null)
  f.set([user("u1", "x"), reasoning("a1"), user("u2", "continue"), say("a2", "ok"), user("u3", "ещё"), reasoning("a3")])
  assert.equal(await guard.check("ses_1", { id: "ses_1" }), "a3")
  assert.equal(f.notices.length, 2)
})

test("subagent sessions are left alone", async () => {
  const f = fixture([user("u1", "x"), reasoning("a1")])
  const guard = await registerEmptyResponseGuard(f.context)
  assert.equal(await guard.check("ses_1", { id: "ses_1", parentID: "ses_0" }), null)
  assert.equal(f.notices.length, 0)
})
