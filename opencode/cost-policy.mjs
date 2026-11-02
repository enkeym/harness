export const deepseekPricing = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-11-02",
  peakWindowsUTC: [[1, 4], [6, 10]],
  holidayCalendar: "not-configured",
  validatedForBilling: false
}

export function nextOffPeakAt(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid scheduling time")
  const next = new Date(now)
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return next
  const hour = now.getUTCHours()
  const window = deepseekPricing.peakWindowsUTC.find(([start, end]) => hour >= start && hour < end)
  if (window) next.setUTCHours(window[1], 0, 0, 0)
  return next
}
