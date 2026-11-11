import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import {
  nextOffPeakAt,
  isPeakAt,
  deepseekCostAt,
  deepseekCostBreakdownAt
} from "../../opencode/cost-policy.mjs"

test("DeepSeek batch scheduling waits through weekday peak windows and keeps off-peak starts", () => {
  for (const [input, expected] of [
    ["2026-11-02T00:59:59.999Z", "2026-11-02T00:59:59.999Z"],
    ["2026-11-02T01:00:00.000Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T03:59:59.999Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T04:00:00.000Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T06:00:00.000Z", "2026-11-02T10:00:00.000Z"],
    ["2026-11-02T10:00:00.000Z", "2026-11-02T10:00:00.000Z"],
    ["2026-11-01T02:00:00.000Z", "2026-11-01T02:00:00.000Z"],
    ["2026-11-07T07:00:00.000Z", "2026-11-07T07:00:00.000Z"],
    ["2026-01-01T02:00:00.000Z", "2026-01-01T02:00:00.000Z"],
    ["2026-02-19T06:30:00.000Z", "2026-02-19T06:30:00.000Z"],
    ["2026-05-04T01:30:00.000Z", "2026-05-04T01:30:00.000Z"],
    ["2026-10-01T07:00:00.000Z", "2026-10-01T07:00:00.000Z"],
    ["2026-02-24T02:00:00.000Z", "2026-02-24T04:00:00.000Z"]
  ])
    assert.equal(nextOffPeakAt(new Date(input)).toISOString(), expected)
  assert.throws(() => nextOffPeakAt(new Date("invalid")), /Invalid/)
})

test("DeepSeek peak windows cover weekday hours except weekends and holidays", () => {
  for (const [input, expected] of [
    ["2026-11-02T01:00:00.000Z", true],
    ["2026-11-02T03:59:59.999Z", true],
    ["2026-11-02T04:00:00.000Z", false],
    ["2026-11-02T06:00:00.000Z", true],
    ["2026-11-02T09:59:59.999Z", true],
    ["2026-11-02T10:00:00.000Z", false],
    ["2026-11-01T02:00:00.000Z", false],
    ["2026-11-07T07:00:00.000Z", false],
    ["2026-01-01T02:00:00.000Z", false],
    ["2026-02-24T02:00:00.000Z", true]
  ])
    assert.equal(isPeakAt(new Date(input)), expected, input)
  assert.throws(() => isPeakAt(new Date("invalid")), /Invalid/)
})

test("DeepSeek token costs follow the message time, model and cache split", () => {
  const tokens = { input: 10, output: 2, reasoning: 1, cacheRead: 5 }
  assert.ok(
    Math.abs(deepseekCostAt("deepseek-flash", tokens, "2026-11-02T12:00:00Z") - 0.000003315) < 1e-15
  )
  assert.ok(
    Math.abs(deepseekCostAt("deepseek-flash", tokens, "2026-11-02T02:00:00Z") - 0.00000663) < 1e-15
  )
  assert.ok(
    Math.abs(deepseekCostAt("deepseek-v4-pro", tokens, "2026-11-02T12:00:00Z") - 0.00001265) < 1e-15
  )
  assert.equal(
    deepseekCostAt("deepseek-flash-offpeak", tokens, "2026-11-02T12:00:00Z"),
    deepseekCostAt("deepseek-flash", tokens, "2026-11-02T12:00:00Z")
  )
  const breakdown = deepseekCostBreakdownAt("deepseek-flash", tokens, "2026-11-02T12:00:00Z")
  assert.ok(Math.abs(breakdown.input - 0.0000015) < 1e-15)
  assert.ok(Math.abs(breakdown.cacheRead - 0.000000015) < 1e-15)
  assert.ok(Math.abs(breakdown.output - 0.0000018) < 1e-15)
  assert.ok(Math.abs(breakdown.total - 0.000003315) < 1e-15)
  assert.equal(deepseekCostAt("unknown-model", tokens, "2026-11-02T12:00:00Z"), null)
  assert.equal(deepseekCostAt("deepseek-flash", tokens, "invalid"), null)
  assert.equal(deepseekCostAt("deepseek-flash", null, "2026-11-02T12:00:00Z"), null)
})

test("off-peak launcher schedules an off-peak start and keeps the selected model", async () => {
  const script = path.resolve(import.meta.dirname, "../../bin/opencode-offpeak.mjs")
  const run = promisify(execFile)
  const { stdout } = await run(process.execPath, [
    script,
    "--check",
    "--",
    "--model",
    "deepseek/deepseek-v4-pro#max"
  ])
  const result = JSON.parse(stdout)
  assert.equal(result.model, "deepseek/deepseek-v4-pro#max")
  assert.equal(result.pricing.validatedForBilling, true)
  assert.equal(isPeakAt(new Date(result.scheduledAt)), false)
  const fallback = await run(process.execPath, [script, "--check", "--", "task"])
  assert.equal(JSON.parse(fallback.stdout).model, "deepseek/deepseek-flash#high")
})
