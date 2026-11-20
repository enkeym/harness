import assert from "node:assert/strict"
import { test } from "node:test"
import {
  parseDsmlCalls,
  sanitizeDsmlJsonStream,
  sanitizeDsmlStream,
  sanitizeMessageTexts,
  stripDsmlText
} from "../../opencode/dsml.mjs"

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

test("an unterminated DSML block with a complete invoke is converted on flush", async () => {
  const chunks = await stream([
    chunk({
      content: `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="execute">
<｜｜DSML｜｜ parameter name="code" string="true">return 1</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`
    })
  ])
  assert.ok(!textOf(chunks).includes("DSML"))
  const call = callsOf(chunks)?.[0]
  assert.ok(call, "the call is recovered from the truncated block")
  assert.equal(call.function.name, "execute")
  assert.equal(finishOf(chunks), "tool_calls")
})

test("an unterminated DSML block without a complete invoke is stripped from text", async () => {
  const chunks = await stream([
    chunk({ content: `Проверяю.\n\n<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="execute">` })
  ])
  const text = textOf(chunks)
  assert.equal(text, "Проверяю.\n\n")
  assert.equal(callsOf(chunks), undefined)
})

test("a non-streaming JSON response with leaked DSML becomes tool calls", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: dsmlBlock },
                finish_reason: "stop"
              }
            ]
          })
        )
      )
      controller.close()
    }
  })
  const payload = JSON.parse(
    await new Response(sanitizeDsmlJsonStream(body)).text()
  )
  const choice = payload.choices[0]
  assert.equal(choice.finish_reason, "tool_calls")
  assert.ok(!JSON.stringify(choice.message.content ?? "").includes("DSML"))
  assert.equal(choice.message.tool_calls[0].function.name, "execute")
  assert.equal(
    JSON.parse(choice.message.tool_calls[0].function.arguments).code,
    'return await tools.playwright.browser_evaluate({ expression: "1 + 1" });'
  )
})

test("history sanitization strips DSML text and reports repeated blocks", () => {
  const leaked = `Проверю.\n\n${dsmlBlock}`
  assert.equal(stripDsmlText(leaked), "Проверю.\n\n[unexecuted tool call: execute]")
  const messages = [
    { role: "assistant", content: [{ type: "text", text: leaked }] },
    { role: "assistant", content: [{ type: "text", text: leaked }] },
    { role: "user", content: [{ type: "text", text: "продолжи" }] }
  ]
  const { changed, repeated } = sanitizeMessageTexts(messages)
  assert.equal(changed, 2)
  assert.equal(repeated.length, 1)
  assert.ok(!JSON.stringify(messages).includes("DSML"))
})

test("the 13.11 fullwidth variant converts", async () => {
  const block = `<特|DSML|特 calls>
<特|DSML|特 invoke name="execute">
<特|DSML|特 parameter name="code" string="true">await tools.shell({ command: "ssh vpn uptime" });</特|DSML|特 parameter>
</特|DSML|特 invoke>
</特|DSML|特 calls>`
  assert.equal(parseDsmlCalls(block).length, 1)
  const chunks = await stream([chunk({ content: block }), chunk({}, "stop")])
  assert.ok(!textOf(chunks).includes("DSML"))
  assert.equal(callsOf(chunks)[0].function.name, "execute")
})

test("the 20.11 repeating cards.js payload converts", async () => {
  const leaked = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="execute">
<｜｜DSML｜｜ parameter name="code" string="true">const a = await tools.tokensave.tokensave_read({file:"lib/tunnelvpn/ui/js/cards.js", mode:"lines", lines:"510-560", format:"text"});
const b = await tools.tokensave.tokensave_read({file:"lib/tunnelvpn/ui/js/cards.js", mode:"lines", lines:"425-445", format:"text"});
return JSON.stringify({a:String(a).slice(0,3000), b:String(b).slice(0,1600)});</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
  for (const split of [leaked.length, 1, 7]) {
    const parts = []
    for (let index = 0; index < leaked.length; index += split)
      parts.push(chunk({ content: leaked.slice(index, index + split) }))
    const chunks = await stream([...parts, chunk({}, "stop")])
    const args = JSON.parse(callsOf(chunks)[0].function.arguments)
    assert.match(args.code, /cards\.js/)
    assert.ok(!textOf(chunks).includes("DSML"))
  }
})

test("parseDsmlCalls reads invoke attributes and string flags", () => {
  const calls = parseDsmlCalls(dsmlBlock)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "execute")
  assert.equal(typeof calls[0].arguments.code, "string")
})
