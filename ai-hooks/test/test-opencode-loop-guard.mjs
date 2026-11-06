import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { injectDigests, registerLoopGuard } from "../../opencode/loop-guard.mjs"

const digest = "a".repeat(64)
const otherDigest = "b".repeat(64)

async function fixture(t, referenceText = [
  "Saved task context: .opencode/task-context/aa.json",
  "Cached ranges: source.mjs:2-3",
  "Resume the next unfinished step. Do not rebuild the plan."
].join("\n")) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-loop-guard-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sessionHooks = new Map()
  const toolHooks = new Map()
  const references = []
  const context = {
    location: { directory },
    session: { hook: async (name, hook) => sessionHooks.set(name, hook) },
    tool: { hook: async (name, hook) => toolHooks.set(name, hook) }
  }
  const taskContext = {
    reference: async (sessionID, includeCheckpoint) => {
      references.push({ sessionID, includeCheckpoint })
      return referenceText
    }
  }
  await registerLoopGuard(context, taskContext)
  const after = (
    tool,
    input,
    result = {},
    sessionID = "session",
    status = "completed"
  ) =>
    toolHooks.get("execute.after")({
      tool,
      sessionID,
      agent: "build",
      messageID: "message",
      id: "call",
      input,
      status,
      ...(status === "completed" ? { result } : { error: result })
    })
  const before = (tool, input, sessionID = "session") =>
    toolHooks.get("execute.before")({
      tool,
      sessionID,
      agent: "build",
      messageID: "message",
      id: "call",
      input
    })
  const contextHook = async (options = {}) => {
    const event = {
      sessionID: "session",
      agent: "build",
      system: [],
      messages: [],
      options: {},
      tools: {
        edit: {},
        write: {},
        read: {},
        grep: {},
        glob: {},
        skill: {},
        shell: {},
        execute: {}
      },
      ...options
    }
    await sessionHooks.get("context")(event)
    return event
  }
  return {
    after,
    before,
    contextHook,
    sessionHooks,
    directory,
    references
  }
}

test("digest injection only rewrites literal full reads with a known digest", () => {
  const digests = new Map([
    ["source.mjs", digest],
    ["other.mjs", otherDigest]
  ])

  assert.equal(
    injectDigests('tokensave_read({ file: "source.mjs", mode: "full" })', digests)
      .code,
    `tokensave_read({ if_digest: "${digest}", file: "source.mjs", mode: "full" })`
  )
  assert.equal(
    injectDigests('tokensave_read({ file: "source.mjs" })', digests).changed,
    1
  )
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "lines", lines: "2-3" })',
      digests
    ).changed,
    0
  )
  assert.equal(
    injectDigests(
      `tokensave_read({ if_digest: "${digest}", file: "source.mjs" })`,
      digests
    ).changed,
    0
  )
  assert.equal(
    injectDigests('tokensave_read({ file: "missing.mjs", mode: "full" })', digests)
      .changed,
    0
  )
  assert.equal(
    injectDigests('tokensave_read({ file: target, mode: "full" })', digests)
      .changed,
    0
  )
})

test("after hook collects full-read digests from text and JSON results only", async t => {
  const f = await fixture(t)
  const full = `file: source.mjs\nmode: full\ndigest: ${digest}\n\n     1\tfirst\n`
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "source.mjs", mode: "full" })' },
    { content: [{ type: "text", text: full }] }
  )
  const json = JSON.stringify({
    file: "second.mjs",
    mode: "full",
    digest: otherDigest,
    body: "     1\tsecond\n"
  })
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "second.mjs", mode: "full" })' },
    { content: [{ type: "text", text: json }] }
  )
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "stub.mjs", mode: "full" })' },
    {
      content: [
        {
          type: "text",
          text: `file: stub.mjs\nmode: full\ndigest: ${"c".repeat(64)}\n\n[unchanged: true]`
        }
      ]
    }
  )
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "artifact.mjs", mode: "full" })' },
    {
      content: [
        {
          type: "text",
          text: `file: artifact.mjs\nmode: full\ndigest: ${"d".repeat(64)}\n\n     1\tfirst\n[full_result=/tmp/truncated]`
        }
      ]
    }
  )
  await f.after("shell", { command: "ls" }, { content: "plain output" })

  const injected = { code: 'tokensave_read({ file: "source.mjs", mode: "full" })' }
  await f.before("execute", injected)
  assert.match(injected.code, new RegExp(`if_digest: "${digest}"`))
  const fromJSON = { code: 'tokensave_read({ file: "second.mjs", mode: "full" })' }
  await f.before("execute", fromJSON)
  assert.match(fromJSON.code, new RegExp(`if_digest: "${otherDigest}"`))
  for (const file of ["stub.mjs", "artifact.mjs"]) {
    const input = { code: `tokensave_read({ file: "${file}", mode: "full" })` }
    await f.before("execute", input)
    assert.doesNotMatch(input.code, /if_digest/)
  }
  const untouched = { code: "console.log(1)" }
  await f.before("execute", untouched)
  assert.equal(untouched.code, "console.log(1)")
  const lines = {
    code: 'tokensave_read({ file: "source.mjs", mode: "lines", lines: "1-2" })'
  }
  await f.before("execute", lines)
  assert.doesNotMatch(lines.code, /if_digest/)
})

test("read budget warns at 20 reads and disables read tools at 40", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 20; i++) await f.after("read", { file: "a.mjs" })

  const warning = await f.contextHook()
  assert.equal(warning.system.length, 1)
  assert.match(warning.system[0].text, /20 read calls since the last file change/)
  assert.ok(warning.tools.execute)

  for (let i = 0; i < 19; i++) await f.after("read", { file: "a.mjs" })
  const thirtyNine = await f.contextHook()
  assert.ok(thirtyNine.tools.edit)
  assert.ok(thirtyNine.tools.execute)
  assert.ok(thirtyNine.tools.read)

  await f.after("read", { file: "a.mjs" })
  const forty = await f.contextHook()
  assert.match(forty.system.at(-1).text, /40 read calls without a file change/)
  for (const name of ["execute", "shell", "read", "grep", "glob", "skill"])
    assert.equal(forty.tools[name], undefined)
  assert.ok(forty.tools.edit)

  await f.after("edit", { file: "a.mjs" })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.execute)
  assert.ok(resumed.tools.read)
  assert.equal(resumed.system.length, 0)
})

test("shell reads count and execute edits reset the budget", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 21; i++) await f.after("shell", { command: "ls" })
  const warned = await f.contextHook()
  assert.match(warned.system[0].text, /21 read calls since the last file change/)

  await f.after("execute", {
    code: 'await tools.tokensave.tokensave_multi_str_replace({ path: "a.mjs", replacements: [] })'
  })
  const reset = await f.contextHook()
  assert.equal(reset.system.length, 0)
  assert.ok(reset.tools.execute)
})

test("plan mode and sessions without edit tools are never blocked", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 40; i++) await f.after("read", { file: "a.mjs" })

  const plan = await f.contextHook({ agent: "plan" })
  assert.ok(plan.tools.read)
  assert.ok(plan.tools.execute)
  assert.equal(plan.system.length, 0)

  const readOnly = await f.contextHook({ tools: { read: {}, execute: {} } })
  assert.ok(readOnly.tools.read)
  assert.ok(readOnly.tools.execute)
  assert.equal(readOnly.system.length, 0)
})

test("compaction resumes once with cached ranges, skills and the edit budget", async t => {
  const f = await fixture(t)
  await f.after("skill", { id: "react-frontend" })
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })

  const first = await f.contextHook()
  const resume = first.system[0].text
  assert.match(resume, /Harness resume after compaction:/)
  assert.match(resume, /Saved task context/)
  assert.match(resume, /Cached ranges: source\.mjs:2-3/)
  assert.match(resume, /Active skills before compaction: react-frontend/)
  assert.match(
    resume,
    /Resume protocol: make the first source edit within 12 tool calls/
  )
  assert.equal((resume.match(/Do not rebuild the plan/g) ?? []).length, 1)
  assert.equal(f.references.length, 1)
  assert.equal(f.references[0].includeCheckpoint, false)

  const second = await f.contextHook()
  assert.equal(second.system.length, 0)
  assert.equal(f.references.length, 1)
})

test("compaction without cached ranges states the resume protocol once", async t => {
  const f = await fixture(t, "")
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })

  const event = await f.contextHook()
  const resume = event.system[0].text
  assert.match(resume, /No cached task ranges\. Do not rebuild the plan/)
  assert.match(
    resume,
    /Resume protocol: make the first source edit within 12 tool calls/
  )
  assert.equal((resume.match(/Do not rebuild the plan/g) ?? []).length, 1)
})
