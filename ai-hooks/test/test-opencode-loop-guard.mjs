import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { digestKey, injectDigests, registerLoopGuard } from "../../opencode/loop-guard.mjs"

const digest = "a".repeat(64)
const otherDigest = "b".repeat(64)

async function fixture(
  t,
  referenceText = [
    "Cached context: .opencode/context-cache/aa.json",
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
  const contextCache = {
    reference: async (sessionID) => {
      references.push({ sessionID })
      return referenceText
    }
  }
  const guard = await registerLoopGuard(
    context,
    contextCache,
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
    [digestKey(undefined, "source.mjs"), digest],
    [digestKey(undefined, "other.mjs"), otherDigest]
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
  const projectDigests = new Map([
    [digestKey("/project", "source.mjs"), digest]
  ])
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "full", graph_root: "/other" })',
      projectDigests,
      "/project"
    ).changed,
    0,
    "a digest never follows the file name into another root"
  )
  const sameRoot = injectDigests(
    'tokensave_read({ file: "source.mjs", mode: "full", graph_root: "/project/" })',
    projectDigests,
    "/project"
  )
  assert.equal(sameRoot.changed, 1, "the canonical root may reuse the digest")
  assert.match(sameRoot.code, new RegExp(`if_digest: "${digest}"`))
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "full" })',
      projectDigests,
      "/moved"
    ).changed,
    0,
    "a digest from the previous root is not reused after the session moves"
  )
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "full", graph_root: root })',
      digests,
      "/project"
    ).changed,
    0,
    "a computed graph_root cannot prove the project"
  )
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "full", graph_root: "/project" + suffix })',
      digests,
      "/project"
    ).changed,
    0,
    "a concatenated graph_root cannot prove the project"
  )
  assert.equal(
    injectDigests(
      'tokensave_read({ file: "source.mjs", mode: "full", force: true })',
      digests
    ).changed,
    0,
    "an explicit force is not overridden"
  )
})

test("a digest read through another graph_root is not reused for this project", async t => {
  const f = await fixture(t)
  const metrics = "\n\ntokensave_metrics: before=10 after=10 result=10 saved=0"
  await f.after(
    "execute",
    {
      code: 'tokensave_read({ graph_root: "/other", file: "source.mjs", mode: "full" })'
    },
    {
      content: [
        {
          type: "text",
          text: `file: source.mjs\nmode: full\ndigest: ${digest}\n\n     1\tfirst\n${metrics}`
        }
      ]
    }
  )
  const foreign = { code: 'tokensave_read({ file: "source.mjs", mode: "full" })' }
  await f.before("execute", foreign)
  assert.doesNotMatch(foreign.code, /if_digest/)

  await f.after(
    "execute",
    {
      code: `tokensave_read({ graph_root: "${f.directory}", file: "canon.mjs", mode: "full" })`
    },
    {
      content: [
        {
          type: "text",
          text: `file: canon.mjs\nmode: full\ndigest: ${otherDigest}\n\n     1\tfirst\n${metrics}`
        }
      ]
    }
  )
  const canonical = {
    code: `tokensave_read({ graph_root: "${f.directory}", file: "canon.mjs", mode: "full" })`
  }
  await f.before("execute", canonical)
  assert.match(canonical.code, new RegExp(`if_digest: "${otherDigest}"`))
})

test("after hook collects full-read digests from text and JSON results only", async t => {
  const f = await fixture(t)
  const full = `file: source.mjs\nmode: full\ndigest: ${digest}\n\n     1\tfirst\n\ntokensave_metrics: before=10 after=10 result=10 saved=0`
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
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "external.mjs", mode: "full" })' },
    {
      content: [
        {
          type: "text",
          text: `file: external.mjs\nmode: full\ndigest: ${"e".repeat(64)}\n\n     1\tfirst\n`
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
  for (const file of ["stub.mjs", "artifact.mjs", "external.mjs"]) {
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

test("compaction drops collected digests so stale bodies are not reused", async t => {
  const f = await fixture(t)
  const full = `file: source.mjs\nmode: full\ndigest: ${digest}\n\n     1\tfirst\n\ntokensave_metrics: before=10 after=10 result=10 saved=0`
  await f.after(
    "execute",
    { code: 'tokensave_read({ file: "source.mjs", mode: "full" })' },
    { content: [{ type: "text", text: full }] }
  )
  const before = { code: 'tokensave_read({ file: "source.mjs", mode: "full" })' }
  await f.before("execute", before)
  assert.match(before.code, new RegExp(`if_digest: "${digest}"`))

  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })
  const afterCompaction = {
    code: 'tokensave_read({ file: "source.mjs", mode: "full" })'
  }
  await f.before("execute", afterCompaction)
  assert.doesNotMatch(
    afterCompaction.code,
    /if_digest/,
    "the model no longer sees the old body, so the digest must not be injected"
  )
})

test("compaction treats the next phase as unknown instead of repeating the previous edit", async t => {
  const f = await fixture(t)
  await f.after("edit", { file: "source.mjs" })
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })
  const resumed = await f.contextHook()
  const resume = resumed.messages.at(-1).content[0].text
  assert.match(resume, /next unfinished step/)
  assert.doesNotMatch(resume, /make the first source edit/)

  for (let i = 0; i < 41; i++) await f.after("read", { file: `r${i}.mjs` })
  const after = await f.contextHook()
  assert.ok(after.tools.execute, "an unknown phase must not withdraw tools")
  assert.ok(after.tools.edit, "an unknown phase must not withdraw tools")
})

test("read budget warns at 20 reads and again at 40 without changing the tool list", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })
  const soft = {}
  await f.after("read", { file: "a19.mjs" }, soft)
  assert.match(f.notice(soft), /20 read calls without a file change/)

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

test("verification, planning and discovery calls do not consume the read budget", async t => {
  const f = await fixture(t)
  const bigLog = { output: "ok\n".repeat(4000) }
  await f.after("shell", { command: "node --test --test-concurrency=1 ai-hooks/test/test-a.mjs" }, bigLog)
  await f.after("shell", { command: "npm test" })
  await f.after("shell", { command: "bash install.sh --check" })
  await f.after("execute", { code: "await tools.brief_transition({ stage: \"plan\", handoff: \"h\" })" })
  await f.after("execute", { code: "const r = await search({ query: \"playwright browser\" }); return r" })
  for (let i = 0; i < 16; i++) await f.after("read", { file: `a${i}.mjs` })
  const quiet = {}
  await f.after("read", { file: "a16.mjs" }, quiet)
  assert.equal(f.notice(quiet), "", "17 real reads after 5 verification calls stay below the soft level")

  const repeatedTest = {}
  await f.after("shell", { command: "npm test" }, repeatedTest, "session", "completed", "call-x")
  assert.match(
    f.notice(repeatedTest),
    /already ran as tool call call-\d+/,
    "an identical repeated verification run is still a proven repeat"
  )

  const gatheringExecute = {}
  await f.after(
    "execute",
    { code: 'return await tools.tokensave.tokensave_read({ file: "a.mjs", mode: "full" })' },
    gatheringExecute
  )
  await f.after("read", { file: "a17.mjs" })
  const soft = {}
  await f.after("read", { file: "a18.mjs" }, soft)
  assert.match(
    f.notice(soft),
    /20 read calls without a file change/,
    "an execute that reads sources counts toward the budget"
  )
})

test("read-only audit in build gets advisory notices and keeps every tool", async t => {
  const f = await fixture(t)
  const soft = {}
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })
  await f.after("read", { file: "a19.mjs" }, soft)
  assert.match(f.notice(soft), /20 read calls without a file change/)
  assert.doesNotMatch(f.notice(soft), /Make the first edit/)

  const hard = {}
  for (let i = 20; i < 39; i++) await f.after("read", { file: `a${i}.mjs` })
  await f.after("read", { file: "a39.mjs" }, hard)
  assert.match(f.notice(hard), /read budget is exhausted/)
  assert.doesNotMatch(f.notice(hard), /Make the edit named in the plan/)

  const stop = {}
  for (let i = 40; i < 59; i++) await f.after("read", { file: `a${i}.mjs` })
  await f.after("read", { file: "a59.mjs" }, stop)
  assert.match(f.notice(stop), /exceeded the read budget without a file change/)
  assert.match(f.notice(stop), /Verification tools stay available/)

  const event = await f.contextHook()
  for (const name of ["read", "grep", "glob", "skill", "shell", "execute", "edit"])
    assert.ok(event.tools[name], `${name} must stay available in an unknown phase`)
})

test("stop level withdraws every tool only in a proven implementation", async t => {
  const f = await fixture(t)
  await f.after("edit", { file: "a.mjs" })
  for (let i = 0; i < 59; i++) await f.after("read", { file: `a${i}.mjs` })
  const stop = {}
  await f.after("read", { file: "a59.mjs" }, stop)
  assert.match(f.notice(stop), /all tools are withdrawn for this turn/)

  const event = await f.contextHook()
  assert.deepEqual(event.tools, {})
  assert.equal(event.system.length, 0)

  await f.after("execute", {
    code: 'await tools.tokensave.tokensave_multi_str_replace({ path: "a.mjs", replacements: [] })'
  })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.read)
  assert.ok(resumed.tools.execute)
})

test("a failed edit neither resets the budget nor authorizes withdrawal", async t => {
  const f = await fixture(t)
  for (let i = 0; i < 19; i++) await f.after("read", { file: `a${i}.mjs` })
  await f.after("edit", { file: "a.mjs" }, { message: "oldString not found" }, "session", "error")
  const twentieth = {}
  await f.after("read", { file: "a19.mjs" }, twentieth)
  assert.match(
    f.notice(twentieth),
    /20 read calls without a file change/,
    "the failed edit did not reset the counter"
  )
  assert.doesNotMatch(f.notice(twentieth), /Make the first edit/)

  for (let i = 20; i < 60; i++) await f.after("read", { file: `a${i}.mjs` })
  const event = await f.contextHook()
  assert.ok(event.tools.read, "unknown phase keeps verification tools after a failed edit")
  assert.ok(event.tools.execute)
})

test("different ranges, corrected arguments and read batches are not repeats", async t => {
  const f = await fixture(t)
  const rangeA = {}
  await f.after("execute", { code: 'tokensave_read({ file: "a.mjs", mode: "lines", lines: "1-2" })' }, rangeA)
  assert.equal(f.notice(rangeA), "")
  const rangeB = {}
  await f.after("execute", { code: 'tokensave_read({ file: "a.mjs", mode: "lines", lines: "3-4" })' }, rangeB)
  assert.equal(f.notice(rangeB), "", "another range of the same file is new material")

  await f.after("execute", { code: "tokensave_read({ file: \"a.mjs\", lines: \"bad\" })" }, {}, "session", "error", "call-bad")
  const corrected = {}
  await f.after("execute", { code: 'tokensave_read({ file: "a.mjs", lines: "5-6" })' }, corrected, "session", "completed", "call-fixed")
  assert.equal(f.notice(corrected), "", "a corrected argument after a failure is not a repeat")

  const batch = {
    code: 'await Promise.all([tokensave_read({ file: "x.mjs", mode: "lines", lines: "1-2" }), tokensave_read({ file: "y.mjs", mode: "lines", lines: "1-2" })])'
  }
  const batchFirst = {}
  await f.after("execute", batch, batchFirst, "session", "completed", "call-batch-1")
  assert.equal(f.notice(batchFirst), "", "a batch of independent reads is one budget step and no repeat")
  const batchSecond = {}
  await f.after("execute", batch, batchSecond, "session", "completed", "call-batch-2")
  assert.match(f.notice(batchSecond), /already ran as tool call call-batch-1/, "the identical batch repeated is a proven repeat")
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
  await f.after("shell", { command: "cat big.log" }, result)
  const kept = result.content.map((part) => part.text).join("")
  assert.ok(Buffer.byteLength(kept) <= 20 * 1024 + 1024)
  assert.match(kept, /20 read calls without a file change/)
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

  const skillResult = { content: [{ type: "text", text: "skill doc\n".repeat(900) }] }
  await f.after("skill", { id: "optimize" }, skillResult)
  const skillText = skillResult.content.map((part) => part.text).join("")
  assert.match(skillText, /full_result=.*harness_read_result/)
  assert.ok(Buffer.byteLength(skillText) <= 6 * 1024)
})

test("an explicit full artifact read passes the execute bound up to the hard ceiling", async t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-output-bounds-"))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const f = await fixture(t, undefined, { outputDir })

  const text = "я".repeat(10000)
  const within = { content: [{ type: "text", text: JSON.stringify({ harnessArtifact: true, full: true, text }) }] }
  await f.after("execute", { code: "return artifactWithin" }, within)
  assert.equal(
    within.content[0].text,
    JSON.stringify({ harnessArtifact: true, full: true, text }),
    "a full artifact reply within the ceiling is not re-bounded"
  )

  const huge = "y".repeat(25 * 1024)
  const over = { content: [{ type: "text", text: JSON.stringify({ harnessArtifact: true, full: true, text: huge }) }] }
  await f.after("execute", { code: "return artifactOver" }, over)
  const kept = over.content.map((part) => part.text).join("")
  assert.ok(Buffer.byteLength(kept) <= 6 * 1024 + 1024)
  assert.match(kept, /full_result=.*harness_read_result/)

  const plain = { content: [{ type: "text", text: JSON.stringify({ rows: "z".repeat(7 * 1024) }) }] }
  await f.after("execute", { code: "return rows" }, plain)
  const plainKept = plain.content.map((part) => part.text).join("")
  assert.ok(Buffer.byteLength(plainKept) <= 6 * 1024 + 1024)
  assert.match(plainKept, /full_result=.*harness_read_result/)
})

test("mixed non-text execute results are never bounded or rewritten", async t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-output-bounds-"))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const f = await fixture(t, undefined, { outputDir })

  const mixed = {
    content: [
      { type: "text", text: "row\n".repeat(4000) },
      { type: "image", data: "abc", mimeType: "image/png" }
    ]
  }
  const before = JSON.parse(JSON.stringify(mixed))
  await f.after("execute", { code: "return mixed" }, mixed)
  assert.deepEqual(mixed.content, before.content)
  assert.deepEqual(fs.readdirSync(outputDir), [])
})

test("a finished turn resets the read budget and the phase for the next user message", async t => {
  const f = await fixture(t)
  await f.after("edit", { file: "a.mjs" })
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

  const nextTask = {}
  for (let i = 0; i < 20; i++) await f.after("read", { file: `b${i}.mjs` }, i === 19 ? nextTask : {})
  assert.match(f.notice(nextTask), /20 read calls without a file change/)
  assert.doesNotMatch(f.notice(nextTask), /Make the first edit/)
  for (let i = 20; i < 60; i++) await f.after("read", { file: `b${i}.mjs` })
  const readOnly = await f.contextHook()
  assert.ok(readOnly.tools.read, "a new task is an unknown phase until it edits")
  assert.ok(readOnly.tools.shell, "an unknown phase must not withdraw tools")

  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })
  const resumed = await f.contextHook()
  assert.ok(resumed.tools.shell)
  assert.match(resumed.messages[0].content[0].text, /Harness resume after compaction/)
  assert.doesNotMatch(JSON.stringify(resumed.messages), /progress guard/)

  await f.after("edit", { file: "c.mjs" })
  for (let i = 0; i < 19; i++) await f.after("read", { file: `c${i}.mjs` })
  const implemented = {}
  await f.after("read", { file: "c19.mjs" }, implemented)
  assert.match(f.notice(implemented), /20 read calls since the last file change/)
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

test("compaction resumes once with cached ranges and skills without carrying the edit phase", async t => {
  const f = await fixture(t)
  await f.after("skill", { id: "react-frontend" })
  await f.after("edit", { file: "a.mjs" })
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })

  const first = await f.contextHook()
  const resume = first.messages.at(-1).content[0].text
  assert.match(resume, /Harness resume after compaction:/)
  assert.match(resume, /Cached context/)
  assert.match(resume, /Cached ranges: source\.mjs:2-3/)
  assert.match(resume, /Active skills before compaction: react-frontend/)
  assert.match(
    resume,
    /Resume protocol: continue the next unfinished step of the plan within 12 tool calls/
  )
  assert.doesNotMatch(resume, /make the first source edit/)
  assert.equal((resume.match(/Do not rebuild the plan/g) ?? []).length, 1)
  assert.equal(f.references.length, 1)

  const second = await f.contextHook()
  assert.equal(second.system.length, 0)
  assert.equal(f.references.length, 1)
})

test("a failed skill call is not counted as an active skill", async t => {
  const f = await fixture(t)
  await f.after(
    "skill",
    { id: "optimize" },
    { message: "permission denied" },
    "session",
    "error"
  )
  await f.after("skill", { id: "react-frontend" })
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })

  const resume = (await f.contextHook()).messages.at(-1).content[0].text
  assert.match(resume, /Active skills before compaction: react-frontend/)
  assert.doesNotMatch(resume, /optimize/)
})

test("compaction without cached ranges states the resume protocol once", async t => {
  const f = await fixture(t, "")
  await f.sessionHooks.get("compaction")({ sessionID: "session", system: [] })

  const event = await f.contextHook()
  const resume = event.messages[0].content[0].text
  assert.match(resume, /No cached ranges\. Do not rebuild the plan/)
  assert.match(
    resume,
    /Resume protocol: continue the next unfinished step of the plan within 12 tool calls/
  )
  assert.match(
    resume,
    /for analysis-only work that is the next research or verification step, not an edit the plan does not authorize/
  )
  assert.equal((resume.match(/Do not rebuild the plan/g) ?? []).length, 1)
})
