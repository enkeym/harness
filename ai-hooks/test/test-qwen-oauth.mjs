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

test("fetchModels surfaces an http failure", async () => {
  await withFetch(
    async () => json({}, 401),
    () => assert.rejects(fetchModels("token"), /не удалось получить список моделей/)
  )
})
