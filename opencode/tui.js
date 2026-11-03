import handoffRpc from "./handoff-rpc.mjs"
import { deepseekCostBreakdownAt } from "./cost-policy.mjs"

const sessionMessages = (context, sessionID) =>
  context.data?.session?.message?.list?.(sessionID) ??
  context.state?.session?.messages?.(sessionID) ??
  []

const money = (value) => `$${value.toFixed(6)}`

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
  for (const message of messages) {
    if (message.role !== "assistant") continue
    if (typeof message.cost === "number" && Number.isFinite(message.cost))
      totals.native += message.cost
    else totals.nativeKnown = false
    const breakdown = deepseekCostBreakdownAt(
      message.modelID,
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
  }
  return totals
}

function formatCost(totals) {
  if (!totals.priced)
    return `Нет сообщений с известным тарифом; без тарифа: ${totals.unpriced}.`
  return [
    `Всего ${money(totals.total)}`,
    `input ${money(totals.input)}`,
    `cacheRead ${money(totals.cacheRead)}`,
    `output ${money(totals.output)}`,
    `панель ${totals.nativeKnown ? money(totals.native) : "неизвестно"}`,
    `без тарифа: ${totals.unpriced}`
  ].join("; ")
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
            const totals = summarizeCost(
              await sessionMessages(context, current.sessionID)
            )
            context.ui.toast.show({
              title: "Cost",
              message: formatCost(totals),
              variant: totals.unpriced ? "warning" : "info",
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
      if (data.status === "ready") {
        context.ui.router.navigate({ type: "session", sessionID: data.targetID })
      }
    })
  }
}
