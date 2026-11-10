import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { injectDigests, registerLoopGuard } from "../../opencode/loop-guard.mjs"

const digest = "a".repeat(64)
const otherDigest = "b".repeat(64)

async function fixture(
  t,
  referenceText = [
    "Saved task context: .opencode/task-context/aa.json",
    "Cached ranges: source.mjs:2-3",
    "Resume the next unfinished step. Do not rebuild the plan."
  ].join("\n"),
  { outputDir } = {}
) {
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
  const guard = await registerLoopGuard(
    context,
    taskContext,
    outputDir === undefined ? {} : { outputDir }
  )
  let callCount = 0
  const after = (
    tool,
    input,
    result = {},
    sessionID = "session",
    status = "completed",
    id = `call-${++callCount}`
  ) =>
    toolHooks.get("execute.after")({
      tool,
      sessionID,
      agent: "build",
      messageID: "message",
      id,
      input,
      status,
      ...(status === "completed" ? { result } : { error: result })
    })
  const notice = (result) =>
    Array.isArray(result.content)
      ? result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : ""
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
    guard,
    notice,
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

test("read budget warns at 20 reads and again at 40 without changing the tool list", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })
  const soft = {}
  await f.after("read", { file: "a19.mjs" }, soft)
  assert.match(f.notice(soft), /20 read calls since the last file change/)

  const warning = await f.contextHook()
  assert.equal(warning.system.length, 0)
  assert.ok(warning.tools.execute)

  for (let i = 20; i < 39; i++) await f.after("read", { file: `a${i}.mjs` })
  const thirtyNine = await f.contextHook()
  assert.ok(thirtyNine.tools.edit)
  assert.ok(thirtyNine.tools.execute)
  assert.ok(thirtyNine.tools.read)
  assert.ok(thirtyNine.tools.shell)

  const hard = {}
  await f.after("read", { file: "a39.mjs" }, hard)
  assert.match(f.notice(hard), /read budget is exhausted/)
  const forty = await f.contextHook()
  for (const name of ["read", "grep", "glob", "skill", "shell", "execute", "edit"])
    assert.ok(forty.tools[name], `${name} must stay listed to keep the cached prefix`)
  assert.equal(forty.system.length, 0)

  await f.after("edit", { file: "a.mjs" })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.execute)
  assert.ok(resumed.tools.read)
  assert.ok(resumed.tools.shell)
  assert.equal(resumed.system.length, 0)
})

test("hard read budget keeps the Code Mode execute gateway in the request", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 39; i++) await f.after("read", { file: `a${i}.mjs` })
  const hard = {}
  await f.after("read", { file: "a39.mjs" }, hard)

  const event = await f.contextHook()
  assert.ok(
    event.tools.execute,
    "execute must stay available because Code Mode is the only MCP gateway"
  )
  assert.match(f.notice(hard), /Do not start another read or shell command/)
  assert.ok(event.tools.shell)

  await f.after("execute", {
    code: 'await tools.tokensave.tokensave_read({ file: "a.mjs", mode: "lines", lines: "1-2" })'
  })
  const afterExecuteRead = await f.contextHook()
  assert.ok(
    afterExecuteRead.tools.execute,
    "reading through execute must not remove the gateway"
  )
})

test("shell commands consume the read budget and reach the stop level", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 19; i++) await f.after("shell", { command: `echo ${i}` })
  const quiet = await f.contextHook()
  assert.equal(quiet.system.length, 0)
  assert.ok(quiet.tools.shell)
  assert.ok(quiet.tools.read)

  const soft = {}
  await f.after("shell", { command: "npm test" }, soft)
  assert.match(f.notice(soft), /20 read calls since the last file change/)

  for (let i = 20; i < 60; i++) await f.after("shell", { command: `npm run ${i}` })
  const stop = await f.contextHook()
  assert.deepEqual(stop.tools, {})

  await f.after("execute", {
    code: 'await tools.tokensave.tokensave_multi_str_replace({ path: "a.mjs", replacements: [] })'
  })
  const reset = await f.contextHook()
  assert.equal(reset.system.length, 0)
  assert.ok(reset.tools.execute)
  assert.ok(reset.tools.shell)
})

test("stop level withdraws every tool after 60 reads without an edit", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 59; i++) await f.after("read", { file: `a${i}.mjs` })
  const stop = {}
  await f.after("read", { file: "a59.mjs" }, stop)
  assert.match(f.notice(stop), /all tools are withdrawn for this turn/)

  const event = await f.contextHook()
  assert.deepEqual(event.tools, {})
  assert.equal(event.system.length, 0)

  await f.after("edit", { file: "a.mjs" })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.read)
  assert.ok(resumed.tools.execute)
})

test("a repeated identical call points at the earlier tool call", async t => {
  const f = await fixture(t)
  const first = {}
  await f.after("read", { file: "a.mjs" }, first, "session", "completed", "call-1")
  assert.equal(f.notice(first), "")
  const second = {}
  await f.after("read", { file: "a.mjs" }, second, "session", "completed", "call-2")
  assert.match(f.notice(second), /already ran as tool call call-1/)
})

test("large tool results keep a bounded prefix, an artifact and the guard notice", async t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-output-bounds-"))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const f = await fixture(t, undefined, { outputDir })
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })

  const text = "output line\n".repeat(4000)
  const result = { output: text }
  await f.after("shell", { command: "npm test" }, result)
  const kept = result.content.map((part) => part.text).join("")
  assert.ok(Buffer.byteLength(kept) <= 20 * 1024 + 1024)
  assert.match(kept, /20 read calls since the last file change/)
  const marker = /full_result=([^;]+); bytes=(\d+);/.exec(kept)
  assert.ok(marker, "the bounded result must name its artifact")
  assert.equal(Number(marker[2]), Buffer.byteLength(text))
  assert.equal(fs.statSync(marker[1]).mode & 0o777, 0o600)
  assert.equal(
    JSON.parse(fs.readFileSync(marker[1], "utf8")).content[0].text,
    text
  )
  assert.ok(result.output.includes("full_result="))
  assert.ok(Buffer.byteLength(result.output) <= 20 * 1024)

  const withSummary = {
    content: [{ type: "text", text }],
    output: "Read 4000 lines"
  }
  await f.after("read", { file: "big.mjs" }, withSummary)
  assert.match(f.notice(withSummary), /full_result=.*harness_read_result/)
  assert.equal(withSummary.output, "Read 4000 lines")

  const small = { content: [{ type: "text", text: "short" }] }
  await f.after("read", { file: "small.mjs" }, small)
  assert.equal(small.content[0].text, "short")

  const json = { content: [{ type: "text", text: JSON.stringify({ rows: "a".repeat(30000) }) }] }
  await f.after("execute", { code: "return rows" }, json)
  assert.match(f.notice(json), /full_result=.*harness_read_result/)
})

test("a finished turn resets the read budget for the next user message", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })
  const soft = {}
  await f.after("read", { file: "a19.mjs" }, soft)
  assert.match(f.notice(soft), /20 read calls since the last file change/)

  for (let i = 20; i < 60; i++) await f.after("read", { file: `a${i}.mjs` })
  const blocked = await f.contextHook()
  assert.deepEqual(blocked.tools, {})

  f.guard.finishTurn("session")
  const fresh = await f.contextHook()
  assert.ok(fresh.tools.shell)
  assert.ok(fresh.tools.read)
  assert.equal(fresh.system.length, 0)

  for (let i = 0; i < 40; i++) await f.after("read", { file: `b${i}.mjs` })
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.shell)
  assert.match(resumed.messages[0].content[0].text, /Harness resume after compaction/)
  assert.doesNotMatch(JSON.stringify(resumed.messages), /progress guard/)
})

test("plan mode and sessions without edit tools are never blocked", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 60; i++) await f.after("read", { file: `a${i}.mjs` })

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
  const resume = first.messages.at(-1).content[0].text
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
  const resume = event.messages[0].content[0].text
  assert.match(resume, /No cached task ranges\. Do not rebuild the plan/)
  assert.match(
    resume,
    /Resume protocol: make the first source edit within 12 tool calls/
  )
  assert.equal((resume.match(/Do not rebuild the plan/g) ?? []).length, 1)
})
