import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import { nextOffPeakAt } from "../../opencode/cost-policy.mjs"

test("DeepSeek batch scheduling waits through weekday peak windows and keeps off-peak starts", () => {
  for (const [input, expected] of [
    ["2026-11-02T00:59:59.999Z", "2026-11-02T00:59:59.999Z"],
    ["2026-11-02T01:00:00.000Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T03:59:59.999Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T04:00:00.000Z", "2026-11-02T04:00:00.000Z"],
    ["2026-11-02T06:00:00.000Z", "2026-11-02T10:00:00.000Z"],
    ["2026-11-02T10:00:00.000Z", "2026-11-02T10:00:00.000Z"],
    ["2026-11-01T02:00:00.000Z", "2026-11-01T02:00:00.000Z"],
    ["2026-11-07T07:00:00.000Z", "2026-11-07T07:00:00.000Z"]
  ])
    assert.equal(nextOffPeakAt(new Date(input)).toISOString(), expected)
  assert.throws(() => nextOffPeakAt(new Date("invalid")), /Invalid/)
})
