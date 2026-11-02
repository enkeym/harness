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
import { configureDeepSeek } from "../../opencode/model-routing.mjs"

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-opencode-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("MCP sync rejects removed, unknown and conflicting client flags without writing", (t) => {
  const directory = sandbox(t)
  for (const args of [["--qwen"], ["--unknown"], ["--codex", "--opencode"]]) {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../bin/mcp-sync.mjs"), ...args], {
      env: { ...process.env, HOME: directory, OPENCODE_CONFIG_DIR: directory }, encoding: "utf8"
    })
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

test("OpenCode installer preserves both configs and repairs skills", (t) => {
  const home = sandbox(t)
  const directory = path.join(home, "opencode")
  fs.mkdirSync(path.join(directory, "skills"), { recursive: true })
  fs.mkdirSync(path.join(directory, "plugins"))
  fs.symlinkSync(path.resolve(import.meta.dirname, "../../opencode/harness.js"), path.join(directory, "plugins/harness.js"))
  fs.symlinkSync("/missing/skill", path.join(directory, "skills/task-brief"))
  const alternative = path.join(directory, "opencode.json")
  const settings = path.join(directory, "opencode.jsonc")
  fs.writeFileSync(alternative, '{"model":"user/model"}')
  fs.writeFileSync(
    settings,
    '{ // user config\n "instructions": ["custom.md"],\n}'
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
  const installed = run()
  assert.equal(installed.status, 0, installed.stderr + installed.stdout)
  assert.equal(loadConfig(directory).current.model, "user/model")
  assert.equal(loadConfig(directory).current.providers, undefined)
  assert.ok(loadConfig(directory).current.instructions.includes("custom.md"))
  assert.ok(fs.existsSync(path.join(directory, "skills/task-brief/SKILL.md")))
  assert.ok(fs.existsSync(path.join(directory, "skills/handoff/SKILL.md")))
  assert.equal(fs.existsSync(path.join(directory, "plugins/harness.js")), false)
  assert.equal(fs.realpathSync(path.join(directory, "plugins/harness")), path.resolve(import.meta.dirname, "../../opencode"))
  assert.equal(loadConfig(directory).current.commands.handoff, undefined)
  assert.equal(loadConfig(directory).current.compaction.auto, true)
  assert.equal(
    loadConfig(directory).current.compaction.buffer,
    contextPolicy.maxTokens - contextPolicy.startTokens
  )
  assert.equal(
    fs.realpathSync(path.join(directory, "agents/ask.md")),
    path.resolve(import.meta.dirname, "../../opencode/agent/ask.md")
  )
  assert.match(fs.readFileSync(settings, "utf8"), /user config/)
  const checked = run("--check")
  assert.equal(checked.status, 0, checked.stderr + checked.stdout)
  assert.equal(fs.readFileSync(alternative, "utf8"), '{"model":"user/model"}')
})

test("DeepSeek routing persists Flash execution and isolated Pro specialists without changing other providers", (t) => {
  const directory = sandbox(t)
  const settings = path.join(directory, "opencode.jsonc")
  const config = {
    model: "deepseek/deepseek-v4-pro",
    providers: { deepseek: { settings: { apiKey: "{file:/outside/key}" } } },
    agents: { plan: { model: "deepseek/deepseek-v4-pro#max" }, explore: { model: "custom/model" }, "harness-review": { request: { settings: { temperature: 0.3 } }, permissions: [{ action: "edit", resource: "*", effect: "allow" }] } },
    commands: { custom: { template: "Preserve me" } }
  }
  configureDeepSeek(config)
  writeConfig(settings, config)
  const loaded = loadConfig(directory).current
  assert.equal(loaded.model, "deepseek/deepseek-flash")
  assert.equal(loaded.agents.plan.model, "deepseek/deepseek-flash#max")
  assert.equal(loaded.agents.compaction.model, "deepseek/deepseek-flash")
  assert.equal(loaded.agents.explore.model, "custom/model")
  assert.equal(loaded.commands.custom.template, "Preserve me")
  assert.equal(loaded.agents["harness-review"].permissions.findLast(rule => rule.action === "edit").effect, "deny")
  const repeated = structuredClone(loaded)
  configureDeepSeek(repeated)
  assert.deepEqual(repeated, loaded)
  delete repeated.agents["harness-review"].request
  writeConfig(settings, repeated)
  assert.deepEqual(loadConfig(directory).current, repeated)
  const unrelated = { model: "custom/model", agents: { build: { model: "custom/model" } } }
  const original = structuredClone(unrelated)
  configureDeepSeek(unrelated)
  assert.deepEqual(unrelated, original)
})

test("OpenCode sends skill and search routing to custom and built-in agents", async (t) => {
  const directory = sandbox(t)
  const config = path.join(directory, "config")
  for (const name of ["agents", "plugins"]) {
    fs.mkdirSync(path.join(config, name), { recursive: true })
  }
  for (const [target, source] of [
    ["agents/ask.md", "opencode/agent/ask.md"],
    ["plugins/harness", "opencode"]
  ]) {
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../..", source),
      path.join(config, target)
    )
  }
  const requests = []
  let successful = false
  let primaryCalls = 0
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    requests.push({ ...input, fixtureURL: request.url })
    if (successful) {
      const primary =
        Boolean(input.tools?.length) &&
        !JSON.stringify(input).includes("Harness automatic Handoff.")
      if (primary) primaryCalls++
      const text = primary
        ? "Fixture step completed."
        : "## Objective\n- Handoff fixture: continue the authorized objective.\n\n## Requirements\n- Preserve permissions.\n\n## Decisions\n- Continue the remaining plan.\n\n## Work State\n### Completed\n- First step.\n### Active\n- Next step.\n### Blocked\n- (none)\n\n## Next Move\n1. Execute the next authorized step.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- Local compaction fixture."
      const usage = {
        input_tokens: primary && primaryCalls === 1 ? 120000 : 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: primary && primaryCalls === 1 ? 120020 : 1020
      }
      const part = { type: "output_text", text, annotations: [] }
      const item = {
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
          [
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
          ]
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
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const routing = { model: "deepseek/deepseek-flash" }
  configureDeepSeek(routing)
  fs.writeFileSync(
    path.join(config, "opencode.jsonc"),
    JSON.stringify({
      model: "fixture/model",
      agents: routing.agents,
      commands: routing.commands,
      compaction: {
        auto: true,
        buffer: contextPolicy.maxTokens - contextPolicy.startTokens,
        keep: { tokens: 0 }
      },
      providers: {
        deepseek: {
          package: "@ai-sdk/openai",
          settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-key" },
          models: Object.fromEntries(["deepseek-flash", "deepseek-v4-pro"].map(modelID => [modelID, { modelID, limit: { context: 1000000, output: 1000 } }]))
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
  const child = spawn(
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
  t.after(async () => {
    if (child.exitCode !== null) return
    const exit = new Promise((resolve) => child.once("exit", resolve))
    child.kill()
    await exit
  })
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
  const api = async (url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
    assert.ok(response.ok, `${url}: ${response.status}`)
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
    assert.match(system, /Read applicable SKILL.md/, agent)
    assert.match(system, /tokensave_search/, agent)
    assert.match(system, /rag_search/, agent)
    assert.match(system, /outside the index/, agent)
    const summaryStart = requests.length
    await api(`/session/${session.data.id}/compact`, {})
    await wait(() =>
      requests
        .slice(summaryStart)
        .some((value) =>
          JSON.stringify(value).includes("Harness automatic Handoff.")
        )
    )
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
      (value) => value.type === "assistant" && value.tokens?.input === 120000
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
  const summaryStart = requests.length
  await api(`/session/${session.data.id}/prompt`, {
    text: "Execute the next authorized step."
  })
  try { await wait(() => primaryCalls >= 2) }
  catch (error) { throw new Error(JSON.stringify({ primaryCalls, requests: requests.slice(summaryStart).map(value => ({ tools: value.tools?.length, handoff: JSON.stringify(value).includes("Harness automatic Handoff."), summary: JSON.stringify(value).includes("Handoff fixture"), inputTail: JSON.stringify(value.input).slice(-200) })), context: await api(`/session/${session.data.id}/context`) }), { cause: error }) }
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
  const eventResponse = await fetch(`http://127.0.0.1:${port}/api/event?types=rpc.harness.handoff.changed`, {
    headers: { authorization }, signal: eventsAbort.signal
  })
  assert.ok(eventResponse.ok)
  let events = ""
  const eventTask = (async () => {
    for await (const chunk of eventResponse.body) events += Buffer.from(chunk).toString()
  })().catch((error) => { if (!eventsAbort.signal.aborted) throw error })
  await api(`/session/${session.data.id}/command`, { name: "handoff", text: "" })
  const sessions = await api(`/session?directory=${encodeURIComponent(directory)}`)
  const target = sessions.data.find((value) => value.title === "Handoff: Automatic Handoff fixture")
  assert.ok(target)
  assert.notEqual(target.id, session.data.id)
  assert.equal(target.parentID, undefined)
  assert.deepEqual(target.model, session.data.model)
  assert.equal(target.agent, session.data.agent)
  await wait(() => events.includes('"status":"ready"'))
  assert.match(events, /"status":"preparing"/)
  assert.ok(events.includes(target.id))
  await api(`/session/${session.data.id}/command`, { name: "handoff", text: "" })
  const repeated = await api(`/session?directory=${encodeURIComponent(directory)}`)
  assert.equal(repeated.data.filter((value) => value.title === target.title).length, 1)
  eventsAbort.abort()
  await eventTask
  await wait(() => requests.slice(manualStart).some((value) => JSON.stringify(value.input).includes("Continue the next authorized step")))
  const continued = requests.slice(manualStart).find((value) => JSON.stringify(value.input).includes("Continue the next authorized step"))
  assert.match(JSON.stringify(continued.input), /Continue the next authorized step/)
  assert.match(JSON.stringify(continued.input), /Handoff fixture/)
  assert.doesNotMatch(JSON.stringify(continued.input), /Initial context fixture/)
  assert.match(fs.readFileSync(path.join(directory, "HANDOFF.md"), "utf8"), /Handoff fixture/)
  await api(`/experimental/session/${target.id}/wait`, {})
  const targetContext = await api(`/session/${target.id}/context`)
  assert.ok(targetContext.data.some((value) => value.type === "assistant" && value.time.completed))
  const deepseekSession = await api("/session", {
    agent: "build", title: "DeepSeek routing fixture", location: { directory },
    model: { providerID: "deepseek", id: "deepseek-flash" }
  })
  const deepseekID = deepseekSession.data.id
  await api(`/session/${deepseekID}/prompt`, { text: "PRIVATE_PARENT_HISTORY: implement the accepted plan." })
  await api(`/experimental/session/${deepseekID}/wait`, {})
  const flashRequest = requests.find(value => value.model === "deepseek-flash" && JSON.stringify(value.input).includes("PRIVATE_PARENT_HISTORY"))
  assert.ok(flashRequest)
  assert.match(JSON.stringify(flashRequest), /DeepSeek model routing/)
  for (const name of ["harness-brief", "harness-plan", "harness-review"]) {
    const start = requests.length
    await api(`/session/${deepseekID}/command`, { name, text: `Inspect ${name} scoped task.` })
    await api(`/experimental/session/${deepseekID}/wait`, {})
    const pro = requests.slice(start).find(value => value.model === "deepseek-v4-pro")
    assert.ok(pro, `${name}: ${JSON.stringify(requests.slice(start).map(value => ({ model: value.model, input: value.input })))}`)
    assert.match(JSON.stringify(pro.input), /scoped task/)
    assert.doesNotMatch(JSON.stringify(pro.input), /PRIVATE_PARENT_HISTORY/)
  }
  const handoffStart = requests.length
  await api(`/session/${deepseekID}/command`, { name: "handoff", text: "" })
  const flashHandoff = requests.slice(handoffStart).find(value => JSON.stringify(value).includes("Harness automatic Handoff."))
  assert.equal(flashHandoff?.model, "deepseek-flash")
  await wait(() => requests.slice(handoffStart).some(value => value.model === "deepseek-flash" && JSON.stringify(value.input).includes("Continue the next authorized step")))
  const sourceAfter = await api(`/session/${deepseekID}`)
  assert.equal(sourceAfter.data.model.id, "deepseek-flash")
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
    '{ // keep\n "mcp": { /* keep nested */ "servers": {} },\n}'
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
        env: { ...process.env, OPENCODE_CONFIG_DIR: directory },
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
  assert.equal(run("--check").status, 0)
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

for (const type of [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted"
]) {
  test(`OpenCode ${type} syncs indexes in the session project`, async (t) => {
    const directory = sandbox(t)
    const harnessRoot = path.join(directory, "harness clone #1")
    fs.mkdirSync(path.join(harnessRoot, "opencode"), { recursive: true })
    for (const file of ["harness.js", "handoff.mjs", "handoff-rpc.mjs", "model-routing.mjs", "AGENTS.md", "package.json"]) {
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
        command: { transform: async () => {} },
        rpc: { register: async () => ({}) },
        model: { transform: async callback => callback({ list: () => [] }) },
        event: { subscribe: async () => (async function* () { await wait(3); yield { type: process.env.TEST_EVENT }; })() },
        session: { hook: async () => {} }
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
          TEST_PROJECT: project,
          TEST_EVENT: type,
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
