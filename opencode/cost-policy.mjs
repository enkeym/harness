import { numeric } from "../ai-hooks/bin/cache-metrics.mjs"

export const deepseekTokenRates = {
  "deepseek-flash": {
    peak: { input: 0.3, cacheRead: 0.006, output: 1.2 },
    offPeak: { input: 0.15, cacheRead: 0.003, output: 0.6 }
  },
  "deepseek-v4-pro": {
    peak: { input: 1.32, cacheRead: 0.044, output: 3.96 },
    offPeak: { input: 0.66, cacheRead: 0.022, output: 1.98 }
  }
}

export const deepseekPricing = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-11-03",
  peakWindowsUTC: [[1, 4], [6, 10]],
  holidayCalendar: {
    year: 2026,
    timezone: "Asia/Shanghai",
    source: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
    checkedAt: "2026-11-03",
    days: [
      ["2026-01-01", "2026-01-03"],
      ["2026-02-15", "2026-02-23"],
      ["2026-04-04", "2026-04-06"],
      ["2026-05-01", "2026-05-05"],
      ["2026-06-19", "2026-06-21"],
      ["2026-09-25", "2026-09-27"],
      ["2026-10-01", "2026-10-07"]
    ]
  },
  validatedForBilling: true
}

const beijingOffsetMs = 8 * 60 * 60 * 1000

function isHoliday(now) {
  const calendar = deepseekPricing.holidayCalendar
  if (!calendar || !Array.isArray(calendar.days)) return false
  const date = new Date(now.getTime() + beijingOffsetMs).toISOString().slice(0, 10)
  return calendar.days.some(([start, end]) => date >= start && date <= end)
}

export function isPeakAt(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid pricing time")
  if (isHoliday(now)) return false
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false
  const hour = now.getUTCHours()
  return deepseekPricing.peakWindowsUTC.some(
    ([start, end]) => hour >= start && hour < end
  )
}

function breakdownAtRates(tokens, rates) {
  const reasoning = numeric(tokens.reasoning) ? tokens.reasoning : 0
  const input = (tokens.input * rates.input) / 1e6
  const cacheRead = (tokens.cacheRead * rates.cacheRead) / 1e6
  const output = ((tokens.output + reasoning) * rates.output) / 1e6
  return { input, cacheRead, output, total: input + cacheRead + output }
}

function pricedTokens(modelId, tokens, createdAt) {
  const id = typeof modelId === "string" ? modelId.replace(/-(offpeak|peak)$/, "") : ""
  const model = deepseekTokenRates[id]
  if (!model) return null
  const time = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (!Number.isFinite(time.getTime())) return null
  if (!tokens || !["input", "cacheRead", "output"].every((key) => numeric(tokens[key])))
    return null
  return { model, time }
}

export function deepseekCostBreakdownAt(modelId, tokens, createdAt) {
  const priced = pricedTokens(modelId, tokens, createdAt)
  if (!priced) return null
  return breakdownAtRates(tokens, isPeakAt(priced.time) ? priced.model.peak : priced.model.offPeak)
}

export function deepseekPricingWindowAt(modelId, tokens, costUSD, createdAt) {
  const priced = pricedTokens(modelId, tokens, createdAt)
  if (!priced || !numeric(costUSD)) return null
  const near = (value) =>
    Math.abs(value - costUSD) <= Math.max(1e-9, Math.abs(costUSD) * 0.005)
  const peak = breakdownAtRates(tokens, priced.model.peak).total
  const offPeak = breakdownAtRates(tokens, priced.model.offPeak).total
  const clockPeak = isPeakAt(priced.time)
  if (near(peak) && !near(offPeak))
    return { window: "peak", source: "native-cost", agreesWithClock: clockPeak }
  if (near(offPeak) && !near(peak))
    return { window: "offPeak", source: "native-cost", agreesWithClock: !clockPeak }
  return { window: clockPeak ? "peak" : "offPeak", source: "clock", agreesWithClock: true }
}

export function deepseekCostAt(modelId, tokens, createdAt) {
  const breakdown = deepseekCostBreakdownAt(modelId, tokens, createdAt)
  return breakdown ? breakdown.total : null
}

export function nextOffPeakAt(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid scheduling time")
  const next = new Date(now)
  if (isHoliday(now)) return next
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return next
  const hour = now.getUTCHours()
  const window = deepseekPricing.peakWindowsUTC.find(([start, end]) => hour >= start && hour < end)
  if (window) next.setUTCHours(window[1], 0, 0, 0)
  return next
}
