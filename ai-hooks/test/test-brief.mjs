import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerBrief } from "../../opencode/brief.mjs"
import { registerHandoff } from "../../opencode/handoff.mjs"
import { registerContextCache } from "../../opencode/evidence-cache.mjs"
import { checkpointHeading, createPlan, planKey, remainingHeading, replaceSection, updatePlan } from "../../opencode/plan-store.mjs"
import { finishCompaction } from "../../opencode/session-compaction.mjs"
import { readBriefPolicy } from "../bin/brief-policy.mjs"
import { handleSuccessfulTurn } from "../../opencode/harness.js"
import {
  commandRunsMachineCheck,
  parseMachineCheck
} from "../../opencode/test-receipts.mjs"

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brief-routing-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  t.after(() => finishCompaction("source"))
  const stored = new Map(), sessions = new Map(), hooks = {}, toolHooks = {}, tools = new Map(), compacted = [], prompts = []
  const original = { providerID: "fixture", id: "daily", variant: "high" }
  sessions.set("source", { location: { directory }, model: original, agent: "build", permissions: [{ action: "edit", resource: "secret/**", effect: "deny" }] })
  let compact = async (value) => ({ id: value.id })
  const context = {
    location: { directory },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)), remove: async key => stored.delete(key) },
    rpc: { register: async () => ({ events: { emit: async () => {} } }) },
    command: { transform: async edit => edit({ add() {} }) },
    tool: {
      transform: async edit => edit({ add: value => tools.set(value.name, value) }),
      hook: async (name, callback) => {
        const previous = toolHooks[name]
        toolHooks[name] = previous
          ? async event => {
              await previous(event)
              await callback(event)
            }
          : callback
      }
    },
    session: {
      hook: async (name, callback) => { hooks[name] = callback },
      wait: async () => {},
      get: async ({ sessionID }) => sessions.get(sessionID),
      context: async () => [],
      generate: async () => { throw new Error("Brief must reuse its explicit Handoff without an extra model request") },
      prompt: async value => { prompts.push(value) },
      compact: async value => {
        compacted.push(value)
        await hooks.compaction?.({ sessionID: value.sessionID, messages: [], system: [] })
        return compact(value)
      },
      switchModel: async () => { assert.fail("Handoff must not switch models") }
    }
  }
  const policy = { enabled: true }
  return {
    directory,
    context,
    policy,
    original,
    sessions,
    stored,
    hooks,
    toolHooks,
    tools,
    compacted,
    prompts,
    setCompact: value => { compact = value },
    finish: () => finishCompaction("source"),
    accept: (rows = [
      '- A1 [not checked] Deliver the requested change | check: test node --test ai-hooks/test/test-brief.mjs -t "deliver the requested change"'
    ]) => {
      const { file } = stored.get(planKey("source"))
      fs.writeFileSync(
        file,
        replaceSection(
          fs.readFileSync(file, "utf8"),
          "## Acceptance criteria",
          rows.join("\n")
        )
      )
    },
    call: (sessionID, stage, handoff = "Goal: fix module. No push. Plan path: .opencode/plans/task.md") => tools.get("brief_transition").execute({ stage, handoff }, { sessionID })
  }
}

async function machineFixture(
  t,
  {
    body = 'test("machine target", () => { fs.appendFileSync("runs.log", "run\\n") })',
    name = "machine target",
    file = "machine.test.mjs",
    inputs = [file],
    rowCount = 1,
    sessionID = "source"
  } = {}
) {
  const f = fixture(t)
  fs.writeFileSync(
    path.join(f.directory, file),
    `import fs from "node:fs"\nimport { test } from "node:test"\n${body}\n`
  )
  fs.writeFileSync(
    path.join(f.directory, "other.test.mjs"),
    'import { test } from "node:test"\ntest("machine target", () => {})\n'
  )
  for (const input of inputs) {
    const inputFile = path.resolve(f.directory, input)
    if (inputFile !== path.resolve(f.directory, file) && !fs.existsSync(inputFile))
      fs.writeFileSync(inputFile, "stable")
  }
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID,
    directory: f.directory,
    objective: "Verify a machine checked row",
    stage: "planning"
  })
  const check = `node --test --test-name-pattern "^${name}$" ${file}`
  const declared = `check: test ${check} | inputs: ${inputs.join(", ")}`
  const writeRows = rows => {
    const current = f.stored.get(planKey(sessionID))
    fs.writeFileSync(
      current.file,
      replaceSection(
        fs.readFileSync(current.file, "utf8"),
        "## Acceptance criteria",
        rows.join("\n")
      )
    )
  }
  writeRows(
    Array.from(
      { length: rowCount },
      (_, index) =>
        `- A${index + 1} [not checked] Machine checked row | ${declared}`
    )
  )
  await updatePlan(f.context, {
    sessionID,
    stage: "implementation",
    remaining: "Run the exact machine check"
  })
  const close = (result = "1 passed") =>
    writeRows([
      `- A1 [closed] Machine checked row | ${declared} | test: ${check} => ${result}`
    ])
  const complete = () =>
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID })
  let calls = 0
  const fire = async ({
    command = check,
    run = true,
    output,
    timeout,
    workdir,
    id = `call-${++calls}`,
    exitCode = 0,
    status = "completed"
  } = {}) => {
    const input = { command, ...(workdir ? { workdir } : {}) }
    if (!run)
      return f.toolHooks["execute.after"]({
        sessionID,
        tool: "shell",
        id,
        status,
        input,
        result: { output, metadata: { exit: exitCode } }
      })
    await f.toolHooks["execute.before"]?.({
      sessionID,
      tool: "shell",
      id,
      input
    })
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync("bash", ["-c", command], {
      cwd: workdir ? path.resolve(f.directory, workdir) : f.directory,
      env,
      timeout,
      encoding: "utf8"
    })
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`
    return f.toolHooks["execute.after"]({
      sessionID,
      tool: "shell",
      id,
      status: result.signal ? "error" : "completed",
      input,
      result: { output: text, metadata: { exit: result.status ?? 1 } }
    })
  }
  const runs = () => {
    const log = path.join(f.directory, "runs.log")
    return fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
      : 0
  }
  const receipts = () =>
    [...f.stored.keys()].filter(key => key.startsWith("test-receipt:"))
  return {
    f,
    plan,
    check,
    declared,
    close,
    complete,
    fire,
    runs,
    receipts,
    writeRows,
    sessionID
  }
}

test("brief compacts the source session and keeps the plan bound to it", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.call("source", "plan")
  const event = { sessionID: "source", tools: { write: {} }, system: [] }
  await f.hooks.context(event)
  assert.deepEqual(event.tools, {})

  await brief.settle("source", true)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
  assert.equal(f.compacted[0].sessionID, "source")
  const planningContext = { sessionID: "source", system: [] }
  await f.hooks.context(planningContext)
  const planningSystem = planningContext.system.map(value => value.text).join("\n")
  assert.equal((planningSystem.match(/Planning phase\./g) ?? []).length, 1)
  assert.match(planningSystem, /Task plan: \.opencode\/plans\/[a-z0-9-]+\.md/)
  const plans = fs.readdirSync(path.join(f.directory, ".opencode/plans"))
  assert.equal(plans.length, 1)
  const planFile = path.join(f.directory, ".opencode/plans", plans[0])
  assert.match(fs.readFileSync(planFile, "utf8"), /Goal: fix module\. No push\./)
  f.finish()
  f.accept()
  await f.call("source", "implement", "Executable plan: update module contract; verify existing callers. No push.")
  await brief.settle("source", true)

  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 2)
  assert.match(fs.readFileSync(planFile, "utf8"), /Executable plan: update module contract/)
  assert.match(fs.readFileSync(planFile, "utf8"), /Goal: fix module\. No push\./)
  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").pending, undefined)
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 2)
})

test("implementation transition preserves the existing plan checkpoint and remaining steps", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  const planFile = path.join(f.directory, ".opencode/plans", fs.readdirSync(path.join(f.directory, ".opencode/plans"))[0])
  f.accept()
  const before = replaceSection(
    replaceSection(fs.readFileSync(planFile, "utf8"), "## Checkpoint", "- Текущий шаг: 7 — edit module"),
    "## Оставшиеся шаги",
    "### 7. Edit module\n\nRed evidence: preserved by the plan file"
  )
  fs.writeFileSync(planFile, before)
  f.finish()

  await f.call("source", "implement", "Executable plan: a different handoff summary")
  await brief.settle("source", true)

  const after = fs.readFileSync(planFile, "utf8")
  assert.equal(after, before)
  assert.equal(f.prompts.at(-1).sessionID, "source")
  assert.match(f.prompts.at(-1).text, /Task plan: \.opencode\/plans\//)
  assert.doesNotMatch(f.prompts.at(-1).text, /Red evidence: preserved by the plan file/)
  assert.doesNotMatch(f.prompts.at(-1).text, /a different handoff summary/)
  assert.equal(f.stored.get("brief:source").stage, "implementation")
})

test("planning instructions keep handoff path only", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  const { file } = f.stored.get(planKey("source"))
  fs.writeFileSync(file, replaceSection(fs.readFileSync(file, "utf8"), remainingHeading, "Run the failing test"))

  const event = { sessionID: "source", tools: { brief_transition: {} }, system: [] }
  await f.hooks.context(event)

  const instructions = event.system.map(block => block.text).join("\n")
  assert.ok(instructions.includes(path.relative(f.directory, file)))
  assert.match(instructions, /only when implementation is authorized/)
  assert.match(instructions, /pass only (?:a short readiness signal or )?the plan path (?:or a short readiness signal )?in the Handoff/i)
  assert.match(instructions, /do not repeat (?:them|the objective, decisions, checkpoint and remaining steps) in the Handoff/i)
  assert.doesNotMatch(instructions, /Run the failing test/)
})

test("fallback advances the generated checkpoint", async t => {
  for (const objective of ["Goal: fix module", "## Fix module\n\nInvestigate the regression"]) {
    await t.test(objective.split("\n")[0], async t => {
      const f = fixture(t)
      const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
      await f.call("source", "plan", objective)
      await brief.settle("source", true)
      const { file } = f.stored.get(planKey("source"))
      const original = fs.readFileSync(file, "utf8")
      if (objective.startsWith("##"))
        fs.writeFileSync(file, replaceSection(original, remainingHeading, ""))
      f.finish()
      f.accept()

      const firstStep = "Run the failing checkpoint test"
      await f.call("source", "implement", firstStep)
      await brief.settle("source", true)

      const lines = fs.readFileSync(file, "utf8").split("\n")
      assert.equal(lines[lines.indexOf(checkpointHeading) + 2], `- Текущий шаг: 1 — ${firstStep}`)
      assert.equal(lines[lines.indexOf(remainingHeading) + 2], firstStep)
    })
  }
})

test("fallback preserves an authored first checkpoint", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  const { file } = f.stored.get(planKey("source"))
  f.accept()
  const authored = replaceSection(fs.readFileSync(file, "utf8"), checkpointHeading, "- Текущий шаг: 1 — Inspect the fixture")
  fs.writeFileSync(file, authored)
  f.finish()

  const remaining = "Run the failing checkpoint test"
  await f.call("source", "implement", remaining)
  await brief.settle("source", true)

  assert.equal(fs.readFileSync(file, "utf8"), replaceSection(authored, remainingHeading, remaining))
})

test("brief preserves observed TokenSave evidence through planning and implementation without an agent save", async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.directory, "source.mjs"), "first\nsecond\n")
  const text = `file: source.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n     2\tsecond`
  f.context.session.context = async () => [{ type: "assistant", content: [{ type: "tool", name: "execute", state: { status: "completed", content: [{ type: "text", text: JSON.stringify([text], null, 2) }] } }] }]
  await registerContextCache(f.context)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)

  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()
  f.accept()
  await f.call("source", "implement", "Plan ready; next edit source.mjs:2")
  await brief.settle("source", true)

  const directory = path.join(f.directory, ".opencode/context-cache")
  const files = fs.readdirSync(directory)
  assert.equal(files.length, 1)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8"))
  assert.ok(saved.sources.some(source => source.file === "source.mjs"))
  assert.match(saved.plan, /^\.opencode\/plans\//)
  const plans = fs.readdirSync(path.join(f.directory, ".opencode/plans"))
  assert.equal(plans.length, 1)
  assert.match(fs.readFileSync(path.join(f.directory, ".opencode/plans", plans[0]), "utf8"), /next edit source.mjs:2/)
  const restored = await f.tools.get("context_cache").execute({ action: "restore", sources: [{ file: "source.mjs", lines: "2" }] }, { sessionID: "source" })
  assert.match(restored.content, /2\tsecond/)
  assert.match((await f.tools.get("context_cache").execute({ action: "restore" }, { sessionID: "other" })).content, /No saved/)
})

test("the managed implementation cannot complete until each acceptance criterion has evidence", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify route changes and cancellation.",
    stage: "implementation"
  })
  const complete = () => f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })
  const original = fs.readFileSync(plan.file, "utf8")
  const record = (...rows) => fs.writeFileSync(plan.file, `${original}\n## Acceptance criteria\n\n${rows.join("\n")}\n`)

  await assert.rejects(complete(), /add.*Acceptance criteria/i)

  record(
    "- A1 [closed] Deadline expires after 60 seconds | check: test node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" | test: node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" => 1 passed",
    "- A2 [not checked] Cancel while a successful status read is in flight | check: test node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\""
  )
  await assert.rejects(complete(), /A2/)

  record(
    "- A1 [closed] Deadline expires after 60 seconds | check: test node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\"",
    "- A2 [defect] Cancel while a successful status read is in flight | check: test node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\" | rejected stale result incorrectly"
  )
  await assert.rejects(complete(), /A1.*A2/s)

  record(
    "- A1 [closed] Deadline expires after 60 seconds | check: test node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" | 522 passed",
    "- A2 [closed] Cancel while a successful status read is in flight | check: test node --test cancel.test.mjs | test: node --test cancel.test.mjs: passed"
  )
  await assert.rejects(complete(), /A1.*evidence/i)

  record(
    "- A1 [closed] Deadline expires after 60 seconds | check: test node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" | test: node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" => 1 passed",
    "- A2 [closed] Cancel while a successful status read is in flight | check: test node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\" | test: node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\" => 1 passed"
  )
  assert.match((await complete()).content, /Task acceptance completed for/)
  assert.ok(fs.existsSync(plan.file))
})

test("removing an original acceptance row does not complete the plan", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify route changes and cancellation.",
    stage: "planning"
  })
  const record = (...rows) => {
    const current = fs.readFileSync(plan.file, "utf8")
    fs.writeFileSync(plan.file, replaceSection(current, "## Acceptance criteria", rows.join("\n")))
  }
  record(
    "- A1 [not checked] Check deadline | check: test node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\"",
    "- A2 [not checked] Check cancellation | check: test node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\""
  )
  await updatePlan(f.context, { sessionID: "source", remaining: "Check both conditions" })

  record("- A2 [closed] Check cancellation | test: node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\" => 1 passed")
  const complete = () => f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })
  await assert.rejects(complete(), /missing.*A1/i)

  record(
    "- A1 [closed] Check deadline | test: node --test ai-hooks/test/test-brief.mjs -t \"deadline expires\" => 1 passed",
    "- A2 [closed] Check cancellation | test: node --test ai-hooks/test/test-brief.mjs -t \"cancel in flight\" => 1 passed"
  )
  assert.match((await complete()).content, /Task acceptance completed for/)
})

test("routine turns, disabled routing, errors and cancellation compact nothing", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 0)
  await assert.rejects(f.call("source", "implement"), /No planning phase/)
  await f.call("source", "plan")
  await brief.settle("source", false)
  assert.equal(f.compacted.length, 0)
  await f.call("source", "plan")
  await f.hooks.prompt({ sessionID: "source", prompt: { text: "Changed requirements" } })
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 0)
  const disabled = fixture(t)
  await registerBrief(disabled.context, () => { throw new Error("disabled") }, { enabled: false })
  assert.equal(disabled.tools.size, 0)
})

test("compaction failures keep the queued phase and concurrent requests do not fork", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const results = await Promise.allSettled([f.call("source", "plan"), f.call("source", "plan")])
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1)
  let attempts = 0
  f.setCompact(async () => { attempts++; throw new Error("compaction lost") })
  await assert.rejects(brief.settle("source", true), /compaction lost/)
  assert.ok(f.stored.get("brief:source").pending)
  f.setCompact(async value => { attempts++; return { id: value.id } })
  await brief.settle("source", true)
  assert.equal(attempts, 2)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.stored.get("brief:source").stage, "planning")
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("brief waits for a manual Handoff and compacts once", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  const waiting = Promise.withResolvers()
  const release = Promise.withResolvers()
  f.context.session.wait = async () => { waiting.resolve(); await release.promise }
  const manual = handoff({ sessionID: "source" })
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
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
  assert.equal(f.stored.get("brief:source").stage, "planning")
  f.finish()
  f.accept()
  await f.call("source", "implement")
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 2)
  const prompts = f.prompts.length
  await brief.settle("source", true)
  assert.equal(f.compacted.length, 2)
  assert.equal(f.prompts.length, prompts)
})

test("manual Handoff during planning keeps the session model", async t => {
  const f = fixture(t)
  const handoff = await registerHandoff(f.context)
  const brief = await registerBrief(f.context, handoff, f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()

  await handoff({ sessionID: "source" })
  f.finish()
  f.accept()
  await f.call("source", "implement")
  await brief.settle("source", true)

  assert.equal(f.sessions.size, 1)
  assert.deepEqual(f.sessions.get("source").model, f.original)
  assert.equal(f.compacted.length, 3)
})

test("new steering while waiting cancels delivery without restoring the stale queue", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  f.context.session.wait = async () => f.hooks.prompt({ sessionID: "source", prompt: { text: "New constraints" } })

  await brief.settle("source", true)

  assert.equal(f.compacted.length, 0)
  assert.equal(f.stored.get("brief:source").submitted, undefined)
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("a compaction failure is retried without losing the authorized implementation", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  f.setCompact(async () => { throw new Error("compaction unavailable") })
  await assert.rejects(brief.settle("source", true), /compaction unavailable/)
  f.setCompact(async value => ({ id: value.id }))
  await brief.settle("source", true)
  f.finish()
  f.accept()
  await f.call("source", "implement", "Executable plan: edit the module")
  await brief.settle("source", true)

  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").pending, undefined)
  assert.match(fs.readFileSync(path.join(f.directory, ".opencode/plans", fs.readdirSync(path.join(f.directory, ".opencode/plans"))[0]), "utf8"), /Executable plan: edit the module/)
})

test("a continuation cannot restart planning or fork an authorized implementation", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()
  await assert.rejects(f.call("source", "plan"), /Already planning/)
  f.accept()
  await f.call("source", "implement", "Plan ready; edit the module next")
  await brief.settle("source", true)

  assert.equal(f.stored.get("brief:source").stage, "implementation")
  assert.equal(f.stored.get("brief:source").planned, true)
  assert.equal(f.stored.get("brief:source").implemented, true)
  await assert.rejects(f.call("source", "plan"), /Implementation is authorized/)
  await assert.rejects(f.call("source", "implement"), /Implementation is already authorized/)
  await f.hooks.prompt({ sessionID: "source", prompt: { text: "Continue" } })
  await assert.rejects(f.call("source", "plan"), /Implementation is authorized/)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 2)
})

test("a repeated check result does not transfer, compact or call the model again", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.finish()
  f.accept()
  await f.call("source", "implement", "Executable plan: verify the module")
  await brief.settle("source", true)

  const settled = {
    compacted: f.compacted.length,
    prompts: f.prompts.length,
    sessions: f.sessions.size
  }
  f.context.session.context = async () => [
    {
      id: "msg_user",
      type: "user",
      content: [{ type: "text", text: "Run the check" }]
    },
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "execute",
          state: {
            status: "completed",
            content: [{ type: "text", text: "1 passed, exit 0" }]
          }
        }
      ]
    }
  ]
  const run = () =>
    handleSuccessfulTurn({
      context: f.context,
      sessionID: "source",
      source: { agent: "build" },
      questionGuard: { check: async () => null },
      emptyResponseGuard: { check: async () => null },
      acceptanceNotifier: async () => false,
      settle: () => brief.settle("source", true)
    })

  await run()
  await run()

  assert.equal(f.compacted.length, settled.compacted)
  assert.equal(f.prompts.length, settled.prompts)
  assert.equal(f.sessions.size, settled.sessions)
  assert.equal(f.stored.get("brief:source").pending, undefined)
})

test("separate plugin instances deliver one compaction", async t => {
  const f = fixture(t)
  const first = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const second = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")

  const results = await Promise.allSettled([
    first.settle("source", true),
    second.settle("source", true)
  ])

  assert.deepEqual(results.map(value => value.status), ["fulfilled", "fulfilled"])
  assert.equal(f.sessions.size, 1)
  assert.equal(f.compacted.length, 1)
})

test("implementation transition rejects missing, empty and invalid acceptance sections", async t => {
  for (const mode of ["missing", "empty", "invalid"]) {
    await t.test(mode, async t => {
      const f = fixture(t)
      const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
      await f.call("source", "plan")
      await brief.settle("source", true)
      if (mode === "empty") f.accept([""])
      if (mode === "invalid") f.accept(["- not an acceptance row"])
      const compacted = f.compacted.length

      await assert.rejects(f.call("source", "implement"), /not ready for implementation/i)
      assert.equal(f.stored.get("brief:source").stage, "planning")
      assert.equal(f.stored.get("brief:source").pending, undefined)
      assert.equal(f.compacted.length, compacted)
    })
  }
})

test("planning keeps production edits behind the implementation transition", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  const plan = f.stored.get(planKey("source"))
  const production = path.join(f.directory, "limit.mjs")
  fs.writeFileSync(production, "export const accepts = value => value <= 10\n")
  const before = (target, tool = "edit") =>
    f.toolHooks["execute.before"]({ sessionID: "source", tool, input: { path: target } })

  assert.equal(typeof f.toolHooks["execute.before"], "function")
  await assert.rejects(before(production), /planning phase/i)
  await assert.doesNotReject(before(plan.file))
  await assert.rejects(f.call("source", "implement"), /not ready for implementation/i)
  await assert.rejects(before(production), /planning phase/i)

  f.accept()
  await f.call("source", "implement")
  await assert.rejects(before(production), /planning phase/i)
  await brief.settle("source", true)
  assert.equal(f.stored.get("brief:source").stage, "implementation")
  await assert.doesNotReject(before(production))
})

test("planning blocks native patch writes outside the managed plan", async t => {
  const f = fixture(t)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  const plan = f.stored.get(planKey("source"))
  const planTarget = path.relative(f.directory, plan.file)
  const patch = (...headers) =>
    f.toolHooks["execute.before"]({
      sessionID: "source",
      tool: "patch",
      input: { patchText: `*** Begin Patch\n${headers.join("\n")}\n*** End Patch\n` }
    })
  const update = target => `*** Update File: ${target}\n@@\n-old\n+new`
  const write = target =>
    f.toolHooks["execute.before"]({
      sessionID: "source",
      tool: "write",
      input: { path: path.join(f.directory, target) }
    })

  await assert.doesNotReject(patch(update(planTarget)))
  await assert.rejects(patch(update("limit.mjs")), /planning phase/i)
  await assert.rejects(patch(update(planTarget), update("limit.mjs")), /planning phase/i)
  await assert.rejects(patch(`*** Add File: limit.mjs\n+new`), /planning phase/i)
  await assert.rejects(patch(`*** Delete File: limit.mjs`), /planning phase/i)
  await assert.rejects(patch(`*** Update File: limit.mjs\n*** Move to: moved.mjs`), /planning phase/i)
  await assert.rejects(write("limit.mjs"), /planning phase/i)

  f.accept()
  await f.call("source", "implement")
  await brief.settle("source", true)
  await assert.doesNotReject(patch(update("limit.mjs")))
})

test("rewriting a criterion under its original ID is rejected", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify the boundary",
    stage: "planning"
  })
  f.accept([
    '- A1 [not checked] Boundary X rejects a stale result | check: test node --test ai-hooks/test/test-brief.mjs -t "boundary x"'
  ])
  await updatePlan(f.context, { sessionID: "source", remaining: "Implement boundary X" })
  f.accept([
    "- A1 [closed] Boundary X accepts a stale result | test: node --test ai-hooks/test/test-brief.mjs -t \"boundary x\" => 1 passed"
  ])

  await assert.rejects(
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" }),
    /approved baseline/i
  )
  assert.ok(fs.existsSync(plan.file))
})

test("an explicit requirement change resets only its evidence", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify both boundaries",
    stage: "planning"
  })
  const check = "node --test ai-hooks/test/test-brief.mjs -t \"boundary x\""
  f.accept([
    `- A1 [not checked] Boundary X rejects a stale result | check: test ${check}`,
    '- A2 [not checked] Boundary Y rejects a stale result | check: test node --test ai-hooks/test/test-brief.mjs -t "boundary y"'
  ])
  await updatePlan(f.context, { sessionID: "source", remaining: "Implement both boundaries" })
  f.accept([
    `- A1 [closed] Boundary X rejects a stale result and reports | baseline: changed | check: test ${check} | test: ${check} => 1 passed`,
    "- A2 [not checked] Boundary Y rejects a stale result"
  ])
  const complete = () => f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })

  await assert.rejects(complete(), /A1.*new user message/i)
  assert.match(fs.readFileSync(plan.file, "utf8"), /A1 \[closed\].*Boundary X rejects a stale result and reports/)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: { text: "Продолжай по исходному плану, критерии не меняй" }
  })
  await assert.rejects(complete(), /A1.*new criterion.*user message/i)
  assert.match(fs.readFileSync(plan.file, "utf8"), /A1 \[closed\].*Boundary X rejects a stale result and reports/)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: {
      text: "Не меняй A1 на: Boundary X rejects a stale result and reports"
    }
  })
  await assert.rejects(complete(), /A1.*new criterion.*user message/i)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: {
      text: "Do not change A1 to: Boundary X rejects a stale result and reports"
    }
  })
  await assert.rejects(complete(), /A1.*new criterion.*user message/i)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: {
      text: 'Это цитата, не поручение: «Измени A1 на: Boundary X rejects a stale result and reports».'
    }
  })
  await assert.rejects(complete(), /A1.*new criterion.*user message/i)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: {
      text: 'A1 stays unchanged, change A2 to "Boundary X rejects a stale result and reports"'
    }
  })
  await assert.rejects(complete(), /A1.*new criterion.*user message/i)
  await f.hooks.prompt({
    sessionID: "source",
    prompt: {
      text: "Change A1 to: Boundary X rejects a stale result and reports"
    }
  })
  await assert.rejects(complete(), /A1.*requirement changed explicitly/i)
  assert.match(fs.readFileSync(plan.file, "utf8"), /A1 \[not checked\] Boundary X rejects a stale result and reports/)
  assert.doesNotMatch(fs.readFileSync(plan.file, "utf8"), /A1.*1 passed/)

  f.accept([
    `- A1 [closed] Boundary X rejects a stale result and reports | test: node --test ai-hooks/test/test-brief.mjs -t "boundary x" => 1 passed`,
    "- A2 [closed] Boundary Y rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t \"boundary y\" => 1 passed"
  ])
  await assert.rejects(complete(), /A1.*predates the requirement change/i)

  f.accept([
    `- A1 [closed] Boundary X rejects a stale result and reports | test: node --test ai-hooks/test/test-brief.mjs -t "boundary x" => 1 passed after the change`,
    "- A2 [closed] Boundary Y rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t \"boundary y\" => 1 passed"
  ])
  assert.match((await complete()).content, /Task acceptance completed for/)
})

test("an explicit change is bound to its criterion ID and invalidates its receipt", async t => {
  const m = await machineFixture(t)
  await registerBrief(m.f.context, await registerHandoff(m.f.context), m.f.policy)
  await m.fire()
  assert.equal(m.receipts().length, 1)
  m.close()

  m.writeRows([
    `- A1 [closed] New machine row | baseline: changed | ${m.declared} | test: ${m.check} => 1 passed`
  ])
  await m.f.hooks.prompt({
    sessionID: m.sessionID,
    prompt: { text: "Change A2 to: New machine row" }
  })
  await assert.rejects(
    m.complete(),
    /A1.*explicit new criterion.*user message/i
  )
  assert.match(
    fs.readFileSync(m.f.stored.get(planKey(m.sessionID)).file, "utf8"),
    /A1 \[closed\] New machine row/
  )

  await m.f.hooks.prompt({
    sessionID: m.sessionID,
    prompt: { text: "Измени A1 на: New machine row" }
  })
  await assert.rejects(
    m.complete(),
    /A1 \[not checked\].*requirement changed explicitly/i
  )

  m.writeRows([`- A1 [closed] New machine row | ${m.declared}`])
  assert.match(
    fs.readFileSync(m.f.stored.get(planKey(m.sessionID)).file, "utf8"),
    /A1 \[closed\] New machine row/
  )
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  await m.fire()
  assert.equal(m.runs(), 2)
  assert.equal(m.receipts().length, 1)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
})

test("a confirmed change updates only its row and its receipt", async t => {
  const m = await machineFixture(t, { rowCount: 2 })
  await registerBrief(m.f.context, await registerHandoff(m.f.context), m.f.policy)
  await m.fire()
  const receiptValue = (key) => {
    const value = { ...m.f.stored.get(key) }
    delete value.at
    return JSON.stringify(value)
  }
  const a1Key = () => m.receipts().find((key) => key.endsWith(":a1"))
  const a2Key = () => m.receipts().find((key) => key.endsWith(":a2"))
  const a2Receipt = receiptValue(a2Key())
  assert.equal(m.receipts().length, 2)

  m.writeRows([
    `- A1 [closed] New machine row | baseline: changed | ${m.declared} | test: ${m.check} => 1 passed`,
    `- A2 [closed] Machine checked row | ${m.declared}`
  ])
  await m.f.hooks.prompt({
    sessionID: m.sessionID,
    prompt: { text: "Change A1 to: New machine row" }
  })
  await assert.rejects(
    m.complete(),
    /A1 \[not checked\].*requirement changed explicitly/i
  )
  const changed = fs.readFileSync(
    m.f.stored.get(planKey(m.sessionID)).file,
    "utf8"
  )
  assert.match(changed, /A1 \[not checked\] New machine row/)
  assert.match(changed, /A2 \[closed\] Machine checked row/)
  assert.ok(a1Key())
  assert.equal(receiptValue(a2Key()), a2Receipt)

  await m.fire()
  m.writeRows([
    `- A1 [closed] New machine row | ${m.declared}`,
    `- A2 [closed] Machine checked row | ${m.declared}`
  ])
  assert.equal(receiptValue(a2Key()), a2Receipt)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
})

test("ambiguous change inputs leave both rows and receipts intact", async t => {
  const m = await machineFixture(t, { rowCount: 2 })
  await registerBrief(m.f.context, await registerHandoff(m.f.context), m.f.policy)
  await m.fire()
  const planState = () =>
    JSON.parse(JSON.stringify(m.f.stored.get(planKey(m.sessionID))))
  const receiptState = () =>
    JSON.stringify(m.receipts().map((key) => [key, m.f.stored.get(key)]))
  const rows = (a1, a2) => m.writeRows([a1, a2])
  const unchanged = async (expectedPlan, expectedReceipts) => {
    await assert.rejects(m.complete(), /A1.*new criterion.*user message/i)
    assert.deepEqual(planState(), expectedPlan)
    assert.equal(receiptState(), expectedReceipts)
    const text = fs.readFileSync(expectedPlan.file, "utf8")
    assert.match(text, /A1 \[closed\] New machine row/)
    assert.match(text, /A2 \[closed\] Machine checked row/)
  }

  rows(
    `- A1 [closed] New machine row | baseline: changed | ${m.declared} | test: ${m.check} => 1 passed`,
    `- A2 [closed] Machine checked row | ${m.declared}`
  )
  let expectedPlan = planState()
  let expectedReceipts = receiptState()
  await m.f.hooks.prompt({
    sessionID: m.sessionID,
    prompt: { text: "Это цитата: «Измени A1 на: New machine row»." }
  })
  await unchanged(expectedPlan, expectedReceipts)

  await m.f.hooks.prompt({
    sessionID: m.sessionID,
    prompt: {
      text: 'A1 stays unchanged, change A2 to "Another machine row"'
    }
  })
  await unchanged(expectedPlan, expectedReceipts)

  rows(
    `- A1 [closed] New machine row | ${m.declared} | test: ${m.check} => 1 passed`,
    `- A2 [closed] Machine checked row | ${m.declared}`
  )
  expectedPlan = planState()
  expectedReceipts = receiptState()
  await assert.rejects(
    m.complete(),
    /A1 criterion changed from its approved baseline/i
  )
  assert.deepEqual(planState(), expectedPlan)
  assert.equal(receiptState(), expectedReceipts)
  const text = fs.readFileSync(expectedPlan.file, "utf8")
  assert.match(text, /A1 \[closed\] New machine row/)
  assert.match(text, /A2 \[closed\] Machine checked row/)
})

test("completion starts with the first unresolved criterion", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify both rows",
    stage: "implementation"
  })
  f.accept([
    "- A1 [not checked] First unresolved row | check: test node --test ai-hooks/test/test-brief.mjs -t \"first unresolved\"",
    "- A2 [not checked] Second unresolved row | check: test node --test ai-hooks/test/test-brief.mjs -t \"second unresolved\""
  ])

  await assert.rejects(
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" }),
    /unfinished: A1 \[not checked\]/i
  )
  assert.ok(fs.existsSync(plan.file))
})

test("a neighboring test or a general pass cannot substitute for the declared check", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify boundary X",
    stage: "planning"
  })
  f.accept([
    "- A1 [not checked] Boundary X rejects a stale result | check: test node --test ai-hooks/test/test-brief.mjs -t \"boundary x\""
  ])
  await updatePlan(f.context, { sessionID: "source", remaining: "Implement boundary X" })
  const complete = () => f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })

  f.accept([
    "- A1 [not checked] Boundary X rejects a stale result | check: test node --test ai-hooks/test/test-brief.mjs -t \"boundary y\""
  ])
  await assert.rejects(complete(), /check changed from its approved baseline/i)
  f.accept([
    "- A1 [closed] Boundary X rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t \"boundary y\" => 1 passed"
  ])
  await assert.rejects(complete(), /does not match its declared test check/i)
  f.accept([
    "- A1 [closed] Boundary X rejects a stale result | test: whole suite passed => 1 passed"
  ])
  await assert.rejects(complete(), /exact scenario\/command anchor/i)
  f.accept([
    '- A1 [closed] Boundary X rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t "boundary x" => 1 failed, exit 1'
  ])
  await assert.rejects(complete(), /exact scenario\/command anchor and observed result/i)
  f.accept([
    '- A1 [closed] Boundary X rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t "boundary x" => 0 tests, exit 0'
  ])
  await assert.rejects(complete(), /exact scenario\/command anchor and observed result/i)
  f.accept([
    '- A1 [closed] Boundary X rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t "Boundary X" => 0 tests, exit 0'
  ])
  await assert.rejects(complete(), /does not match its declared test check/i)
  f.accept([
    '- A1 [closed] Boundary X rejects a stale result | test: node --test ai-hooks/test/test-brief.mjs -t "boundary  x" => 1 passed'
  ])
  await assert.rejects(complete(), /does not match its declared test check/i)
  assert.ok(fs.existsSync(plan.file))
})

test("a declared check must name an exact scenario or a source file, symbol or range", async t => {
  const f = fixture(t)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify boundary X",
    stage: "planning"
  })
  const implement = () =>
    updatePlan(f.context, { sessionID: "source", remaining: "Implement boundary X" })

  f.accept(["- A1 [not checked] Boundary X rejects a stale result | check: test x"])
  await assert.rejects(implement(), /A1.*declared test check needs an exact scenario/i)
  assert.equal(f.stored.get(planKey("source")).stage, "planning")

  f.accept([
    "- A1 [not checked] Boundary X rejects a stale result | check: source missing"
  ])
  await assert.rejects(
    implement(),
    /A1.*declared source check needs an exact file, symbol or range/i
  )
  assert.equal(f.stored.get(planKey("source")).stage, "planning")
  assert.ok(fs.existsSync(plan.file))
})

test("bare evidence is rejected while formatted test and source evidence are accepted", async t => {
  const f = fixture(t)
  fs.writeFileSync(
    path.join(f.directory, "evidence.mjs"),
    'export const value = 1\nconst label = "secret"\n'
  )
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify a behavior and a source property",
    stage: "implementation"
  })
  const complete = () => f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })
  f.accept([
    "- A1 [closed] Runtime behavior | test: x",
    "- A2 [closed] Static property | source: x"
  ])
  await assert.rejects(complete(), /A1.*needs an exact scenario|A2.*needs an existing file/i)

  f.accept([
    "- A1 [closed] Runtime behavior | check: test node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" | test: node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" => 1 passed",
    "- A2 [closed] Static property | check: source evidence.mjs:value | source: evidence.mjs:missing => value is exported"
  ])
  await assert.rejects(complete(), /A2.*existing file, symbol or range/i)

  f.accept([
    "- A1 [closed] Runtime behavior | check: test node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" | test: node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" => 1 passed",
    "- A2 [closed] Static property | check: source evidence.mjs:value | source: evidence.mjs:secret => value is exported"
  ])
  await assert.rejects(complete(), /A2.*existing file, symbol or range/i)

  fs.writeFileSync(path.join(f.directory, "one.mjs"), "export const only = 1\n")
  f.accept([
    "- A1 [closed] Runtime behavior | check: test node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" | test: node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" => 1 passed",
    "- A2 [closed] Static property | check: source one.mjs:1 | source: one.mjs:2 => value is exported"
  ])
  await assert.rejects(complete(), /A2.*existing file, symbol or range/i)

  f.accept([
    "- A1 [closed] Runtime behavior | check: test node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" | test: node --test ai-hooks/test/test-brief.mjs -t \"runtime behavior\" => 1 passed",
    "- A2 [closed] Static property | check: source evidence.mjs:value | source: evidence.mjs:value => value is exported"
  ])
  assert.match((await complete()).content, /Task acceptance completed for/)
  assert.ok(fs.existsSync(plan.file))
})

test("a missing managed plan keeps the open task binding", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const plan = await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Keep the task open",
    stage: "implementation"
  })
  f.accept(["- A1 [not checked] Still open"])
  fs.unlinkSync(plan.file)

  await assert.rejects(
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" }),
    /plan file is missing.*\.opencode\/plans/i
  )
  assert.equal(f.stored.get(planKey("source")).file, plan.file)
})

test("a completed brief authorizes a new independent task in the same session", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  const brief = await registerBrief(f.context, await registerHandoff(f.context), f.policy)
  await f.call("source", "plan")
  await brief.settle("source", true)
  f.accept([
    "- A1 [closed] Deliver the first task | check: test node --test ai-hooks/test/test-brief.mjs -t \"first task\" | test: node --test ai-hooks/test/test-brief.mjs -t \"first task\" => 1 passed"
  ])
  f.finish()
  await f.call("source", "implement")
  await brief.settle("source", true)
  const complete = () =>
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" })
  assert.match((await complete()).content, /Task acceptance completed for/)
  fs.unlinkSync(f.stored.get(planKey("source")).file)
  assert.match((await complete()).content, /Task acceptance completed for/)

  f.finish()
  await f.call("source", "plan", "New independent task")
  await brief.settle("source", true)

  assert.equal(f.stored.get("brief:source").stage, "planning")
  const event = { sessionID: "source", tools: {}, system: [] }
  await f.hooks.context(event)
  const instructions = event.system.map(value => value.text).join("\n")
  assert.match(instructions, /Planning phase/)
  assert.doesNotMatch(instructions, /Before editing/)
})

test("acceptance records an executed passing test once", async t => {
  const m = await machineFixture(t)
  m.close()
  await m.fire()

  assert.equal(m.runs(), 1)
  assert.equal(m.receipts().length, 1)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
  assert.equal(m.runs(), 1)
  assert.deepEqual(m.receipts(), [])
  assert.match((await m.complete()).content, /Task acceptance completed for/)
  assert.equal(m.runs(), 1)
})

test("a test receipt needs an observed command run", async t => {
  const m = await machineFixture(t)
  await m.fire({
    run: false,
    output: [
      "✔ machine target (1ms)",
      "ℹ tests 1",
      "ℹ pass 1",
      "ℹ fail 0",
      "ℹ cancelled 0",
      "ℹ skipped 0",
      "ℹ todo 0"
    ].join("\n")
  })

  assert.equal(m.runs(), 0)
  assert.deepEqual(m.receipts(), [])
})

test("a receipt requires the command to run in the plan directory", async t => {
  const m = await machineFixture(t)
  m.close()
  const other = path.join(m.f.directory, "other")
  fs.mkdirSync(other)
  fs.writeFileSync(
    path.join(other, "machine.test.mjs"),
    'import { test } from "node:test"\ntest("machine target", () => {})\n'
  )
  await m.fire({ workdir: "other" })

  assert.deepEqual(m.receipts(), [])
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
})

test("one executed command records the same run for every matching row", async t => {
  const m = await machineFixture(t, { rowCount: 2 })
  await m.fire()

  assert.equal(m.runs(), 1)
  assert.equal(m.receipts().length, 2)
  m.writeRows([
    `- A1 [closed] Machine checked row | ${m.declared}`,
    `- A2 [closed] Machine checked row | ${m.declared}`
  ])
  assert.match((await m.complete()).content, /Task acceptance completed for/)
  assert.equal(m.runs(), 1)
})

test("a receipt belongs to its own tool call, not to the command text", async t => {
  const passing = [
    "✔ machine target (1ms)",
    "ℹ tests 1",
    "ℹ pass 1",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ skipped 0",
    "ℹ todo 0"
  ].join("\n")
  for (const order of ["other-first", "root-first"]) {
    const m = await machineFixture(t)
    m.close()
    const command = m.check
    const before = (id, input) =>
      m.f.toolHooks["execute.before"]({
        sessionID: m.sessionID,
        tool: "shell",
        id,
        input
      })
    const after = (id, input, output, exit) =>
      m.f.toolHooks["execute.after"]({
        sessionID: m.sessionID,
        tool: "shell",
        id,
        status: "completed",
        input,
        result: { output, metadata: { exit } }
      })

    await before("root-call", { command })
    await before("other-call", { command, workdir: "other" })
    if (order === "other-first") {
      await after("other-call", { command, workdir: "other" }, passing, 0)
      await after("root-call", { command }, "", 1)
    } else {
      await after("root-call", { command }, "", 1)
      await after("other-call", { command, workdir: "other" }, passing, 0)
    }

    assert.deepEqual(m.receipts(), [], order)
    await assert.rejects(
      m.complete(),
      /A1 machine check needs a recorded passing test run/i
    )
  }
})

test("acceptance rejects a failed recorded test", async t => {
  const m = await machineFixture(t, {
    body: 'test("machine target", () => { throw new Error("boom") })'
  })
  m.close("1 passed")
  await m.fire()

  assert.deepEqual(m.receipts(), [])
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
})

test("acceptance rejects a run with zero selected tests", async t => {
  const m = await machineFixture(t, { name: "missing target" })
  m.close()
  await m.fire()

  assert.deepEqual(m.receipts(), [])
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
})

test("acceptance rejects skipped and todo tests", async t => {
  for (const body of [
    'test("machine target", { skip: true }, () => {})',
    'test("machine target", { todo: true }, () => {})'
  ]) {
    const m = await machineFixture(t, { body })
    m.close()
    await m.fire()

    assert.deepEqual(m.receipts(), [], body)
    await assert.rejects(
      m.complete(),
      /A1 machine check needs a recorded passing test run/i
    )
  }
})

test("acceptance matches the exact test name and file", async t => {
  const m = await machineFixture(t)
  m.close()
  await m.fire({
    command: 'node --test --test-name-pattern "^machine target$" other.test.mjs'
  })
  await m.fire({
    command: 'node --test --test-name-pattern "^Machine target$" machine.test.mjs'
  })
  await m.fire({
    command:
      'node --test --test-name-pattern "^machine target extra$" machine.test.mjs'
  })

  assert.deepEqual(m.receipts(), [])
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  await m.fire()
  assert.equal(m.receipts().length, 1)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
})

test("acceptance records no receipt for an interrupted run", async t => {
  const m = await machineFixture(t)
  m.close()
  await m.f.toolHooks["execute.before"]({
    sessionID: m.sessionID,
    tool: "shell",
    id: "interrupted-call",
    input: { command: m.check }
  })
  await m.fire({
    run: false,
    id: "interrupted-call",
    exitCode: null,
    output: [
      "✔ machine target (1ms)",
      "ℹ tests 1",
      "ℹ pass 1",
      "ℹ fail 0",
      "ℹ cancelled 0",
      "ℹ skipped 0",
      "ℹ todo 0"
    ].join("\n")
  })

  assert.deepEqual(m.receipts(), [])
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
})

test("acceptance requires a receipt for a machine checked row", async t => {
  const m = await machineFixture(t)
  m.close("1 passed")

  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
  assert.deepEqual(m.receipts(), [])
})

test("a machine checked row cannot fall back to manual evidence after its input disappears", async t => {
  const m = await machineFixture(t, {
    inputs: ["machine.test.mjs", "input.txt"]
  })
  const testFile = path.join(m.f.directory, "machine.test.mjs")
  const inputFile = path.join(m.f.directory, "input.txt")
  const source = fs.readFileSync(testFile, "utf8")
  fs.writeFileSync(inputFile, "stable")
  m.close()

  fs.unlinkSync(testFile)
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run; its test file or inputs are missing/i
  )
  assert.deepEqual(m.receipts(), [])

  fs.writeFileSync(testFile, source)
  fs.unlinkSync(inputFile)
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run; its test file or inputs are missing/i
  )
  assert.deepEqual(m.receipts(), [])

  fs.writeFileSync(inputFile, "stable")
  await m.fire()
  assert.equal(m.runs(), 1)
  assert.equal(m.receipts().length, 1)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
})

test("a declared machine check keeps its mode before the test file exists", async t => {
  const f = fixture(t)
  await registerContextCache(f.context)
  await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Verify a future machine check",
    stage: "planning"
  })
  const check =
    'node --test --test-name-pattern "^future target$" future.test.mjs'
  f.accept([
    `- A1 [not checked] Future machine row | check: test ${check} | inputs: future.test.mjs`
  ])
  await updatePlan(f.context, {
    sessionID: "source",
    stage: "implementation",
    remaining: "Run the future machine check"
  })
  f.accept([
    `- A1 [closed] Future machine row | check: test ${check} | inputs: future.test.mjs | test: ${check} => 1 passed`
  ])

  await assert.rejects(
    f.tools.get("context_cache").execute({ action: "complete" }, { sessionID: "source" }),
    /A1 machine check needs a recorded passing test run; its test file or inputs are missing/i
  )
})

test("acceptance invalidates only receipts with changed inputs", async t => {
  const m = await machineFixture(t, {
    inputs: ["machine.test.mjs", "input.txt"]
  })
  fs.writeFileSync(path.join(m.f.directory, "input.txt"), "stable")
  m.close()
  await m.fire()
  assert.equal(m.receipts().length, 1)

  fs.writeFileSync(path.join(m.f.directory, "input.txt"), "changed")
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  fs.writeFileSync(path.join(m.f.directory, "input.txt"), "stable")
  assert.match((await m.complete()).content, /Task acceptance completed for/)
  assert.equal(m.runs(), 1)

  const during = await machineFixture(t, {
    inputs: ["machine.test.mjs", "input.txt"],
    body: 'test("machine target", () => { fs.writeFileSync("input.txt", "changed") })'
  })
  fs.writeFileSync(path.join(during.f.directory, "input.txt"), "stable")
  during.close()
  await during.fire()

  assert.deepEqual(during.receipts(), [])
  await assert.rejects(
    during.complete(),
    /A1 machine check needs a recorded passing test run/i
  )
})

test("acceptance binds receipts to the task row and approved check", async t => {
  const m = await machineFixture(t)
  m.close()
  await m.fire()
  const [key] = m.receipts()
  const receipt = m.f.stored.get(key)
  assert.equal(m.receipts().length, 1)

  const otherPlan = key.replace(`:${m.plan.id}:`, ":other-plan:")
  m.f.stored.delete(key)
  m.f.stored.set(otherPlan, receipt)
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  const otherRow = key.replace(":a1", ":a2")
  m.f.stored.delete(otherPlan)
  m.f.stored.set(otherRow, receipt)
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  m.f.stored.delete(otherRow)
  m.f.stored.set(key, { ...receipt, checkHash: "tampered" })
  await assert.rejects(
    m.complete(),
    /A1 machine check needs a recorded passing test run/i
  )

  m.f.stored.set(key, receipt)
  await registerContextCache(m.f.context)
  assert.equal(m.f.stored.get(key).checkHash, receipt.checkHash)
  assert.match((await m.complete()).content, /Task acceptance completed for/)
})

test("acceptance keeps manual and legacy evidence distinct", async t => {
  const f = fixture(t)
  fs.writeFileSync(
    path.join(f.directory, "legacy.mjs"),
    "export const legacy = 1\n"
  )
  await registerContextCache(f.context)
  await createPlan(f.context, {
    sessionID: "source",
    directory: f.directory,
    objective: "Manual checks",
    stage: "planning"
  })
  f.accept([
    '- A1 [not checked] Manual runtime | check: test node --test ai-hooks/test/test-brief.mjs -t "manual runtime"',
    "- A2 [not checked] Static source | check: source legacy.mjs:legacy"
  ])
  await updatePlan(f.context, {
    sessionID: "source",
    remaining: "Run the manual checks"
  })
  f.accept([
    '- A1 [closed] Manual runtime | test: node --test ai-hooks/test/test-brief.mjs -t "manual runtime" => 1 passed',
    "- A2 [closed] Static source | source: legacy.mjs:legacy => legacy export exists"
  ])
  assert.match(
    (await f.tools.get("context_cache").execute(
      { action: "complete" },
      { sessionID: "source" }
    )).content,
    /Task acceptance completed for/
  )
  assert.deepEqual(
    [...f.stored.keys()].filter(key => key.startsWith("test-receipt:")),
    []
  )

  const legacy = fixture(t)
  await registerContextCache(legacy.context)
  await createPlan(legacy.context, {
    sessionID: "source",
    directory: legacy.directory,
    objective: "Legacy plan",
    stage: "implementation"
  })
  legacy.accept([
    '- A1 [closed] Legacy runtime | check: test node --test ai-hooks/test/test-brief.mjs -t "legacy runtime" | test: node --test ai-hooks/test/test-brief.mjs -t "legacy runtime" => 1 passed'
  ])
  assert.match(
    (await legacy.tools.get("context_cache").execute(
      { action: "complete" },
      { sessionID: "source" }
    )).content,
    /Task acceptance completed for/
  )
  assert.deepEqual(
    [...legacy.stored.keys()].filter(key => key.startsWith("test-receipt:")),
    []
  )
})

test("acceptance runs only the supported scoped test command", async t => {
  const f = fixture(t)
  fs.writeFileSync(
    path.join(f.directory, "target.test.mjs"),
    'import { test } from "node:test"\ntest("machine target", () => {})\n'
  )
  fs.writeFileSync(path.join(f.directory, "input.txt"), "stable")
  const anchor =
    'node --test --test-name-pattern "^machine target$" target.test.mjs'
  const spec = parseMachineCheck(
    { kind: "test", anchor, inputs: ["target.test.mjs", "input.txt"] },
    f.directory
  )

  assert.equal(spec.testName, "machine target")
  assert.equal(spec.file, "target.test.mjs")
  assert.deepEqual(spec.inputs, ["input.txt", "target.test.mjs"])
  for (const unsupported of [
    `${anchor}; rm -rf .`,
    `${anchor} --test-reporter=spec`,
    'node --test --test-name-pattern "^machine target$" *.test.mjs',
    'node --test --test-name-pattern "^machine target$" ../outside.test.mjs',
    "node --test target.test.mjs"
  ])
    assert.equal(
      parseMachineCheck(
        { kind: "test", anchor: unsupported, inputs: ["target.test.mjs"] },
        f.directory
      ),
      null,
      unsupported
    )
  assert.equal(
    parseMachineCheck(
      { kind: "test", anchor, inputs: ["../outside.txt"] },
      f.directory
    ),
    null
  )
  assert.equal(commandRunsMachineCheck(`${anchor} | cat`, spec, f.directory), false)
})

test("brief policy validates configured model identifiers and effort", t => {
  const f = fixture(t)
  const file = path.join(f.directory, "policy.json")
  fs.writeFileSync(file, JSON.stringify({ opencode: { enabled: true, planner: { providerID: "provider", id: "model" } } }))
  assert.equal(readBriefPolicy("opencode", file).planner.id, "model")
  assert.equal(readBriefPolicy("opencode").enabled, true)
  assert.equal(readBriefPolicy("opencode").planner, undefined)
})
