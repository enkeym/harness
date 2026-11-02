import handoffRpc from "./handoff-rpc.mjs"

export default {
  id: "harness",
  setup: async (context) => context.client.rpc(handoffRpc).events.on("changed", ({ data }) => {
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
