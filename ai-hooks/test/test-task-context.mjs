import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { registerTaskContext } from "../../opencode/task-context.mjs"
import { cachePolicy } from "../../opencode/cache-policy.mjs"

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-task-context-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = "first\nsecond\nthird\n"
  fs.writeFileSync(path.join(directory, "source.mjs"), source)
  const text = `file: source.mjs\nmode: full\ndigest: ${"a".repeat(64)}\n\n     1\tfirst\n     2\tsecond\n     3\tthird\n`
  const stored = new Map()
  const hooks = new Map()
  let execute
  const context = {
    location: { directory },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value), remove: async key => stored.delete(key) },
    tool: { transform: async edit => edit({ add: tool => { execute = tool.execute } }) },
    session: {
      hook: async (name, hook) => hooks.set(name, hook),
      context: async () => [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text: JSON.stringify({ source: text }) }] } }] }]
    }
  }
  const memory = await registerTaskContext(context)
  const run = (args, sessionID = "source") => execute(args, { sessionID })
  const save = () => run({ action: "save", checkpoint: "Implement step 2; next edit source.mjs:2; plan .opencode/plans/task.md", sources: [{ file: "source.mjs", lines: "2-3" }] })
  return { directory, context, hooks, memory, run, save, stored }
}

test("task context survives a transfer and restores only selected unchanged evidence", async t => {
  const f = await fixture(t)
  execFileSync("git", ["init", "--quiet", f.directory])
  await f.save()
  await f.memory.transfer("source", "target")
  await registerTaskContext(f.context)

  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2-3" }] }, "target")

  assert.match(restored.content, /Implement step 2/)
  assert.match(restored.content, /2\tsecond\n3\tthird/)
  assert.doesNotMatch(restored.content, /1\tfirst/)
  const directory = path.join(f.directory, ".opencode/task-context")
  const file = path.join(directory, fs.readdirSync(directory)[0])
  assert.equal(execFileSync("git", ["-C", f.directory, "check-ignore", file], { encoding: "utf8" }).trim(), file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
})

test("JSON TokenSave results retain selected and automatic evidence through transfers", async t => {
  const f = await fixture(t)
  const source = { file: "source.mjs", mode: "lines", digest: "a".repeat(64), body: "     2\tsecond\n     3\tthird" }
  for (const [index, content] of [
    [{ type: "text", text: JSON.stringify(source, null, 2) }],
    [{ type: "text", text: `${JSON.stringify(source, null, 2)}\n\ntokensave_metrics: before=10 after=20 result=15 saved=0` }],
    [{ type: "text", text: JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(source) }] } }) }]
  ].entries()) {
    f.context.session.context = async () => [{ content: [{ type: "tool", name: "execute", state: { status: "completed", content } }] }]

    await f.save()
    const sessionID = `automatic-json-${index}`
    await f.hooks.get("compaction")({ sessionID, system: [] })
    await f.memory.transfer(sessionID, `target-json-${index}`)
    const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2-3" }] }, `target-json-${index}`)

    assert.match(restored.content, /2\tsecond\n3\tthird/)
    assert.doesNotMatch(restored.content, /1\tfirst/)
  }
})

test("JSON cache observation rejects invalid, unchanged and truncated read results", async t => {
  const f = await fixture(t)
  const source = { file: "source.mjs", mode: "lines", digest: "a".repeat(64), body: "     2\tsecond\n     3\tthird" }
  for (const text of [
    JSON.stringify({ ...source, mode: "map" }),
    JSON.stringify({ ...source, unchanged: true }),
    JSON.stringify({ ...source, digest: "invalid" }),
    `${JSON.stringify(source)}\n[full_result=/tmp/truncated.json]`
  ]) {
    f.context.session.context = async () => [{ content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text }] } }] }]
    await assert.rejects(f.save(), /observed/)
  }
})

test("native compaction persists observed evidence without an agent save and restores it after reload", async t => {
  const f = await fixture(t)
  const observed = await f.context.session.context()
  f.context.session.context = async () => [
    { type: "user", text: "Continue step 2 in .opencode/plans/task.md" },
    ...observed
  ]
  const event = { sessionID: "source", system: [] }

  await f.hooks.get("compaction")(event)
  await registerTaskContext(f.context)
  f.context.session.context = async () => [{ type: "compaction", summary: "Step 2 remains active" }]
  await f.hooks.get("compaction")({ sessionID: "source", system: [] })

  assert.equal(fs.readdirSync(path.join(f.directory, ".opencode/task-context")).length, 1)
  assert.match(event.system[0].text, /Saved task context:/)
  assert.match(event.system[0].text, /Continue step 2/)
  assert.doesNotMatch(event.system[0].text, /2\tsecond/)
  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] })
  assert.match(restored.content, /Continue step 2/)
  assert.match(restored.content, /2\tsecond/)
  assert.doesNotMatch(restored.content, /1\tfirst/)
})

test("native compaction retains an explicit checkpoint and saves a checkpoint without source reads", async t => {
  const f = await fixture(t)
  await f.save()
  await f.hooks.get("compaction")({ sessionID: "source", system: [] })
  assert.match((await f.run({ action: "restore" })).content, /Implement step 2/)

  f.context.session.context = async () => [{ type: "user", text: "Analyze the pending migration" }]
  await f.hooks.get("compaction")({ sessionID: "other", system: [] })
  const restored = await f.run({ action: "restore" }, "other")
  assert.match(restored.content, /Analyze the pending migration/)
  assert.match(restored.content, /Cached ranges: $/)
})

test("task context rejects changed files and never fabricates unobserved ranges", async t => {
  const f = await fixture(t)
  await f.save()
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "changed\nsecond\nthird\n")

  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2-3" }] })

  assert.match(restored.content, /stale/)
  assert.doesNotMatch(restored.content, /2\tsecond/)
  await assert.rejects(f.run({ action: "save", checkpoint: "Next step", sources: [{ file: "source.mjs", lines: "1-3" }] }), /observed/)
})

test("task context completes through the native storage removal API and can be completed again", async t => {
  const f = await fixture(t)
  const stored = new Map()
  f.context.storage = {
    get: async key => stored.get(key),
    set: async (key, value) => {
      if (value == null) throw new Error("kv.value must not be SQL NULL")
      stored.set(key, value)
    },
    remove: async key => stored.delete(key)
  }
  await f.save()

  await f.run({ action: "complete" })
  await f.run({ action: "complete" })

  assert.equal(stored.has("task-context:source"), false)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("task context keeps active work across answers and compaction until explicit completion", async t => {
  const f = await fixture(t)
  await f.save()
  const event = { sessionID: "source", system: [] }
  await f.hooks.get("context")(event)
  assert.match(event.system[0].text, /task_context/)
  assert.doesNotMatch(event.system[0].text, /second/)
  assert.match((await f.run({ action: "restore" })).content, /Implement step 2/)
  await f.memory.transfer("source", "target")

  await f.run({ action: "complete" }, "target")

  assert.equal(fs.readdirSync(path.join(f.directory, ".opencode/task-context")).length, 0)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("task context excludes truncated results, outside paths and oversized selections", async t => {
  const f = await fixture(t)
  const original = f.context.session.context
  f.context.session.context = async () => {
    const messages = await original()
    messages[0].content[0].state.content[0].text += "\nfull_result=/tmp/truncated"
    return messages
  }
  await assert.rejects(f.save(), /observed/)
  f.context.session.context = async () => []
  await assert.rejects(f.save(), /observed/)
  await assert.rejects(f.run({ action: "save", checkpoint: "Next", sources: [{ file: "../outside", lines: "1-2" }] }), /project/)
  await assert.rejects(f.run({ action: "save", checkpoint: "Next", sources: [{ file: "source.mjs", lines: "1-1000" }] }), /range/)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("task context rejects a replaced cache directory and preserves other tasks on completion", async t => {
  const f = await fixture(t)
  await f.save()
  await f.run({ action: "save", checkpoint: "Other task" }, "other")
  await f.run({ action: "complete" })
  assert.match((await f.run({ action: "restore" }, "other")).content, /Other task/)
  const directory = path.join(f.directory, ".opencode/task-context")
  fs.renameSync(directory, `${directory}-moved`)
  fs.symlinkSync(`${directory}-moved`, directory)

  await assert.rejects(f.run({ action: "restore" }, "other"), /symlink/)
  await assert.rejects(f.run({ action: "complete" }, "other"), /symlink/)
})

test("task context does not reconnect completed continuations to a later task", async t => {
  const f = await fixture(t)
  await f.save()
  await f.memory.transfer("source", "old-target")
  await f.run({ action: "complete" })
  await f.run({ action: "save", checkpoint: "A new task in the same session" })

  await f.run({ action: "complete" }, "old-target")

  assert.match((await f.run({ action: "restore" })).content, /A new task/)
})

test("automatic preparation bounds recent evidence and refreshes automatic checkpoints", async t => {
  const f = await fixture(t)
  const messages = []
  for (let index = 0; index < cachePolicy.taskSourceEntries + 2; index++) {
    const file = `source-${index}.mjs`
    const lines = Array.from({ length: cachePolicy.taskSourceLines + 5 }, (_, line) => `value ${line}`)
    fs.writeFileSync(path.join(f.directory, file), lines.join("\n"))
    const text = `file: ${file}\nmode: full\ndigest: ${"b".repeat(64)}\n\n` + lines.map((text, line) => `${line + 1}\t${text}`).join("\n")
    messages.push({ content: [{ type: "tool", name: "execute", state: { status: "completed", content: text } }] })
  }

  await f.memory.prepare("source", "Implement current step", messages)
  await f.memory.prepare("source", "Verify completed edit", [])
  const directory = path.join(f.directory, ".opencode/task-context")
  const saved = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8"))

  assert.equal(saved.checkpoint, "Verify completed edit")
  assert.ok(saved.sources.length > 0 && saved.sources.length <= cachePolicy.taskSourceEntries)
  assert.equal(saved.sources[0].file, "source-9.mjs")
  assert.ok(saved.sources.every(source => source.end - source.start < cachePolicy.taskSourceLines))
  assert.ok(Buffer.byteLength(JSON.stringify(saved.sources)) <= cachePolicy.taskSourceBytes)
  assert.doesNotMatch(await f.memory.reference("source"), /1\tvalue/)
  const latest = [{ content: [{ type: "tool", name: "execute", state: { status: "completed", content: `file: source.mjs\nmode: lines\ndigest: ${"c".repeat(64)}\n\n2\tsecond` } }] }]
  await f.memory.prepare("source", "Use the newest source.mjs:2", latest)
  const refreshed = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8"))
  assert.equal(refreshed.sources[0].file, "source.mjs")
  assert.match((await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] })).content, /2\tsecond/)
  await f.run({ action: "complete" })
  assert.equal(fs.readdirSync(directory).length, 0)
})

test("automatic preparation skips truncated, changed, missing and outside source data", async t => {
  const f = await fixture(t)
  const messages = await f.context.session.context()
  const text = JSON.parse(messages[0].content[0].state.content[0].text).source
  const part = content => ({ content: [{ type: "tool", name: "execute", state: { status: "completed", content } }] })
  const candidates = [part(text + "\nfull_result=/tmp/truncated"), part(text.replace("source.mjs", "../outside")), part(text.replace("source.mjs", "missing.mjs")), part(text)]
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "changed\naltered\nreplaced\n")

  await f.memory.prepare("source", "Read changed source.mjs:2 through MCP", candidates)

  assert.match(await f.memory.reference("source"), /Cached ranges: none/)
  assert.match((await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] })).content, /Missing cached range/)
})

test("a transfer releases the source binding and keeps the continuation pointed at the cache", async t => {
  const f = await fixture(t)
  await f.save()
  const id = f.stored.get("task-context:source")
  assert.match(id, /^[a-f0-9]{64}$/)

  await f.memory.transfer("source", "target")

  assert.equal(f.stored.get("task-context:target"), id)
  assert.equal(f.stored.has("task-context:source"), false)
  assert.match((await f.run({ action: "restore" }, "source")).content, /No saved/)
  assert.match((await f.run({ action: "restore" }, "target")).content, /Implement step 2/)
})

test("ordinary turns receive the cache pointer without repeating the checkpoint", async t => {
  const f = await fixture(t)
  await f.save()

  const turn = { sessionID: "source", system: [] }
  await f.hooks.get("context")(turn)
  assert.match(turn.system[0].text, /Saved task context:/)
  assert.match(turn.system[0].text, /source\.mjs:2-3/)
  assert.doesNotMatch(turn.system[0].text, /Implement step 2/)

  const compaction = { sessionID: "source", system: [] }
  await f.hooks.get("compaction")(compaction)
  assert.match(compaction.system[0].text, /Implement step 2/)
})

test("plugin startup prunes orphaned caches older than the retention window", async t => {
  const f = await fixture(t)
  await f.save()
  const directory = path.join(f.directory, ".opencode/task-context")
  const live = f.stored.get("task-context:source")
  const orphan = "b".repeat(64)
  const recent = "c".repeat(64)
  fs.writeFileSync(path.join(directory, `${orphan}.json`), "{}")
  fs.writeFileSync(path.join(directory, `${recent}.json`), "{}")
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(path.join(directory, `${orphan}.json`), old, old)
  f.context.storage.scan = async ({ prefix = "" } = {}) => ({
    entries: [...f.stored.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
    next: null
  })

  await registerTaskContext(f.context)

  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [`${live}.json`, `${recent}.json`].sort()
  )
})

test("completion prune removes orphaned caches and honors the throttle window", async t => {
  const f = await fixture(t)
  await f.save()
  const directory = path.join(f.directory, ".opencode/task-context")
  const live = f.stored.get("task-context:source")
  f.context.storage.scan = async ({ prefix = "" } = {}) => ({
    entries: [...f.stored.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
    next: null
  })
  await f.memory.prune(true)
  const orphan = "e".repeat(64)
  const file = path.join(directory, `${orphan}.json`)
  fs.writeFileSync(file, "{}")
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)

  await f.memory.prune()
  assert.equal(fs.existsSync(file), true)

  await f.memory.prune(true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(path.join(directory, `${live}.json`)), true)
})

test("plugin startup never prunes through a symlinked cache directory", async t => {
  const f = await fixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-task-context-outside-"))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const orphan = "d".repeat(64)
  const file = path.join(outside, `${orphan}.json`)
  fs.writeFileSync(file, "{}")
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)
  const directory = path.join(f.directory, ".opencode/task-context")
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  fs.symlinkSync(outside, directory)
  f.context.storage.scan = async () => ({ entries: [], next: null })

  await registerTaskContext(f.context)

  assert.equal(fs.existsSync(file), true)
})
