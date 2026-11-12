import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { contextCacheKey, registerContextCache } from "../../opencode/evidence-cache.mjs"
import { createPlan, planIndexKey, planKey } from "../../opencode/plan-store.mjs"
import { observationAPI } from "../../opencode/observations.mjs"
import { cachePolicy } from "../../opencode/cache-policy.mjs"

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-evidence-cache-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = "first\nsecond\nthird\n"
  fs.writeFileSync(path.join(directory, "source.mjs"), source)
  const text = `file: source.mjs\nmode: full\ndigest: ${"a".repeat(64)}\n\n     1\tfirst\n     2\tsecond\n     3\tthird\n`
  const stored = new Map()
  const hooks = new Map()
  let execute
  const context = {
    app: { version: "2.2.6" },
    location: { directory },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value), remove: async key => stored.delete(key) },
    tool: { transform: async edit => edit({ add: tool => { execute = tool.execute } }) },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID }),
      hook: async (name, hook) => hooks.set(name, hook),
      context: async () => [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text: JSON.stringify({ source: text }) }] } }] }]
    }
  }
  const memory = await registerContextCache(context)
  const run = (args, sessionID = "source") => execute(args, { sessionID })
  const save = () => run({ action: "save", sources: [{ file: "source.mjs", lines: "2-3" }] })
  const scan = async ({ prefix = "", limit = 100, after } = {}) => {
    let entries = [...stored.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
    if (after) entries = entries.slice(entries.findIndex(value => value.key === after) + 1)
    return { entries: entries.slice(0, limit), next: entries.length > limit ? entries[limit].key : null }
  }
  return { directory, context, hooks, memory, run, save, scan, stored }
}

test("context cache survives a transfer and restores only selected unchanged evidence", async t => {
  const f = await fixture(t)
  execFileSync("git", ["init", "--quiet", f.directory])
  await f.save()
  await f.memory.transfer("source", "target")
  await registerContextCache(f.context)

  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2-3" }] }, "target")

  assert.match(restored.content, /2\tsecond\n3\tthird/)
  assert.doesNotMatch(restored.content, /1\tfirst/)
  assert.doesNotMatch(restored.content, /checkpoint/i)
  const directory = path.join(f.directory, ".opencode/context-cache")
  const file = path.join(directory, fs.readdirSync(directory)[0])
  assert.equal(execFileSync("git", ["-C", f.directory, "check-ignore", file], { encoding: "utf8" }).trim(), file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
})

test("context cache explains oversized restore ranges and lists cached ranges without a checkpoint", async t => {
  const f = await fixture(t)
  await f.save()

  await assert.rejects(
    f.run({ action: "restore", sources: [{ file: "source.mjs", lines: `1-${cachePolicy.taskSourceLines + 1}` }] }),
    new RegExp(`maximum ${cachePolicy.taskSourceLines} lines.*Restore without sources`)
  )
  assert.match((await f.run({ action: "restore" })).content, /Cached ranges: source.mjs:2-3/)
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
  await registerContextCache(f.context)
  f.context.session.context = async () => [{ type: "compaction", summary: "Step 2 remains active" }]
  await f.hooks.get("compaction")({ sessionID: "source", system: [] })

  assert.equal(fs.readdirSync(path.join(f.directory, ".opencode/context-cache")).length, 1)
  assert.match(event.messages[0].content[0].text, /Cached context:/)
  assert.match(event.messages[0].content[0].text, /Cached ranges: source.mjs:1-3/)
  assert.doesNotMatch(event.messages[0].content[0].text, /Continue step 2/)
  assert.doesNotMatch(event.messages[0].content[0].text, /1\tfirst/)
  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] })
  assert.match(restored.content, /2\tsecond/)
  assert.doesNotMatch(restored.content, /Continue step 2/)
})

test("native compaction caches evidence without a second checkpoint", async t => {
  const f = await fixture(t)
  await f.save()
  await f.hooks.get("compaction")({ sessionID: "source", system: [] })
  const restored = await f.run({ action: "restore" })
  assert.match(restored.content, /Cached ranges: source.mjs:2-3/)
  assert.doesNotMatch(restored.content, /checkpoint/i)

  f.context.session.context = async () => [{ type: "user", text: "Analyze the pending migration" }]
  await f.hooks.get("compaction")({ sessionID: "other", system: [] })
  const other = await f.run({ action: "restore" }, "other")
  assert.match(other.content, /Cached ranges: none/)
  assert.doesNotMatch(other.content, /Analyze the pending migration/)
})

test("context cache keeps conversation text out of evidence and references", async t => {
  const f = await fixture(t)
  f.context.session.context = async () => [{ type: "user", text: "PRIVATE_TOKEN=example-value\nContinue setup" }]

  await f.hooks.get("compaction")({ sessionID: "source", system: [] })

  const restored = await f.run({ action: "restore" })
  assert.doesNotMatch(restored.content, /example-value/)
  assert.match(restored.content, /Cached ranges: none/)
})

test("context cache rejects changed files and never fabricates unobserved ranges", async t => {
  const f = await fixture(t)
  await f.save()
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "changed\nsecond\nthird\n")

  const restored = await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2-3" }] })

  assert.match(restored.content, /stale/)
  assert.doesNotMatch(restored.content, /2\tsecond/)
  await assert.rejects(f.run({ action: "save", sources: [{ file: "source.mjs", lines: "1-3" }] }), /observed/)
})

test("context cache completes through the native storage removal API and can be completed again", async t => {
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

  assert.equal(stored.has(contextCacheKey("source")), false)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("context cache storage key stays shared with observations", async t => {
  const f = await fixture(t)
  await f.save()

  assert.equal(contextCacheKey("source"), "context-cache:source")
  const [storedKey, storedID] = [...f.stored.entries()][0]
  assert.equal(storedKey, contextCacheKey("source"))
  assert.equal(await observationAPI(f.context).task("source"), storedID)
  assert.equal(await observationAPI(f.context).task("other"), null)
  f.stored.set("task-context:legacy", "b".repeat(64))
  assert.equal(await observationAPI(f.context).task("legacy"), "b".repeat(64))
})

test("context cache keeps active work across answers and compaction until explicit completion", async t => {
  const f = await fixture(t)
  await f.save()
  const turn = { sessionID: "source", system: [] }
  await f.hooks.get("context")(turn)
  assert.equal(turn.system.length, 0)
  assert.match((await f.run({ action: "restore" })).content, /Cached ranges: source.mjs:2-3/)
  await f.memory.transfer("source", "target")

  await f.run({ action: "complete" }, "target")

  assert.equal(fs.readdirSync(path.join(f.directory, ".opencode/context-cache")).length, 0)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("context cache excludes truncated results, outside paths and oversized selections", async t => {
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
  await assert.rejects(f.run({ action: "save", sources: [{ file: "../outside", lines: "1-2" }] }), /project/)
  await assert.rejects(f.run({ action: "save", sources: [{ file: "source.mjs", lines: "1-1000" }] }), /range/)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("context cache rejects a replaced cache directory and preserves other tasks on completion", async t => {
  const f = await fixture(t)
  await f.save()
  await f.run({ action: "save", sources: [{ file: "source.mjs", lines: "1" }] }, "other")
  await f.run({ action: "complete" })
  assert.match((await f.run({ action: "restore" }, "other")).content, /Cached ranges: source.mjs:1-1/)
  const directory = path.join(f.directory, ".opencode/context-cache")
  fs.renameSync(directory, `${directory}-moved`)
  fs.symlinkSync(`${directory}-moved`, directory)

  await assert.rejects(f.run({ action: "restore" }, "other"), /symlink/)
  await assert.rejects(f.run({ action: "complete" }, "other"), /symlink/)
})

test("context cache does not reconnect completed continuations to a later task", async t => {
  const f = await fixture(t)
  await f.save()
  await f.memory.transfer("source", "old-target")
  await f.run({ action: "complete" })
  await f.run({ action: "save", sources: [{ file: "source.mjs", lines: "3" }] })

  await f.run({ action: "complete" }, "old-target")

  assert.match((await f.run({ action: "restore" })).content, /Cached ranges: source.mjs:3-3/)
})

test("automatic preparation bounds recent evidence and refreshes automatic ranges", async t => {
  const f = await fixture(t)
  const messages = []
  for (let index = 0; index < cachePolicy.taskSourceEntries + 2; index++) {
    const file = `source-${index}.mjs`
    const lines = Array.from({ length: cachePolicy.taskSourceLines + 5 }, (_, line) => `value ${line}`)
    fs.writeFileSync(path.join(f.directory, file), lines.join("\n"))
    const text = `file: ${file}\nmode: full\ndigest: ${"b".repeat(64)}\n\n` + lines.map((text, line) => `${line + 1}\t${text}`).join("\n")
    messages.push({ content: [{ type: "tool", name: "execute", state: { status: "completed", content: text } }] })
  }

  await f.memory.prepare("source", messages)
  await f.memory.prepare("source", [])
  const directory = path.join(f.directory, ".opencode/context-cache")
  const saved = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8"))

  assert.equal(Object.hasOwn(saved, "checkpoint"), false)
  assert.ok(saved.sources.length > 0 && saved.sources.length <= cachePolicy.taskSourceEntries)
  assert.equal(saved.sources[0].file, "source-9.mjs")
  assert.ok(saved.sources.every(source => source.end - source.start < cachePolicy.taskSourceLines))
  assert.ok(Buffer.byteLength(JSON.stringify(saved.sources)) <= cachePolicy.taskSourceBytes)
  assert.doesNotMatch(await f.memory.reference("source"), /1\tvalue/)
  const latest = [{ content: [{ type: "tool", name: "execute", state: { status: "completed", content: `file: source.mjs\nmode: lines\ndigest: ${"c".repeat(64)}\n\n2\tsecond` } }] }]
  await f.memory.prepare("source", latest)
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

  await f.memory.prepare("source", candidates)

  assert.match(await f.memory.reference("source"), /Cached ranges: none/)
  assert.match((await f.run({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] })).content, /Missing cached range/)
})

test("a transfer releases the source binding and keeps the continuation pointed at the cache", async t => {
  const f = await fixture(t)
  await f.save()
  const id = f.stored.get(contextCacheKey("source"))
  assert.match(id, /^[a-f0-9]{64}$/)

  await f.memory.transfer("source", "target")

  assert.equal(f.stored.get(contextCacheKey("target")), id)
  assert.equal(f.stored.has(contextCacheKey("source")), false)
  assert.match((await f.run({ action: "restore" }, "source")).content, /No saved/)
  assert.match((await f.run({ action: "restore" }, "target")).content, /Cached ranges: source.mjs:2-3/)
})

test("ordinary turns do not receive cache while compaction adds its reference", async t => {
  const f = await fixture(t)
  await f.save()

  const turn = { sessionID: "source", system: [] }
  await f.hooks.get("context")(turn)
  assert.equal(turn.system.length, 0)

  const compaction = { sessionID: "source", system: [] }
  await f.hooks.get("compaction")(compaction)
  assert.match(compaction.messages[0].content[0].text, /Cached context:/)
  assert.match(compaction.messages[0].content[0].text, /Cached ranges: source.mjs:2-3/)
  assert.doesNotMatch(compaction.messages[0].content[0].text, /2\tsecond/)
})

test("plugin startup prunes orphaned caches older than the retention window", async t => {
  const f = await fixture(t)
  await f.save()
  const directory = path.join(f.directory, ".opencode/context-cache")
  const live = f.stored.get(contextCacheKey("source"))
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

  await registerContextCache(f.context)

  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [`${live}.json`, `${recent}.json`].sort()
  )
})

test("plugin startup clears an expired cache even when a closed session still has a binding", async t => {
  const f = await fixture(t)
  await f.save()
  f.context.session.get = async () => {
    throw Object.assign(new Error("Session not found"), { status: 404 })
  }
  const directory = path.join(f.directory, ".opencode/context-cache")
  const id = f.stored.get(contextCacheKey("source"))
  const file = path.join(directory, `${id}.json`)
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)
  f.context.storage.scan = async ({ prefix = "" } = {}) => ({
    entries: [...f.stored.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
    next: null
  })

  await registerContextCache(f.context)

  assert.equal(fs.existsSync(file), false)
  assert.equal(f.stored.has(contextCacheKey("source")), false)
  const turn = { sessionID: "source", system: [] }
  await f.hooks.get("context")(turn)
  assert.equal(turn.system.length, 0)
  assert.match((await f.run({ action: "restore" })).content, /No saved/)
})

test("live session binding keeps an expired cache and managed plan while a user plan is untouched", async t => {
  const f = await fixture(t)
  await f.save()
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Keep the active plan",
    stage: "implementation"
  })
  const directory = path.join(f.directory, ".opencode/context-cache")
  const id = f.stored.get(contextCacheKey("source"))
  const file = path.join(directory, `${id}.json`)
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)
  fs.utimesSync(plan.file, old, old)
  const userPlan = path.join(f.directory, ".opencode/plans", "user-owned.md")
  fs.writeFileSync(userPlan, "## Objective\n\nUser plan\n")
  fs.utimesSync(userPlan, old, old)
  f.context.storage.scan = f.scan

  await registerContextCache(f.context)

  assert.equal(fs.existsSync(file), true)
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < cachePolicy.taskContextMs)
  assert.equal(fs.existsSync(plan.file), true)
  assert.ok(Date.now() - fs.statSync(plan.file).mtimeMs < cachePolicy.taskContextMs)
  assert.equal(fs.existsSync(userPlan), true)
  assert.equal(f.stored.has(planKey("source")), true)
  assert.equal(f.stored.has(planIndexKey(plan.id)), true)
})

test("expired managed plans and caches of a closed session are removed", async t => {
  const f = await fixture(t)
  await f.save()
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Drop the closed plan",
    stage: "implementation"
  })
  const directory = path.join(f.directory, ".opencode/context-cache")
  const id = f.stored.get(contextCacheKey("source"))
  const file = path.join(directory, `${id}.json`)
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)
  fs.utimesSync(plan.file, old, old)
  f.context.session.get = async () => {
    throw Object.assign(new Error("Session not found"), { status: 404 })
  }
  f.context.storage.scan = f.scan

  await registerContextCache(f.context)

  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(plan.file), false)
  assert.equal(f.stored.has(contextCacheKey("source")), false)
  assert.equal(f.stored.has(planKey("source")), false)
  assert.equal(f.stored.has(planIndexKey(plan.id)), false)
})

test("active context cache refreshes its idle window and a missing file clears its binding", async t => {
  const f = await fixture(t)
  await f.save()
  const directory = path.join(f.directory, ".opencode/context-cache")
  const id = f.stored.get(contextCacheKey("source"))
  const file = path.join(directory, `${id}.json`)
  const old = new Date(Date.now() - cachePolicy.taskPruneMs - 1000)
  fs.utimesSync(file, old, old)

  const turn = { sessionID: "source", system: [] }
  await f.hooks.get("context")(turn)

  assert.ok(Date.now() - fs.statSync(file).mtimeMs < cachePolicy.taskPruneMs)
  assert.equal(turn.system.length, 0)
  fs.unlinkSync(file)
  await f.hooks.get("context")(turn)
  assert.equal(f.stored.has(contextCacheKey("source")), false)
})

test("completion prune removes orphaned caches and honors the throttle window", async t => {
  const f = await fixture(t)
  await f.save()
  const directory = path.join(f.directory, ".opencode/context-cache")
  const live = f.stored.get(contextCacheKey("source"))
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
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "harness-evidence-cache-outside-"))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const orphan = "d".repeat(64)
  const file = path.join(outside, `${orphan}.json`)
  fs.writeFileSync(file, "{}")
  const old = new Date(Date.now() - cachePolicy.taskContextMs - 1000)
  fs.utimesSync(file, old, old)
  const directory = path.join(f.directory, ".opencode/context-cache")
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  fs.symlinkSync(outside, directory)
  f.context.storage.scan = async () => ({ entries: [], next: null })

  await registerContextCache(f.context)

  assert.equal(fs.existsSync(file), true)
})

test("legacy task-context checkpoint migrates into a managed plan and drops the checkpoint", async t => {
  const f = await fixture(t)
  const root = fs.realpathSync(f.directory)
  const id = "f".repeat(64)
  const legacyDirectory = path.join(root, ".opencode/task-context")
  fs.mkdirSync(legacyDirectory, { recursive: true })
  const legacyFile = path.join(legacyDirectory, `${id}.json`)
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    root,
    checkpoint: "Legacy step 2; continue the migration",
    checkpointSource: "agent",
    sources: []
  }))
  f.stored.set("task-context:source", id)

  await f.hooks.get("context")({ sessionID: "source", system: [] })

  assert.equal(fs.existsSync(legacyFile), false)
  assert.equal(f.stored.has("task-context:source"), false)
  assert.ok(f.stored.has(contextCacheKey("source")))
  const plans = fs.readdirSync(path.join(root, ".opencode/plans"))
  assert.equal(plans.length, 1)
  assert.match(fs.readFileSync(path.join(root, ".opencode/plans", plans[0]), "utf8"), /Legacy step 2; continue the migration/)
  const cacheDirectory = path.join(root, ".opencode/context-cache")
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDirectory, fs.readdirSync(cacheDirectory)[0]), "utf8"))
  assert.equal(saved.version, 2)
  assert.equal(Object.hasOwn(saved, "checkpoint"), false)
  assert.match(saved.plan, /^\.opencode\/plans\/[a-z0-9-]+\.md$/)
  assert.match(await f.memory.reference("source"), /Task plan: \.opencode\/plans\//)
  assert.doesNotMatch(await f.memory.reference("source"), /Legacy step 2/)
})
