import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDsmlCalls, sanitizeDsmlStream } from "../../opencode/dsml.mjs"

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const chunk = (delta, finish_reason = null) =>
  sse({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason }]
  })

const streamText = async (parts, log = () => {}) => {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
  return new Response(sanitizeDsmlStream(body, log)).text()
}

const stream = async (parts, log = () => {}) =>
  (await streamText(parts, log))
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))

const deltasOf = (chunks) =>
  chunks.map((entry) => entry.choices?.[0]?.delta).filter(Boolean)

const textOf = (chunks) =>
  deltasOf(chunks)
    .filter((delta) => typeof delta.content === "string")
    .map((delta) => delta.content)
    .join("")

const finishOf = (chunks) =>
  chunks
    .map((entry) => entry.choices?.[0]?.finish_reason)
    .filter(Boolean)
    .at(-1)

const callsOf = (chunks) => deltasOf(chunks).find((delta) => delta.tool_calls)?.tool_calls

const dsmlBlock = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="execute">
<｜｜DSML｜｜ parameter name="code" string="true">return await tools.playwright.browser_evaluate({ expression: "1 + 1" });</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

test("a leaked DSML block becomes a structured tool call", async () => {
  const chunks = await stream([
    chunk({ role: "assistant" }),
    chunk({ content: "Пробую открыть новое сообщение через API Intercom.\n\n" }),
    chunk({ content: dsmlBlock }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  ])

  assert.equal(textOf(chunks), "Пробую открыть новое сообщение через API Intercom.\n\n")
  assert.ok(!JSON.stringify(chunks).includes("DSML"))

  const call = callsOf(chunks)?.[0]
  assert.ok(call, "tool call delta is emitted")
  assert.equal(call.function.name, "execute")
  assert.deepEqual(JSON.parse(call.function.arguments), {
    code: 'return await tools.playwright.browser_evaluate({ expression: "1 + 1" });'
  })
  assert.equal(finishOf(chunks), "tool_calls")
})

test("a DSML block split across stream deltas still converts", async () => {
  const chunks = await stream([
    chunk({ content: dsmlBlock.slice(0, 40) }),
    chunk({ content: dsmlBlock.slice(40, 120) }),
    chunk({ content: dsmlBlock.slice(120) }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  ])

  assert.equal(callsOf(chunks)?.[0]?.function?.name, "execute")
  assert.equal(finishOf(chunks), "tool_calls")
})

test("a marker cut in the middle of a tag keeps the stream intact", async () => {
  const chunks = await stream([
    chunk({ content: "ответ " }),
    chunk({ content: "<｜｜DSM" }),
    chunk({ content: "L｜｜ calls>\n" }),
    chunk({
      content: `<｜｜DSML｜｜ invoke name="shell">\n<｜｜DSML｜｜ parameter name="command">ls -1</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`
    }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  ])

  assert.equal(textOf(chunks), "ответ ")

  const call = callsOf(chunks)?.[0]
  assert.equal(call.function.name, "shell")
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "ls -1" })
})

test("the fullwidth variant of the marker converts too", async () => {
  const chunks = await stream([
    chunk({
      content: `<特|DSML|特 calls><特|DSML|特 invoke name="read"><特|DSML|特 parameter name="path">/tmp/opencode/a.txt</特|DSML|特 parameter></特|DSML|特 invoke></特|DSML|特 calls>`
    }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  ])

  const call = callsOf(chunks)?.[0]
  assert.equal(call.function.name, "read")
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "/tmp/opencode/a.txt" })
})

test("several invokes become several tool calls", async () => {
  const chunks = await stream([
    chunk({
      content: `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="grep"><｜｜DSML｜｜ parameter name="pattern">a</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="glob"><｜｜DSML｜｜ parameter name="pattern">**/*.ts</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
    }),
    chunk({}, "stop"),
    "data: [DONE]\n\n"
  ])

  const calls = callsOf(chunks)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].function.name, "grep")
  assert.equal(calls[1].function.name, "glob")
  assert.equal(calls[0].id, "call_dsml_1_0")
  assert.equal(calls[1].id, "call_dsml_1_1")
  assert.equal(finishOf(chunks), "tool_calls")
})

test("ordinary streams pass through unchanged", async () => {
  const parts = [
    chunk({ role: "assistant" }),
    chunk({ content: "обычный текст без " }),
    chunk({ content: "вызовов <div> и > знаков" }),
    chunk({}, "stop"),
    sse({ usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    "data: [DONE]\n\n"
  ]
  const chunks = await stream(parts)
  assert.equal(textOf(chunks), "обычный текст без вызовов <div> и > знаков")
  assert.equal(finishOf(chunks), "stop")
  assert.ok(chunks.some((entry) => entry.usage))
})

test("native tool call streams are untouched", async () => {
  const chunks = await stream([
    chunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  ])
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_x")
  assert.equal(chunks[1].choices[0].finish_reason, "tool_calls")
})

test("responses api events pass through untouched", async () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] }
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Привет" },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"></｜｜DSML｜｜ calls>`
    },
    { type: "response.completed", response: { id: "resp_1", status: "completed" } }
  ]
  const source = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const text = await streamText(source)
  for (const event of events) assert.ok(text.includes(JSON.stringify(event)))
})

test("an unterminated DSML block is kept as text", async () => {
  const chunks = await stream([
    chunk({ content: `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="execute">` })
  ])
  assert.ok(textOf(chunks).includes("DSML"))
  assert.equal(callsOf(chunks), undefined)
})

test("parseDsmlCalls reads invoke attributes and string flags", () => {
  const calls = parseDsmlCalls(dsmlBlock)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "execute")
  assert.equal(typeof calls[0].arguments.code, "string")
})
