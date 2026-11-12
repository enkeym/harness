import handoffRpc from "./handoff-rpc.mjs"
import {
  deepseekCostBreakdownAt,
  isPeakAt,
  nextOffPeakAt
} from "./cost-policy.mjs"

const sessionMessages = (context, sessionID) =>
  context.data?.session?.message?.list?.(sessionID) ??
  context.state?.session?.messages?.(sessionID) ??
  []

const money = (value) => `$${value.toFixed(6)}`
const modelOf = (message) => message.model?.id ?? message.modelID
const moscowTime = (date) =>
  date.toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit"
  })

function windowSummary(now = new Date()) {
  if (!isPeakAt(now)) return "сейчас непик: тариф вдвое ниже пикового"
  return `сейчас пик: непик с ${moscowTime(nextOffPeakAt(now))} MSK, тариф вдвое ниже`
}

function summarizeCost(messages) {
  const totals = {
    total: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    native: 0,
    nativeKnown: true,
    priced: 0,
    unpriced: 0
  }
  const groups = new Map()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (typeof message.cost === "number" && Number.isFinite(message.cost))
      totals.native += message.cost
    else totals.nativeKnown = false
    const modelId = modelOf(message)
    const key = `${modelId ?? "модель неизвестна"} / ${message.agent ?? "агент неизвестен"}`
    const group = groups.get(key) ?? { messages: 0, priced: 0, total: 0 }
    groups.set(key, group)
    group.messages++
    const breakdown = deepseekCostBreakdownAt(
      modelId,
      {
        input: message.tokens?.input,
        cacheRead: message.tokens?.cache?.read,
        output: message.tokens?.output,
        reasoning: message.tokens?.reasoning
      },
      message.time?.created
    )
    if (!breakdown) {
      totals.unpriced++
      continue
    }
    totals.total += breakdown.total
    totals.input += breakdown.input
    totals.cacheRead += breakdown.cacheRead
    totals.output += breakdown.output
    totals.priced++
    group.priced++
    group.total += breakdown.total
  }
  return { totals, groups }
}

function formatCost({ totals, groups }, now = new Date()) {
  if (!totals.priced)
    return `Нет сообщений с известным тарифом; без тарифа: ${totals.unpriced}.`
  const parts = [
    `Всего ${money(totals.total)}`,
    `input ${money(totals.input)}`,
    `cacheRead ${money(totals.cacheRead)}`,
    `output ${money(totals.output)}`,
    `панель ${totals.nativeKnown ? money(totals.native) : "неизвестно"}`,
    `без тарифа: ${totals.unpriced}`,
    windowSummary(now)
  ]
  for (const [name, group] of groups) {
    const perMessage = group.priced
      ? `${money(group.total / group.priced)} за сообщение`
      : "цена сообщения неизвестна"
    const unpriced = group.messages - group.priced
    parts.push(
      `${name}: ${group.messages} сообщ., ${money(group.total)}, ${perMessage}${unpriced ? `, без тарифа: ${unpriced}` : ""}`
    )
  }
  return parts.join("; ")
}

export default {
  id: "harness",
  setup: async (context) => {
    context.keymap?.layer?.(() => ({
      mode: "global",
      commands: [
        {
          id: "harness.cost",
          title: "Show session cost",
          group: "Harness",
          slash: { name: "cost" },
          run: async () => {
            const current = context.ui.router.current()
            if (current.type !== "session") {
              context.ui.toast.show({
                title: "Cost",
                message: "Откройте сессию, чтобы увидеть её стоимость.",
                variant: "info"
              })
              return
            }
            const summary = summarizeCost(
              await sessionMessages(context, current.sessionID)
            )
            context.ui.toast.show({
              title: "Cost",
              message: formatCost(summary),
              variant: summary.totals.unpriced ? "warning" : "info",
              duration: 8000
            })
          }
        }
      ]
    }))
    return context.client.rpc(handoffRpc).events.on("changed", ({ data }) => {
      const current = context.ui.router.current()
      if (current.type !== "session" || current.sessionID !== data.sessionID) return
      context.ui.toast.show({
        title: "Handoff",
        message: data.message,
        variant: data.status === "error" ? "error" : data.status === "ready" ? "success" : "info"
      })
      if (data.status === "ready" && data.targetID) {
        context.ui.router.navigate({ type: "session", sessionID: data.targetID })
      }
    })
  }
}
