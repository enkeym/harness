import assert from "node:assert/strict"
import { test } from "node:test"
import { modelTuning } from "../../opencode/qwen-oauth/models.mjs"

const fullDetail = {
  id: "qwen3.8-max",
  modalities: { image: true, video: true },
  contextWindowSize: 1_000_000
}

test("default tuning mirrors the economical low profile", () => {
  const tuning = modelTuning(fullDetail)

  assert.deepEqual(tuning.input, ["text", "image", "video"])
  assert.equal(tuning.context, 1_000_000)
  assert.equal(tuning.outputLimit, 32768)
  assert.equal(tuning.body.max_tokens, 8192)
  assert.equal(tuning.body.enable_thinking, true)
  assert.equal(tuning.body.reasoning_effort, "low")
  assert.equal(tuning.compatibility.reasoningField, "reasoning_content")
  assert.deepEqual(
    tuning.variants.map((variant) => variant.id),
    ["low", "high"]
  )
  assert.deepEqual(tuning.variants[0].body, tuning.body)
  assert.equal(tuning.variants[1].body.reasoning_effort, "high")
  assert.equal(tuning.variants[1].body.max_tokens, 8192)
})

test("the output cap never exceeds the server output limit", () => {
  const small = modelTuning({ ...fullDetail, outputWindowSize: 4096 })
  assert.equal(small.outputLimit, 4096)
  assert.equal(small.body.max_tokens, 4096)

  const medium = modelTuning({ ...fullDetail, outputWindowSize: 20000 })
  assert.equal(medium.outputLimit, 20000)
  assert.equal(medium.body.max_tokens, 8192)
})

test("a model without thinking capability gets no thinking fields or variants", () => {
  const tuning = modelTuning({ ...fullDetail, thinking: false })

  assert.deepEqual(tuning.body, { max_tokens: 8192 })
  assert.equal("enable_thinking" in tuning.body, false)
  assert.equal("reasoning_effort" in tuning.body, false)
  assert.deepEqual(tuning.variants, [])
  assert.equal(tuning.compatibility, undefined)
})

test("fallbacks apply when the catalog has no metadata", () => {
  const tuning = modelTuning(undefined)

  assert.deepEqual(tuning.input, ["text"])
  assert.equal(tuning.context, 1_000_000)
  assert.equal(tuning.outputLimit, 32768)
  assert.equal(tuning.body.max_tokens, 8192)
})

test("bodies never carry a prompt cache key or unknown effort levels", () => {
  const tuning = modelTuning(fullDetail)
  const bodies = [tuning.body, ...tuning.variants.map((variant) => variant.body)]

  for (const body of bodies) {
    assert.equal("prompt_cache_key" in body, false)
    assert.ok(body.reasoning_effort === "low" || body.reasoning_effort === "high")
    assert.equal(body.enable_thinking, true)
  }
})
