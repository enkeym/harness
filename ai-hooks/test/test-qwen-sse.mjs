import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeChatStream } from "../../opencode/qwen-oauth/sse.mjs"

const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const delta = choices => ({ choices })

const streamText = async (parts, log = () => {}) => {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
  return new Response(sanitizeChatStream(body, log)).text()
}

const stream = async (parts, log = () => {}) => {
  const text = await streamText(parts, log)
  return text
    .split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)))
}

test("streamed tool calls keep a stable id and name", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "read", arguments: "" } }] } }])),
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }])),
    sse(delta([{ delta: {}, finish_reason: "tool_calls" }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_x")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "call_x")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, "read")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"path":"a"}')
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls")
})

test("a tool call without an id gets a synthetic one", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { name: "grep", arguments: '{"pattern":"x"}' } }] } }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_qwen_0")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].type, "function")
})

test("arguments arriving before the header are held back and repaired", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command"' } }] } }])),
    sse(delta([{ delta: { tool_calls: [{ index: 0, id: "call_y", type: "function", function: { name: "bash", arguments: ':1}' } }] } }])),
    sse(delta([{ delta: {}, finish_reason: "tool_calls" }]))
  ])

  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_y")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "bash")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"command"')
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, ':1}')
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls")
})

test("a tool call that never names its function is dropped and logged", async () => {
  const logged = []
  const chunks = await stream(
    [
      sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }])),
      sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b"}' } }] } }])),
      "data: [DONE]\n\n"
    ],
    () => logged.push("dropped")
  )

  assert.equal(chunks.length, 0)
  assert.ok(logged.length >= 1)
})

test("text deltas pass through untouched and survive chunk boundaries", async () => {
  const payload = sse(delta([{ delta: { content: "hello" } }])) + sse(delta([{ delta: { content: " world" } }]))
  const chunks = await stream([payload.slice(0, 9), payload.slice(9, 31), payload.slice(31)])

  assert.deepEqual(chunks.map(chunk => chunk.choices[0].delta.content), ["hello", " world"])
})

test("a dropped tool call does not swallow finish_reason or usage", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }])),
    sse(delta([{ delta: {}, finish_reason: "stop" }])),
    sse({ choices: [], usage: { total_tokens: 7 } }),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].choices[0].finish_reason, "stop")
  assert.equal(chunks[1].usage.total_tokens, 7)
})

test("the [DONE] sentinel is forwarded", async () => {
  const text = await streamText([sse(delta([{ delta: { content: "x" } }])), "data: [DONE]\n\n"])

  assert.ok(text.endsWith("data: [DONE]\n\n"))
})

test("non-data lines are forwarded and keep their place", async () => {
  const text = await streamText([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }])),
    ": ping\n\n",
    sse(delta([{ delta: {}, finish_reason: "stop" }]))
  ])

  assert.ok(text.startsWith(": ping\n"))
  assert.ok(text.indexOf(": ping") < text.indexOf("finish_reason"))
  assert.ok(!text.includes('"arguments":"{}"'))
})

test("a malformed payload is logged and skipped", async () => {
  const logged = []
  const chunks = await stream(
    ["data: {not json\n\n", sse(delta([{ delta: { content: "ok" } }]))],
    message => logged.push(message)
  )

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, "ok")
  assert.match(logged[0], /malformed stream payload/)
})

test("tool calls in one chunk get distinct ids", async () => {
  const chunks = await stream([
    sse(delta([{
      delta: {
        tool_calls: [
          { index: 0, function: { name: "read", arguments: "" } },
          { index: 1, function: { name: "grep", arguments: "" } }
        ]
      }
    }])),
    "data: [DONE]\n\n"
  ])

  assert.deepEqual(
    chunks[0].choices[0].delta.tool_calls.map(call => call.id),
    ["call_qwen_0", "call_qwen_1"]
  )
})

test("reasoning deltas pass through untouched", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { reasoning_content: "think" } }])),
    sse(delta([{ delta: { content: "answer" } }])),
    sse(delta([{ delta: {}, finish_reason: "stop" }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks[0].choices[0].delta.reasoning_content, "think")
  assert.equal(chunks[1].choices[0].delta.content, "answer")
})

test("final usage with cached token details passes through untouched", async () => {
  const usage = {
    prompt_tokens: 1200,
    completion_tokens: 30,
    total_tokens: 1230,
    prompt_tokens_details: { cached_tokens: 1100, text_tokens: 1200 },
    completion_tokens_details: { reasoning_tokens: 12 }
  }
  const chunks = await stream([
    sse(delta([{ delta: { content: "x" } }])),
    sse({ choices: [], usage }),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[1].usage, usage)
})

test("a length finish reason is preserved", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { content: "partial" } }])),
    sse(delta([{ delta: {}, finish_reason: "length" }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks[1].choices[0].finish_reason, "length")
})
