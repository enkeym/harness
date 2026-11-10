import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { loadConfig, readConfig, writeConfig } from "../../opencode/config.mjs"
import { contextPolicy } from "../bin/context-policy.mjs"
import { configureModelRouting } from "../../opencode/model-routing.mjs"
import { observationDirectory } from "../../opencode/observations.mjs"

function sandbox(t, beforeCleanup = async () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-opencode-"))
  t.after(async () => {
    await beforeCleanup()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test("MCP sync rejects removed, unknown and conflicting client flags without writing", (t) => {
  const directory = sandbox(t)
  for (const args of [["--qwen"], ["--unknown"], ["--codex", "--opencode"]]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"), ...args],
      {
        env: {
          ...process.env,
          HOME: directory,
          OPENCODE_CONFIG_DIR: directory
        },
        encoding: "utf8"
      }
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Использование/)
    assert.deepEqual(fs.readdirSync(directory), [])
  }
})

test("OpenCode preserves settings and detects drift without writing", (t) => {
  const directory = sandbox(t)
  const settings = path.join(directory, "opencode.jsonc")
  const original = JSON.stringify({
    model: "user/model",
    mcp: { servers: { custom: { type: "local", command: ["custom"] } } }
  })
  fs.writeFileSync(settings, original)
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"),
        "--opencode",
        ...args
      ],
      {
        env: { ...process.env, OPENCODE_CONFIG_DIR: directory },
        encoding: "utf8"
      }
    )
  assert.equal(run("--check").status, 1)
  assert.equal(fs.readFileSync(settings, "utf8"), original)
  const result = run()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const installed = JSON.parse(fs.readFileSync(settings, "utf8"))
  assert.equal(installed.model, "user/model")
  assert.deepEqual(installed.mcp.servers.custom, {
    type: "local",
    command: ["custom"]
  })
  assert.deepEqual(Object.keys(installed.mcp.servers).sort(), [
    "custom",
    "playwright",
    "ragsave",
    "tokensave"
  ])
  const before = fs.statSync(settings).mtimeMs
  assert.equal(run("--check").status, 0)
  assert.equal(fs.statSync(settings).mtimeMs, before)
})

test("OpenCode installer preserves both configs and reports conflicting skills", (t) => {
  const home = sandbox(t)
  const directory = path.join(home, "opencode")
  fs.mkdirSync(path.join(directory, "skills"), { recursive: true })
  fs.mkdirSync(path.join(directory, "plugins"))
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../../opencode/harness.js"),
    path.join(directory, "plugins/harness.js")
  )
  fs.symlinkSync("/missing/skill", path.join(directory, "skills/task-brief"))
  const alternative = path.join(directory, "opencode.json")
  const settings = path.join(directory, "opencode.jsonc")
  fs.writeFileSync(alternative, '{"model":"user/model"}')
  fs.writeFileSync(
    settings,
    '{ // user config\n "instructions": ["custom.md"],\n "commands": {"handoff": {"template": "Personal handoff"}},\n}'
  )
  const before = fs.readFileSync(settings, "utf8")
  const run = (...args) =>
    spawnSync(
      "bash",
      [
        path.resolve(import.meta.dirname, "../../install.sh"),
        "--opencode",
        ...args
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/bash",
          OPENCODE_CONFIG_DIR: directory
        },
        encoding: "utf8",
        timeout: 10000
      }
    )

  assert.equal(run("--check").status, 1)
  assert.equal(fs.readFileSync(settings, "utf8"), before)
  assert.equal(
    fs.readlinkSync(path.join(directory, "skills/task-brief")),
    "/missing/skill"
  )
  const conflict = run()
  assert.equal(conflict.status, 1)
  assert.equal(fs.readlinkSync(path.join(directory, "skills/task-brief")), "/missing/skill")
  fs.unlinkSync(path.join(directory, "skills/task-brief"))
  const installed = run()
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.equal(loadConfig(directory).current.model, "user/model")
  assert.ok(loadConfig(directory).current.providers.deepseek)
  assert.ok(loadConfig(directory).current.instructions.includes("custom.md"))
  assert.ok(!loadConfig(directory).current.instructions.some(value => /(?:rules\/core|opencode\/AGENTS)\.md$/.test(value)))
  assert.equal(loadConfig(directory).current.experimental.background_compaction, false)
  assert.ok(fs.existsSync(path.join(directory, "skills/task-brief/SKILL.md")))
  assert.ok(fs.existsSync(path.join(directory, "skills/handoff/SKILL.md")))
  assert.equal(fs.existsSync(path.join(directory, "plugins/harness.js")), false)
  assert.equal(
    fs.realpathSync(path.join(directory, "plugins/harness")),
    path.resolve(import.meta.dirname, "../../opencode")
  )
  assert.deepEqual(loadConfig(directory).current.commands.handoff, { template: "Personal handoff" })
  assert.equal(loadConfig(directory).current.compaction.auto, true)
  assert.equal(
    loadConfig(directory).current.compaction.buffer,
    contextPolicy.opencode.maxTokens - contextPolicy.opencode.startTokens
  )
  assert.deepEqual(loadConfig(directory).current.compaction.keep, {
    tokens: contextPolicy.opencode.keepTokens
  })
  assert.equal(
    fs.realpathSync(path.join(directory, "agents/ask.md")),
    path.resolve(import.meta.dirname, "../../opencode/agent/ask.md")
  )
  assert.match(fs.readFileSync(settings, "utf8"), /user config/)
  const checked = run("--check")
  assert.equal(checked.status, 0, checked.stderr + checked.stdout)
  assert.equal(fs.readFileSync(alternative, "utf8"), '{"model":"user/model"}')
})

test("model routing removes legacy overrides and preserves user configuration", (t) => {
  const directory = sandbox(t)
  const settings = path.join(directory, "opencode.jsonc")
  const config = {
    model: "deepseek/deepseek-v4-pro#max",
    agents: {
      plan: { model: "deepseek/deepseek-flash#high", description: "Preserve me" },
      explore: { model: "custom/model" },
      compaction: { model: { providerID: "deepseek", id: "deepseek-flash" } },
      "harness-review": { model: "deepseek/deepseek-v4-pro" },
      custom: { model: "deepseek/deepseek-v4-pro#max" }
    },
    commands: { "harness-review": { agent: "harness-review" }, custom: { template: "Preserve me" } }
  }
  configureModelRouting(config)
  writeConfig(settings, config)
  const loaded = loadConfig(directory).current
  assert.equal(loaded.model, "deepseek/deepseek-v4-pro#max")
  assert.equal(loaded.agents.plan.model, undefined)
  assert.equal(loaded.agents.plan.description, "Preserve me")
  assert.equal(loaded.agents.compaction.model, undefined)
  assert.equal(loaded.agents.explore.model, "custom/model")
  assert.equal(loaded.agents.custom.model, "deepseek/deepseek-v4-pro#max")
  assert.equal(loaded.agents["harness-review"], undefined)
  assert.equal(loaded.commands["harness-review"], undefined)
  assert.equal(loaded.commands.custom.template, "Preserve me")
  const repeated = structuredClone(loaded)
  configureModelRouting(repeated)
  assert.deepEqual(repeated, loaded)
  repeated.agents.plan.model = "deepseek/deepseek-v4-pro#max"
  configureModelRouting(repeated)
  assert.equal(repeated.agents.plan.model, undefined)
  const inherited = { agents: { build: { model: "deepseek/deepseek-v4-pro#max" }, general: { model: { providerID: "deepseek", id: "deepseek-v4-pro" } } } }
  configureModelRouting(inherited)
  assert.equal(inherited.agents.build.model, undefined)
  assert.equal(inherited.agents.general.model, undefined)
  const empty = {}
  configureModelRouting(empty)
  assert.deepEqual(empty, {})
  const other = { model: "custom/model", agents: { build: { model: "custom/model" }, "harness-plan": {} } }
  configureModelRouting(other)
  assert.equal(other.model, "custom/model")
  assert.equal(other.agents.build.model, "custom/model")
  assert.equal(other.agents["harness-plan"], undefined)
})

test("every bundled DeepSeek model carries the working input limit", () => {
  const config = readConfig(
    path.resolve(import.meta.dirname, "../../opencode/opencode.jsonc")
  )
  const models = config.providers.deepseek.models
  for (const [name, model] of Object.entries(models)) {
    assert.equal(
      model.limit?.input,
      contextPolicy.opencode.maxTokens,
      `${name} must declare the working input limit`
    )
    assert.equal(
      model.limit?.output,
      contextPolicy.maxOutputTokens,
      `${name} must declare the working output limit`
    )
  }
})

test("OpenCode sends skill and search routing to custom and built-in agents", async (t) => {
  let child
  let server
  const directory = sandbox(t, async () => {
    if (child && child.exitCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exit
    }
    server?.closeAllConnections()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
  })
  const config = path.join(directory, "config")
  for (const name of ["agents", "plugins"]) {
    fs.mkdirSync(path.join(config, name), { recursive: true })
  }
  for (const [target, source] of [
    ["agents/ask.md", "opencode/agent/ask.md"]
  ]) {
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../..", source),
      path.join(config, target)
    )
  }
  const fixturePlugin = path.join(config, "plugins/harness")
  fs.mkdirSync(fixturePlugin)
  fs.writeFileSync(path.join(fixturePlugin, "package.json"), JSON.stringify({ name: "harness-fixture", type: "module", exports: { "./server": "./server.mjs" } }))
  const duplicateRead = `file: fixture.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n${"CACHE_EVIDENCE_BODY\n".repeat(60)}`
  fs.writeFileSync(path.join(fixturePlugin, "server.mjs"), `
import harness from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../opencode/harness.js")).href)}
import fs from "node:fs"
export default { id: "harness", setup: async context => {
  await context.session.hook("context", event => {
    if (!JSON.stringify(event.messages).includes("CACHE_PROJECTION_FIXTURE")) return
    event.system.push({ type: "text", text: "Harness skill instructions:\\nSTALE_INSTRUCTION_FIXTURE" }, { type: "text", text: "DeepSeek model routing: STALE_ROUTING_FIXTURE" })
    const text = ${JSON.stringify(duplicateRead)}
    event.messages.unshift(...["read-first", "read-second"].flatMap(id => [
      { role: "assistant", content: [{ type: "tool-call", id, name: "execute", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", id, name: "execute", result: { type: "text", value: text } }] }
    ]))
  })
  const cleanup = await harness.setup(context)
  const tools = await context.tool.list()
  fs.writeFileSync(${JSON.stringify(path.join(directory, "native-tools.json"))}, JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, input: tool.input }))))
  return cleanup
} }
`)
  const requests = []
  let successful = false
  let primaryCalls = 0
  let stallNextFlash = false
  const briefStages = new Set()
  let completedTask = false
  server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    requests.push({ ...input, fixtureURL: request.url })
    if (successful) {
      const primary =
        Boolean(input.tools?.length) &&
        !JSON.stringify(input).includes("Harness automatic Handoff.")
      if (primary) primaryCalls++
      const stalled =
        primary && input.model === "deepseek-flash" && stallNextFlash
      if (stalled) stallNextFlash = false
      const text = stalled
        ? "Hypotheses A and B checked without new evidence.\nHARNESS-ROUTE: progress=stalled next=investigate"
        : primary
          ? "Fixture step completed."
          : "## Objective\n- Handoff fixture: continue the authorized objective.\n\n## Requirements\n- Preserve permissions.\n\n## Decisions\n- Continue the remaining plan.\n\n## Work State\n### Completed\n- First step.\n### Active\n- Next step.\n### Blocked\n- (none)\n\n## Next Move\n1. Execute the next authorized step.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- Local compaction fixture."
      const usage = {
        input_tokens: primary && primaryCalls === 1 ? contextPolicy.opencode.startTokens : 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: primary && primaryCalls === 1 ? contextPolicy.opencode.startTokens + 20 : 1020
      }
      const part = { type: "output_text", text, annotations: [] }
      const briefStage = input.tools?.some(tool => tool.name === "execute")
        ? JSON.stringify(input).includes("BRIEF_NATIVE_ANSWERS") ? "implement" : JSON.stringify(input).includes("BRIEF_NATIVE_START") ? "plan" : undefined
        : undefined
      const transition = briefStage && !briefStages.has(briefStage)
      if (transition) briefStages.add(briefStage)
      const completeTask = primary && JSON.stringify(input).includes("TASK_NATIVE_COMPLETE") && !completedTask
      if (completeTask) completedTask = true
      const callStage = completeTask ? "complete" : briefStage
      const handoff = briefStage === "plan" ? "BRIEF_NATIVE_HANDOFF. Design the module; resolve nodata. Implementation authorized." : "BRIEF_NATIVE_HANDOFF. Plan: .opencode/plans/native.md. Answers: neutral nodata. Implementation authorized."
      const item = transition || completeTask ? {
        id: `fc_brief_${callStage}`,
        type: "function_call",
        call_id: `call_brief_${callStage}`,
        name: "execute",
        arguments: JSON.stringify({ code: completeTask ? 'return await tools.task_context({action:"complete"});' : `${briefStage === "plan" ? 'await tools.task_context({action:"save",checkpoint:"NATIVE_TASK_CHECKPOINT: next edit source.mjs"});' : 'await tools.task_context({action:"restore"});'} return await tools.brief_transition(${JSON.stringify({ stage: briefStage, handoff })});` }),
        status: "completed"
      } : {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [part]
      }
      const result = {
        id: "resp_fixture",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "model",
        output: [item],
        usage
      }
      if (input.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          (transition || completeTask ? [
            { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
            { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: result }
          ] : [
            {
              type: "response.created",
              response: { ...result, status: "in_progress", output: [] }
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] }
            },
            {
              type: "response.content_part.added",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              part: { ...part, text: "" }
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: text
            },
            {
              type: "response.output_text.done",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              text
            },
            {
              type: "response.content_part.done",
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              part
            },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: result }
          ])
            .map(
              (value, sequence_number) =>
                `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number })}\n\n`
            )
            .join("")
        )
      } else {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(result))
      }
      return
    }
    response.writeHead(401, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        error: {
          message: "Local routing fixture",
          type: "authentication_error"
        }
      })
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const routing = { model: "deepseek/deepseek-flash" }
  configureModelRouting(routing)
  fs.writeFileSync(
    path.join(config, "opencode.jsonc"),
    JSON.stringify({
      model: "fixture/model",
      agents: routing.agents,
      commands: routing.commands,
      compaction: {
        auto: true,
        buffer: contextPolicy.opencode.maxTokens - contextPolicy.opencode.startTokens,
        keep: { tokens: 0 }
      },
      providers: {
        deepseek: {
          package: "@ai-sdk/openai",
          settings: {
            baseURL: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: "fixture-key"
          },
          models: Object.fromEntries(
            ["deepseek-flash", "deepseek-v4-pro"].map((modelID) => [
              modelID,
              { modelID, limit: { context: 1000000, output: 1000 } }
            ])
          )
        },
        fixture: {
          package: "@ai-sdk/openai",
          settings: {
            baseURL: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: "fixture-key"
          },
          models: {
            model: {
              modelID: "model",
              settings: { api: "chat" },
              limit: { context: 1000000, output: 1000 }
            }
          }
        }
      }
    })
  )
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  child = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: directory,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: path.join(directory, "xdg"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_STATE_HOME: path.join(directory, "state")
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  )
  let log = ""
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      log += chunk
    })
  const wait = async (predicate) => {
    const deadline = Date.now() + 15000
    while (!predicate() && child.exitCode === null && Date.now() < deadline)
      await setTimeout(25)
    assert.ok(
      predicate(),
      log.replace(/server password \S+/g, "server password [redacted]")
    )
  }
  await wait(() => /server password \S+/.test(log))
  const authorization = `Basic ${Buffer.from(`opencode:${log.match(/server password (\S+)/)[1]}`).toString("base64")}`
  const api = async (url, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
    assert.ok(response.ok, response.ok ? url : `${url}: ${response.status}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  for (const agent of ["ask", "build", "plan"]) {
    const start = requests.length
    const session = await api("/session", {
      agent,
      title: "Routing fixture",
      location: { directory },
      model: { providerID: "fixture", id: "model" }
    })
    await api(`/session/${session.data.id}/prompt`, {
      text: "Reply OK without tools."
    })
    await wait(() => requests.slice(start).some((value) => value.tools?.length))
    const primary = requests.slice(start).filter((value) => value.tools?.length)
    const messages = primary.flatMap((value) => value.messages ?? [])
    const system = primary
      .map((value) => value.instructions ?? "")
      .concat(
        messages
          .filter(
            (value) => value.role === "system" || value.role === "developer"
          )
          .map((value) => value.content)
      )
      .join("\n")
    assert.match(system, /Harness skill instructions:/, agent)
    assert.equal(system.split("# Working rules").length - 1, primary.length, agent)
    assert.equal(system.split("# OpenCode harness").length - 1, primary.length, agent)
    assert.match(system, /Never add or rewrite code\/documentation comments/, agent)
    assert.match(system, /Read applicable SKILL.md/, agent)
    assert.match(system, /Never load the same skill twice in a session/, agent)
    assert.equal(system.includes("load both review checks before every commit"), false, agent)
    assert.match(system, /exact, case-sensitive `id` from the current available-skills catalog/, agent)
    assert.match(system, /load it with `\{"id":"opencode"\}`/, agent)
    assert.match(system, /never repeat an unchanged invalid ID/, agent)
    assert.match(system, /tokensave_search/, agent)
    assert.match(system, /rag_search/, agent)
    assert.match(system, /outside the index/, agent)
    assert.match(
      system,
      /Before a fallback, state the specific failing MCP call/,
      agent
    )
    assert.match(
      system,
      /A missing optional tool does not make the other MCP tools unavailable/,
      agent
    )
    assert.match(system, /handoff, continuation, simple task/, agent)
    const summaryStart = requests.length
    await api(`/session/${session.data.id}/compact`, {})
    await wait(() =>
      requests
        .slice(summaryStart)
        .some((value) =>
          JSON.stringify(value).includes("Harness automatic Handoff.")
        )
    )
    const compaction = requests.slice(summaryStart).find(value => JSON.stringify(value).includes("Harness automatic Handoff."))
    assert.match(JSON.stringify(compaction), /Saved task context:/, agent)
    assert.match(JSON.stringify(compaction), /Reply OK without tools\./, agent)
    const cached = fs.readdirSync(path.join(directory, ".opencode/task-context")).map(file => JSON.parse(fs.readFileSync(path.join(directory, ".opencode/task-context", file), "utf8")))
    assert.ok(cached.some(value => value.checkpoint === "Reply OK without tools."), agent)
  }
  successful = true
  const session = await api("/session", {
    agent: "build",
    title: "Automatic Handoff fixture",
    location: { directory },
    model: { providerID: "fixture", id: "model" }
  })
  await api(`/session/${session.data.id}/prompt`, {
    text: "Initial context fixture. Continue the authorized objective."
  })
  const deadline = Date.now() + 15000
  let first
  do {
    first = await api(`/session/${session.data.id}/context`)
    if (
      first.data.some(
        (value) => value.type === "assistant" && value.time.completed
      )
    )
      break
    await setTimeout(25)
  } while (Date.now() < deadline)
  assert.ok(
    first.data.some(
      (value) => value.type === "assistant" && value.tokens?.input === contextPolicy.opencode.startTokens
    ),
    JSON.stringify({
      context: first,
      primaryCalls,
      lastRequests: requests.slice(-3).map((value) => ({
        keys: Object.keys(value),
        url: value.fixtureURL,
        stream: value.stream,
        tools: value.tools?.length,
        model: value.model
      }))
    })
  )
  const observationFile = path.join(
    observationDirectory(directory, path.join(directory, "state")),
    "sessions",
    `${session.data.id}.json`
  )
  await wait(() => fs.existsSync(observationFile))
  const observation = JSON.parse(fs.readFileSync(observationFile, "utf8"))
  assert.equal(observation.sessionID, session.data.id)
  assert.equal(observation.delegation.childrenComplete, true)
  assert.ok(observation.sequence.some((step) => step.tokens?.input === contextPolicy.opencode.startTokens))
  assert.equal(observation.money.validatedUSD, null)
  const summaryStart = requests.length
  await api(`/session/${session.data.id}/prompt`, {
    text: "Execute the next authorized step."
  })
  try {
    await wait(() => primaryCalls >= 2)
  } catch (error) {
    throw new Error(
      JSON.stringify({
        primaryCalls,
        requests: requests.slice(summaryStart).map((value) => ({
          tools: value.tools?.length,
          handoff: JSON.stringify(value).includes("Harness automatic Handoff."),
          summary: JSON.stringify(value).includes("Handoff fixture"),
          inputTail: JSON.stringify(value.input).slice(-200)
        })),
        context: await api(`/session/${session.data.id}/context`)
      }),
      { cause: error }
    )
  }
  const automatic = requests.slice(summaryStart)
  assert.ok(
    automatic.some((value) =>
      JSON.stringify(value).includes("Harness automatic Handoff.")
    )
  )
  const resumed = automatic.find(
    (value) =>
      value.tools?.length &&
      !JSON.stringify(value).includes("Harness automatic Handoff.")
  )
  assert.match(JSON.stringify(resumed.input), /Handoff fixture/)
  assert.match(
    JSON.stringify(resumed.input),
    /Execute the next authorized step/
  )
  assert.doesNotMatch(JSON.stringify(resumed.input), /Initial context fixture/)
  const manualStart = requests.length
  const eventsAbort = new AbortController()
  t.after(() => eventsAbort.abort())
  const eventResponse = await fetch(
    `http://127.0.0.1:${port}/api/event?types=rpc.harness.handoff.changed`,
    {
      headers: { authorization },
      signal: eventsAbort.signal
    }
  )
  assert.ok(eventResponse.ok)
  let events = ""
  const eventTask = (async () => {
    for await (const chunk of eventResponse.body)
      events += Buffer.from(chunk).toString()
  })().catch((error) => {
    if (!eventsAbort.signal.aborted) throw error
  })
  await api(`/session/${session.data.id}/command`, {
    name: "handoff",
    text: ""
  })
  const sessions = await api(
    `/session?directory=${encodeURIComponent(directory)}`
  )
  const target = sessions.data.find(
    (value) => value.title === "Handoff: Automatic Handoff fixture"
  )
  assert.ok(target)
  assert.notEqual(target.id, session.data.id)
  assert.equal(target.parentID, undefined)
  assert.deepEqual(target.model, session.data.model)
  assert.equal(target.agent, session.data.agent)
  await wait(
    () =>
      JSON.parse(fs.readFileSync(observationFile, "utf8")).handoff?.targetID ===
      target.id
  )
  await wait(() => events.includes('"status":"ready"'))
  assert.match(events, /"status":"preparing"/)
  assert.ok(events.includes(target.id))
  await api(`/session/${session.data.id}/command`, {
    name: "handoff",
    text: ""
  })
  const repeated = await api(
    `/session?directory=${encodeURIComponent(directory)}`
  )
  assert.equal(
    repeated.data.filter((value) => value.title === target.title).length,
    1
  )
  assert.equal(requests.slice(manualStart).filter(value => JSON.stringify(value).includes("Harness automatic Handoff.")).length, 1)
  eventsAbort.abort()
  await eventTask
  await wait(() =>
    requests
      .slice(manualStart)
      .some((value) =>
        JSON.stringify(value.input).includes(
          "continue the first unfinished step"
        )
      )
  )
  const continued = requests
    .slice(manualStart)
    .find((value) =>
      JSON.stringify(value.input).includes("continue the first unfinished step")
    )
  assert.match(
    JSON.stringify(continued.input),
    /continue the first unfinished step/
  )
  assert.match(JSON.stringify(continued.input), /Handoff fixture/)
  assert.doesNotMatch(
    JSON.stringify(continued.input),
    /Initial context fixture/
  )
  const continuedSystem = [
    continued.instructions ?? "",
    ...(continued.messages ?? [])
      .filter((value) => value.role === "system" || value.role === "developer")
      .map((value) => value.content)
  ].join("\n")
  assert.equal(continuedSystem.split("# Working rules").length - 1, 1)
  assert.equal(continuedSystem.split("# OpenCode harness").length - 1, 1)
  assert.doesNotMatch(continuedSystem, /Harness resume after compaction/)
  assert.doesNotMatch(continuedSystem, /Harness progress guard/)
  assert.ok(
    (JSON.stringify(continued.input).match(/Saved task context:/g) ?? [])
      .length <= 1
  )
  assert.match(
    fs.readFileSync(path.join(directory, ".opencode", "HANDOFF.md"), "utf8"),
    /Handoff fixture/
  )
  await api(`/experimental/session/${target.id}/wait`, {})
  const targetContext = await api(`/session/${target.id}/context`)
  assert.ok(
    targetContext.data.some(
      (value) => value.type === "assistant" && value.time.completed
    )
  )
  await api(`/session/${target.id}`, undefined, "DELETE")
  await api(`/session/${session.data.id}/command`, { name: "handoff", text: "" })
  const recreated = await api(`/session?directory=${encodeURIComponent(directory)}`)
  const replacement = recreated.data.find(value => value.title === target.title)
  assert.ok(replacement)
  assert.notEqual(replacement.id, target.id)
  assert.equal(requests.slice(manualStart).filter(value => JSON.stringify(value).includes("Harness automatic Handoff.")).length, 2)
  await api(`/experimental/session/${replacement.id}/wait`, {})
  const projectionSession = await api("/session", { agent: "build", location: { directory }, model: { providerID: "fixture", id: "model" } })
  const projectionStart = requests.length
  await api(`/session/${projectionSession.data.id}/prompt`, { text: "CACHE_PROJECTION_FIXTURE: reply OK." })
  await api(`/experimental/session/${projectionSession.data.id}/wait`, {})
  const projection = requests.slice(projectionStart).find(value => value.tools?.length && JSON.stringify(value).includes("CACHE_PROJECTION_FIXTURE"))
  assert.ok(projection)
  assert.equal(JSON.stringify(projection).split("CACHE_EVIDENCE_BODY").length - 1, 60)
  assert.match(JSON.stringify(projection), /identical read result retained in tool call read-first/)
  assert.doesNotMatch(JSON.stringify(projection), /STALE_INSTRUCTION_FIXTURE|STALE_ROUTING_FIXTURE/)
  assert.equal(JSON.stringify(projection).split("# Working rules").length - 1, 1)
  const deepseekSession = await api("/session", {
    agent: "build",
    title: "DeepSeek routing fixture",
    location: { directory },
    model: { providerID: "deepseek", id: "deepseek-flash" }
  })
  const deepseekID = deepseekSession.data.id
  await api(`/session/${deepseekID}/prompt`, {
    text: "PRIVATE_PARENT_HISTORY: implement the accepted plan."
  })
  await api(`/experimental/session/${deepseekID}/wait`, {})
  const flashRequest = requests.find(
    (value) =>
      value.model === "deepseek-flash" &&
      JSON.stringify(value.input).includes("PRIVATE_PARENT_HISTORY")
  )
  assert.ok(flashRequest)
  assert.doesNotMatch(JSON.stringify(flashRequest), /DeepSeek model routing|use one fresh harness-review|transfers this completed turn to Pro/)
  assert.equal(requests.some(value => value.model === "deepseek-v4-pro"), false)
  const handoffStart = requests.length
  await api(`/session/${deepseekID}/command`, { name: "handoff", text: "" })
  const flashHandoff = requests
    .slice(handoffStart)
    .find((value) =>
      JSON.stringify(value).includes("Harness automatic Handoff.")
    )
  assert.equal(flashHandoff?.model, "deepseek-flash")
  await wait(() =>
    requests
      .slice(handoffStart)
      .some(
        (value) =>
          value.model === "deepseek-flash" &&
          JSON.stringify(value.input).includes(
            "continue the first unfinished step"
          )
      )
  )
  const sourceAfter = await api(`/session/${deepseekID}`)
  assert.equal(sourceAfter.data.model.id, "deepseek-flash")
  const stalledSession = await api("/session", {
    agent: "build",
    title: "Stalled investigation",
    location: { directory },
    model: { providerID: "deepseek", id: "deepseek-flash" }
  })
  const stalledID = stalledSession.data.id
  stallNextFlash = true
  const escalationStart = requests.length
  await api(`/session/${stalledID}/prompt`, {
    text: "Investigate the unresolved fixture."
  })
  await api(`/experimental/session/${stalledID}/wait`, {})
  const stalledFile = path.join(observationDirectory(directory, path.join(directory, "state")), "sessions", `${stalledID}.json`)
  await wait(() => fs.existsSync(stalledFile))
  const list = await api(`/session?directory=${encodeURIComponent(directory)}`)
  assert.equal(list.data.some(value => value.title === "Handoff: Stalled investigation"), false)
  assert.equal(requests.slice(escalationStart).some(value => value.model === "deepseek-v4-pro"), false)
  assert.equal((await api(`/session/${stalledID}`)).data.model.id, "deepseek-flash")
  const nativeTools = JSON.parse(fs.readFileSync(path.join(directory, "native-tools.json"), "utf8"))
  assert.ok(nativeTools.some(tool => tool.name === "question"))
  assert.ok(nativeTools.some(tool => tool.name === "brief_transition"))
  assert.ok(nativeTools.some(tool => tool.name === "task_context"))
  for (const name of ["read", "grep", "glob", "shell"]) {
    assert.match(nativeTools.find(tool => tool.name === name)?.description ?? "", /^For indexed project files, search\/read through TokenSave/)
    assert.match(nativeTools.find(tool => tool.name === name)?.description ?? "", /Without an index, do not load tokensave-routing or call MCP/)
  }
  assert.match(nativeTools.find(tool => tool.name === "skill")?.description ?? "", /Load only a skill whose described scope this task actually touches/)
  assert.match(nativeTools.find(tool => tool.name === "skill")?.description ?? "", /Load tokensave-routing only when the project root has an index/)
  assert.match(nativeTools.find(tool => tool.name === "skill")?.description ?? "", /returned Base directory/)
  assert.match(nativeTools.find(tool => tool.name === "subagent")?.description ?? "", /^Use only when the user explicitly requests delegation/)
  const briefStart = requests.length
  const briefSource = await api("/session", {
    agent: "build",
    location: { directory },
    model: { providerID: "deepseek", id: "deepseek-flash" },
    permissions: [{ action: "edit", resource: "private/**", effect: "deny" }]
  })
  await api(`/session/${briefSource.data.id}/prompt`, { text: "BRIEF_NATIVE_START" })
  const continuations = async () => (await api(`/session?directory=${encodeURIComponent(directory)}`)).data
  const existingSessions = new Set((await continuations()).map(value => value.id))
  let planner
  const briefDeadline = Date.now() + 15000
  while (!planner && Date.now() < briefDeadline) {
    planner = (await continuations()).find(value => !existingSessions.has(value.id) && value.model?.id === "deepseek-flash")
    if (!planner) await setTimeout(25)
  }
  assert.ok(planner, "Native execution must deliver the queued brief to a fresh session")
  assert.deepEqual(planner.model, briefSource.data.model)
  await wait(() => requests.slice(briefStart).some(value => value.model === "deepseek-flash" && JSON.stringify(value).includes("Planning phase")))
  const plannerRequest = requests.slice(briefStart).find(value => value.model === "deepseek-flash" && JSON.stringify(value).includes("Planning phase"))
  assert.equal(
    (JSON.stringify(plannerRequest).match(/Planning phase\./g) ?? []).length,
    1,
    "The restored planning session must carry the planning instructions once"
  )
  await api(`/experimental/session/${planner.id}/wait`, {})
  assert.ok(requests.slice(briefStart).some(value => value.model === "deepseek-flash" && JSON.stringify(value).includes("NATIVE_TASK_CHECKPOINT")))
  assert.notEqual(planner.id, briefSource.data.id)
  assert.deepEqual(planner.permissions, (await api(`/session/${briefSource.data.id}`)).data.permissions)
  assert.equal((await continuations()).filter(value => !existingSessions.has(value.id)).length, 1)
  await api(`/session/${planner.id}/prompt`, { text: "BRIEF_NATIVE_ANSWERS: neutral nodata; implementation authorized" })
  let implementation
  const implementationDeadline = Date.now() + 15000
  while (!implementation && Date.now() < implementationDeadline) {
    implementation = (await continuations()).find(value => value.id !== briefSource.data.id && value.title === `Handoff: ${planner.title}`)
    if (!implementation) await setTimeout(25)
  }
  assert.ok(implementation, "Answers must be carried into a fresh implementation session")
  await wait(() => requests.slice(briefStart).some(value => value.model === "deepseek-flash" && JSON.stringify(value).includes("Restore the Handoff and executable plan")))
  await api(`/experimental/session/${implementation.id}/wait`, {})
  assert.equal(implementation.model.id, "deepseek-flash")
  assert.deepEqual(implementation.permissions, planner.permissions)
  const implementationRequest = requests.slice(briefStart).find(value => value.model === "deepseek-flash" && JSON.stringify(value).includes("Restore the Handoff and executable plan"))
  assert.ok(implementationRequest)
  assert.match(JSON.stringify(implementationRequest), /Answers: neutral nodata/)
  assert.match(JSON.stringify(implementationRequest), /\.opencode\/plans\/native.md/)
  assert.doesNotMatch(JSON.stringify(implementationRequest), /BRIEF_NATIVE_START|BRIEF_NATIVE_ANSWERS/)
  const completionStart = requests.length
  await api(`/session/${implementation.id}/prompt`, { text: "TASK_NATIVE_COMPLETE" })
  await api(`/experimental/session/${implementation.id}/wait`, {})
  assert.ok(requests.slice(completionStart).some(value => JSON.stringify(value).includes("Task cache cleared. Other tasks and plan files were preserved.")))
})

test("OpenCode discovers ask with shell access and native edit, subagent and MCP mutation restrictions", (t) => {
  const directory = sandbox(t)
  const config = path.join(directory, "config")
  fs.mkdirSync(path.join(config, "agents"), { recursive: true })
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../../opencode/agent/ask.md"),
    path.join(config, "agents/ask.md")
  )
  const result = spawnSync("opencode", ["debug", "agents", "--standalone"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: config,
      XDG_CONFIG_HOME: path.join(directory, "xdg"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state")
    }
  })
  assert.equal(result.status, 0, result.stderr)
  const agent = JSON.parse(result.stdout).find((value) => value.id === "ask")
  assert.equal(agent.mode, "primary")
  assert.match(agent.system, /Everything goes to chat/)
  const effect = (action, resource = "*") =>
    agent.permissions.findLast(
      (rule) =>
        path.matchesGlob(action, rule.action) &&
        path.matchesGlob(resource, rule.resource)
    )?.effect
  for (const action of [
    "edit",
    "subagent",
    "tokensave_tokensave_str_replace",
    "tokensave_tokensave_multi_str_replace"
  ]) {
    assert.equal(effect(action), "deny", action)
  }
  assert.equal(effect("shell", "git status*"), "allow")
  for (const command of [
    "*",
    'echo "---BRANCH---"',
    "npm test",
    "node --version",
    'git status --short && echo "---BRANCH---" && git branch --show-current && echo "---LOG---" && git log --oneline -5'
  ]) {
    assert.equal(effect("shell", command), "allow", command)
  }
  for (const action of [
    "playwright_browser_tabs",
    "playwright_browser_snapshot",
    "playwright_browser_navigate",
    "tokensave_tokensave_search",
    "ragsave_rag_search"
  ]) {
    assert.equal(effect(action), "allow", action)
  }
})

test("OpenCode merges JSON and JSONC, preserves nested comments and rejects malformed input", (t) => {
  const directory = sandbox(t)
  const alternative = path.join(directory, "opencode.json")
  const settings = path.join(directory, "opencode.jsonc")
  const original = JSON.stringify({
    model: "json/model",
    mcp: { servers: { custom: { command: ["custom"] } } }
  })
  fs.writeFileSync(alternative, original)
  fs.writeFileSync(
    settings,
    '{\n // user setting\n "model": "jsonc/model",\n "mcp": { /* nested */ "servers": {} },\n}\n'
  )

  const { current } = loadConfig(directory)
  assert.equal(current.model, "jsonc/model")
  current.mcp.servers.extra = { command: ["extra"] }
  writeConfig(settings, current)

  assert.deepEqual(readConfig(settings), current)
  assert.match(fs.readFileSync(settings, "utf8"), /\/\/ user setting/)
  assert.match(fs.readFileSync(settings, "utf8"), /\/\* nested \*\//)
  assert.equal(fs.readFileSync(alternative, "utf8"), original)
  assert.equal(
    fs.readdirSync(directory).filter((name) => name.includes(".bak-")).length,
    1
  )
  writeConfig(settings, current)
  assert.equal(
    fs.readdirSync(directory).filter((name) => name.includes(".bak-")).length,
    1
  )
  fs.writeFileSync(settings, '{"model": }')
  assert.throws(() => loadConfig(directory), /ValueExpected/)
  assert.equal(fs.readFileSync(settings, "utf8"), '{"model": }')
})

test("OpenCode MCP sync supports both configs and comments without writing in check mode", (t) => {
  const directory = sandbox(t)
  const alternative = path.join(directory, "opencode.json")
  const settings = path.join(directory, "opencode.jsonc")
  fs.writeFileSync(
    alternative,
    '{"model":"user/model","mcp":{"servers":{"custom":{"command":["custom"]}}}}'
  )
  fs.writeFileSync(
    settings,
    '{ // keep\n "mcp": { /* keep nested */ "servers": { "playwright": { "type": "local", "command": ["old"], "environment": { "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "secret-token" } } } },\n}'
  )
  const before = fs.readFileSync(settings, "utf8")
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"),
        "--opencode",
        ...args
      ],
      {
        env: { ...process.env, OPENCODE_CONFIG_DIR: directory, PLAYWRIGHT_MCP_EXTENSION_TOKEN: "test-token" },
        encoding: "utf8"
      }
    )
  assert.equal(run("--check").status, 1)
  assert.equal(fs.readFileSync(settings, "utf8"), before)
  assert.equal(fs.readdirSync(directory).length, 2)
  const result = run()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(loadConfig(directory).current.model, "user/model")
  assert.deepEqual(loadConfig(directory).current.mcp.servers.custom.command, [
    "custom"
  ])
  assert.match(fs.readFileSync(settings, "utf8"), /keep nested/)
  const synced = loadConfig(directory).current.mcp.servers
  assert.equal(synced.playwright.environment.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "{env:PLAYWRIGHT_MCP_EXTENSION_TOKEN}")
  assert.ok(!synced.playwright.command.includes("--manual-extension"))
  assert.ok(synced.playwright.command.includes("--existing-tabs-only"))
  assert.ok(
    Object.values(synced.playwright.environment).every(value =>
      /^\{env:[A-Z0-9_]+\}$/.test(value)
    )
  )
  assert.ok(!fs.readFileSync(settings, "utf8").includes("secret-token"))
  assert.equal(run("--check").status, 0)
})

test("OpenCode MCP sync references the Playwright extension token in a clean config", (t) => {
  const directory = sandbox(t)
  const settings = path.join(directory, "opencode.jsonc")
  fs.writeFileSync(settings, '{"model":"user/model"}')
  const run = (token) =>
    spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"), "--opencode"],
      {
        env: {
          ...process.env,
          OPENCODE_CONFIG_DIR: directory,
          PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/opt/chrome",
          PLAYWRIGHT_MCP_EXTENSION_TOKEN: token
        },
        encoding: "utf8"
      }
    )
  const missing = run("")
  assert.equal(missing.status, 0, missing.stderr + missing.stdout)
  assert.equal(
    loadConfig(directory).current.mcp.servers.playwright.environment
      .PLAYWRIGHT_MCP_EXTENSION_TOKEN,
    undefined
  )
  const present = run("test-token")
  assert.equal(present.status, 0, present.stderr + present.stdout)
  assert.equal(
    loadConfig(directory).current.mcp.servers.playwright.environment
      .PLAYWRIGHT_MCP_EXTENSION_TOKEN,
    "{env:PLAYWRIGHT_MCP_EXTENSION_TOKEN}"
  )
  assert.ok(!fs.readFileSync(settings, "utf8").includes("test-token"))
})

for (const extension of ["json", "jsonc"]) {
  test(`OpenCode MCP sync removes remote URLs from ${extension} when installing a local server`, (t) => {
    const directory = sandbox(t)
    const settings = path.join(directory, `opencode.${extension}`)
    fs.writeFileSync(
      settings,
      JSON.stringify({
        model: "user/model",
        mcp: {
          servers: {
            tokensave: {
              type: "remote",
              url: "https://example.test/mcp",
              timeout: 12345
            }
          }
        }
      })
    )
    const overlay = path.join(directory, "opencode.jsonc")
    if (extension === "json")
      fs.writeFileSync(overlay, '{"instructions":["custom.md"]}')
    const snapshot = () =>
      Object.fromEntries(
        fs
          .readdirSync(directory)
          .sort()
          .map((name) => [
            name,
            fs.readFileSync(path.join(directory, name), "utf8")
          ])
      )
    const before = snapshot()
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"),
          "--opencode",
          ...args
        ],
        {
          env: { ...process.env, OPENCODE_CONFIG_DIR: directory },
          encoding: "utf8"
        }
      )

    assert.equal(run("--check").status, 1)
    assert.deepEqual(snapshot(), before)
    const installed = run()

    assert.equal(installed.status, 0, installed.stderr + installed.stdout)
    const current = loadConfig(directory).current
    assert.equal(current.model, "user/model")
    assert.equal(current.mcp.servers.tokensave.type, "local")
    assert.equal(Object.hasOwn(current.mcp.servers.tokensave, "url"), false)
    assert.equal(current.mcp.servers.tokensave.timeout, 12345)
    assert.equal(
      Object.hasOwn(readConfig(settings).mcp.servers.tokensave, "url"),
      false
    )
    const backup = fs
      .readdirSync(directory)
      .find((name) => name.startsWith(`opencode.${extension}.bak-`))
    assert.ok(backup)
    assert.equal(
      fs.readFileSync(path.join(directory, backup), "utf8"),
      before[`opencode.${extension}`]
    )
    if (extension === "json") {
      assert.deepEqual(current.instructions, ["custom.md"])
      const original = JSON.parse(before["opencode.json"])
      delete original.mcp.servers.tokensave.url
      assert.deepEqual(readConfig(settings), original)
    }
    const after = snapshot()
    const checked = run("--check")
    assert.equal(checked.status, 0, checked.stderr + checked.stdout)
    assert.deepEqual(snapshot(), after)
  })
}

function executionSandbox(t) {
  const directory = sandbox(t)
  const harnessRoot = path.join(directory, "harness clone #1")
  fs.mkdirSync(path.join(harnessRoot, "opencode"), { recursive: true })
  for (const file of [
    "harness.js",
    "brief.mjs",
    "task-context.mjs",
    "loop-guard.mjs",
    "output-bounds.mjs",
    "handoff.mjs",
    "handoff-rpc.mjs",
    "model-routing.mjs",
    "observations.mjs",
    "cost-policy.mjs",
    "cost-report.mjs",
    "local-state.mjs",
    "instructions.mjs",
    "cache-policy.mjs",
    "context-cache.mjs",
    "retrieval-routing.mjs",
    "read-results.mjs",
    "AGENTS.md",
    "package.json"
  ]) {
    fs.copyFileSync(
      path.resolve(import.meta.dirname, "../../opencode", file),
      path.join(harnessRoot, "opencode", file)
    )
  }
  for (const folder of ["ai-hooks", "rules"]) {
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../..", folder),
      path.join(harnessRoot, folder)
    )
  }
  const project = path.join(directory, "other project $(literal)")
  fs.mkdirSync(project)
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0)
  for (const [folder, file] of [
    [".tokensave", "tokensave.db"],
    [".ragsave", "rag.db"]
  ]) {
    fs.mkdirSync(path.join(project, folder))
    fs.writeFileSync(path.join(project, folder, file), "")
  }
  const calls = path.join(directory, "calls")
  return {
    directory,
    harnessRoot,
    project,
    calls,
    env: {
      FAKE_INDEXER_CALLS: calls,
      AI_HOOKS_TOKENSAVE_CMD: path.resolve(
        import.meta.dirname,
        "fixtures/fake-indexer.mjs"
      ),
      AI_HOOKS_RAGSAVE_CMD: path.resolve(
        import.meta.dirname,
        "fixtures/fake-indexer.mjs"
      )
    }
  }
}

for (const type of [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
]) {
  test(`OpenCode ${type} syncs indexes in the session project`, async (t) => {
    const { directory, harnessRoot, project, calls, env } = executionSandbox(t)
    const runner = `
      import fs from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import plugin from ${JSON.stringify(pathToFileURL(path.join(harnessRoot, "opencode/harness.js")).href)};
      const calls = () => fs.existsSync(process.env.FAKE_INDEXER_CALLS) ? fs.readFileSync(process.env.FAKE_INDEXER_CALLS, 'utf8').trim().split('\\n') : [];
      const wait = async (count) => {
        const deadline = Date.now() + 5000;
        while (calls().length < count && Date.now() < deadline) await setTimeout(25);
        if (calls().length < count) throw new Error('Sync did not complete');
      };
      await plugin.setup({
        location: { directory: process.env.TEST_PROJECT },
        app: { version: "2.2.5" },
        command: { transform: async () => {} },
        tool: { transform: async () => {}, hook: async () => {} },
        rpc: { register: async () => ({}) },
        storage: { scan: async () => ({ entries: [] }), get: async () => undefined },
        model: { transform: async callback => callback({ list: () => [] }) },
        event: { subscribe: async () => (async function* () { await wait(3); yield { type: process.env.TEST_EVENT, data: { sessionID: "ses_fixture" } }; })() },
        session: { hook: async () => {}, get: async () => ({ location: { directory: "/different-project" } }) }
      });
      await wait(5);
      await setTimeout(100);
    `
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", runner],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          ...env,
          TEST_PROJECT: project,
          TEST_EVENT: type
        }
      }
    )
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const commands = fs
      .readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.equal(commands.filter((args) => args[0] === "warm").length, 1)
    assert.equal(
      commands.filter((args) => args[0] === "sync" && args[1] === project)
        .length,
      4
    )
    assert.ok(fs.existsSync(path.join(project, ".tokensave/sync.log")))
    assert.ok(fs.existsSync(path.join(project, ".ragsave/sync.log")))
    await setTimeout(25)
  })
}

test("OpenCode repeats the handoff hint after compaction and every 40 messages", async (t) => {
  const { directory, harnessRoot, project, env } = executionSandbox(t)
  const runner = `
    import assert from 'node:assert/strict';
    import plugin from ${JSON.stringify(pathToFileURL(path.join(harnessRoot, "opencode/harness.js")).href)};
    const handlers = { context: [], compaction: [] };
    const session = {
      hook: async (name, handler) => { (handlers[name] ??= []).push(handler); },
      get: async () => ({ location: { directory: process.env.TEST_PROJECT } }),
      context: async () => []
    };
    await plugin.setup({
      location: { directory: process.env.TEST_PROJECT },
      app: { version: "2.2.5" },
      command: { transform: async () => {} },
      tool: { transform: async () => {}, hook: async () => {}, list: async () => [] },
      rpc: { register: async () => ({}) },
      storage: {
        scan: async () => ({ entries: [] }),
        get: async () => undefined,
        set: async () => {},
        remove: async () => {}
      },
      model: { transform: async callback => callback({ list: () => [] }) },
      event: { subscribe: async () => (async function* () {})() },
      session
    });
    const sessionID = "ses_hint";
    const hint = event => event.system.filter(part => part.text?.startsWith("Harness session is long.")).length;
    const run = async (assistants) => {
      const event = {
        sessionID,
        messages: Array.from({ length: assistants }, () => ({ role: "assistant", content: [] })),
        system: []
      };
      for (const handler of handlers.context) await handler(event);
      return hint(event);
    };
    assert.equal(await run(80), 0);
    const compaction = { sessionID, messages: [], system: [] };
    for (const handler of handlers.compaction) await handler(compaction);
    assert.equal(await run(5), 1);
    assert.equal(await run(44), 0);
    assert.equal(await run(45), 1);
    assert.equal(await run(46), 0);
  `
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", runner],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...env, TEST_PROJECT: project }
    }
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
})

test("OpenCode handles one execution event once across plugin instances", async (t) => {
  const { directory, harnessRoot, project, env } = executionSandbox(t)
  const runner = `
    import fs from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    import plugin from ${JSON.stringify(pathToFileURL(path.join(harnessRoot, "opencode/harness.js")).href)};
    const calls = () => fs.existsSync(process.env.FAKE_INDEXER_CALLS) ? fs.readFileSync(process.env.FAKE_INDEXER_CALLS, 'utf8').trim().split('\\n').filter(Boolean) : [];
    let release;
    const gate = new Promise(resolve => { release = resolve });
    const context = () => ({
      location: { directory: process.env.TEST_PROJECT },
      app: { version: "2.2.5" },
      command: { transform: async () => {} },
      tool: { transform: async () => {}, hook: async () => {} },
      rpc: { register: async () => ({}) },
      storage: { scan: async () => ({ entries: [] }), get: async () => undefined },
      model: { transform: async callback => callback({ list: () => [] }) },
      event: { subscribe: async () => (async function* () { await gate; yield { id: "evt_shared", type: process.env.TEST_EVENT, data: { sessionID: "ses_fixture" } }; })() },
      session: { hook: async () => {}, get: async () => ({ location: { directory: process.env.TEST_PROJECT } }) }
    });
    const stopFirst = await plugin.setup(context());
    const stopSecond = await plugin.setup(context());
    const settle = async (min = 0) => {
      let last = -1;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (calls().length < min || last !== calls().length)) {
        last = calls().length;
        await setTimeout(150);
      }
      return calls().length;
    };
    const startup = await settle();
    fs.writeFileSync(process.env.FAKE_INDEXER_CALLS, "");
    release();
    await settle(2);
    await setTimeout(300);
    process.stdout.write(JSON.stringify({ startup, total: calls().length }));
    await stopFirst();
    await stopSecond();
  `
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", runner],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        ...env,
        TEST_PROJECT: project,
        TEST_EVENT: "session.execution.succeeded"
      }
    }
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const { startup, total } = JSON.parse(result.stdout)
  assert.ok(startup >= 4, `both instances synced their project first, saw ${startup}`)
  assert.equal(total, 2)
})

