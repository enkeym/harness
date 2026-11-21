import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchModels, refreshTokens, startDeviceAuth } from "../../opencode/qwen-oauth/oauth.mjs"

const withFetch = async (handler, run) => {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

test("startDeviceAuth rejects a response without a device code", async () => {
  await withFetch(
    async () => json({ user_code: "ABC" }),
    () => assert.rejects(startDeviceAuth(), /не удалось начать авторизацию/)
  )
})

test("refreshTokens rejects without a refresh token", async () => {
  await assert.rejects(refreshTokens(""), /нет refresh-токена/)
})

test("fetchModels keeps unique ids and known metadata", async () => {
  const result = await withFetch(
    async () =>
      json({
        data: [
          { id: "qwen3.8-max", input_modalities: ["text", "image"], context_window_tokens: 262144 },
          { id: "qwen3.8-max" },
          { id: 5 },
          { id: "qwen3.8-plus", input_modalities: ["text"] }
        ]
      }),
    () => fetchModels("token")
  )

  assert.deepEqual(result.models, ["qwen3.8-max", "qwen3.8-plus"])
  assert.deepEqual(result.metadata, [
    { id: "qwen3.8-max", modalities: { image: true }, contextWindowSize: 262144 },
    { id: "qwen3.8-plus", modalities: {} }
  ])
})

test("fetchModels keeps the server output limit and thinking support", async () => {
  const result = await withFetch(
    async () =>
      json({
        data: [
          {
            id: "qwen4-max",
            input_modalities: ["text", "image", "video"],
            context_window_tokens: 1000000,
            output_window_tokens: 65536,
            supported_parameters: ["enable_thinking", "reasoning_effort"],
            created: 1793004741
          },
          { id: "qwen-lite", context_window_tokens: "1000000" }
        ]
      }),
    () => fetchModels("token")
  )

  assert.deepEqual(result.models, ["qwen4-max", "qwen-lite"])
  assert.deepEqual(result.metadata, [
    {
      id: "qwen4-max",
      modalities: { image: true, video: true },
      contextWindowSize: 1000000,
      outputWindowSize: 65536,
      thinking: true
    }
  ])
})

test("fetchModels marks models without enable_thinking as non-thinking", async () => {
  const result = await withFetch(
    async () =>
      json({
        data: [
          { id: "qwen-lite", supported_parameters: [] },
          { id: "qwen-legacy", supported_parameters: "enable_thinking" }
        ]
      }),
    () => fetchModels("token")
  )

  assert.deepEqual(result.models, ["qwen-lite", "qwen-legacy"])
  assert.deepEqual(result.metadata, [{ id: "qwen-lite", thinking: false }])
})

test("fetchModels rejects invalid output_window_tokens values", async () => {
  const result = await withFetch(
    async () =>
      json({
        data: [
          { id: "qwen-zero", output_window_tokens: 0 },
          { id: "qwen-negative", output_window_tokens: -1 },
          { id: "qwen-text", output_window_tokens: "8192" },
          { id: "qwen-infinite", output_window_tokens: Number.POSITIVE_INFINITY },
          { id: "qwen-nan", output_window_tokens: Number.NaN }
        ]
      }),
    () => fetchModels("token")
  )

  assert.deepEqual(result.models, [
    "qwen-zero",
    "qwen-negative",
    "qwen-text",
    "qwen-infinite",
    "qwen-nan"
  ])
  assert.deepEqual(result.metadata, [])
})

test("fetchModels keeps the catalog order with duplicate ids collapsed", async () => {
  const result = await withFetch(
    async () =>
      json({
        data: [
          { id: "qwen3.8-flash", context_window_tokens: 1000000 },
          { id: "qwen3.8-max", context_window_tokens: 1000000 },
          { id: "qwen3.8-flash", context_window_tokens: 999 }
        ]
      }),
    () => fetchModels("token")
  )

  assert.deepEqual(result.models, ["qwen3.8-flash", "qwen3.8-max"])
  assert.deepEqual(result.metadata, [
    { id: "qwen3.8-flash", contextWindowSize: 1000000 },
    { id: "qwen3.8-max", contextWindowSize: 1000000 }
  ])
})

test("fetchModels surfaces an http failure", async () => {
  await withFetch(
    async () => json({}, 401),
    () => assert.rejects(fetchModels("token"), /не удалось получить список моделей/)
  )
})

const networkError = (code) => Object.assign(new TypeError(`fetch failed: ${code}`), { code })

test("refreshTokens retries a transient dns failure", async () => {
  let calls = 0
  const tokens = await withFetch(
    async () => {
      calls += 1
      if (calls === 1) throw networkError("EAI_AGAIN")
      return json({ access_token: "access", refresh_token: "next", expires_in: 60 })
    },
    () => refreshTokens("refresh")
  )

  assert.equal(calls, 2)
  assert.equal(tokens.access_token, "access")
  assert.equal(tokens.refresh_token, "next")
})

test("refreshTokens does not retry a permanent network failure", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      throw networkError("ENOTFOUND")
    },
    () => assert.rejects(refreshTokens("refresh"), /ENOTFOUND/)
  )

  assert.equal(calls, 1)
})

test("fetchModels retries a transient connection reset", async () => {
  let calls = 0
  const result = await withFetch(
    async () => {
      calls += 1
      if (calls === 1) throw networkError("ECONNRESET")
      return json({ data: [{ id: "qwen3.8-max" }] })
    },
    () => fetchModels("token")
  )

  assert.equal(calls, 2)
  assert.deepEqual(result.models, ["qwen3.8-max"])
})

test("refreshTokens gives up after bounded attempts on a persistent dns failure", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      throw networkError("EAI_AGAIN")
    },
    () =>
      assert.rejects(refreshTokens("refresh"), (error) => {
        assert.match(error.message, /EAI_AGAIN/)
        assert.doesNotMatch(error.message, /не удалось обновить токен/)
        assert.equal(error.code, "EAI_AGAIN")
        return true
      })
  )

  assert.equal(calls, 4)
})

test("refreshTokens does not retry a cancelled request", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    },
    () => assert.rejects(refreshTokens("refresh"), /aborted/)
  )

  assert.equal(calls, 1)
})

test("refreshTokens does not retry an http 401", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return json({}, 401)
    },
    () => assert.rejects(refreshTokens("refresh"), /qwen oauth 401/)
  )

  assert.equal(calls, 1)
})

test("refreshTokens does not retry an http 429", async () => {
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return json({}, 429)
    },
    () => assert.rejects(refreshTokens("refresh"), /qwen oauth 429/)
  )

  assert.equal(calls, 1)
})
