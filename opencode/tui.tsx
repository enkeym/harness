import plugin from "./tui.js"
import { createMemo, createSignal, Show } from "solid-js"

const REFRESH_MS = 60_000

const percent = (value) => `${Math.round(value)}%`
const meter = (label, value) =>
  `${label} ${percent(value.percent)}${value.limited ? "!" : ""}`

const tokensLabel = (value) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return `${value}`
}

const footerText = (info) => {
  const go = info?.go
  if (!go) return ""
  return [meter("5ч", go.rolling), meter("нед", go.weekly), meter("мес", go.monthly)].join(" · ")
}

const lastAssistantWithUsage = (messages, boundary) => {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end
  )
  return messages.findLast(
    (message, index) =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end
  )
}

const contextUsage = (context, sessionID) => {
  const session = context.data.session.get(sessionID)
  if (!session) return undefined
  const last = lastAssistantWithUsage(
    context.data.session.message.list(sessionID),
    session.revert?.messageID
  )
  if (!last) return undefined
  const tokens =
    last.tokens.input +
    last.tokens.output +
    last.tokens.reasoning +
    last.tokens.cache.read +
    last.tokens.cache.write
  if (tokens <= 0) return undefined
  const location = session.location ?? context.location ?? context.data.location.default()
  const models = context.data.location.model.list(location)
  const current = models?.find(
    (item) => item.providerID === last.model.providerID && item.id === last.model.id
  )
  return {
    tokens,
    percent: current?.limit.context ? Math.round((tokens / current.limit.context) * 100) : undefined
  }
}

const liveCounts = (context, sessionID) => {
  const count = context.data.session
    .family(sessionID)
    .filter(
      (id) =>
        id !== sessionID && context.data.session.status(id) === "running"
    ).length
  const shells = context.data.shell
    .list(context.location)
    .filter((shell) => shell.metadata?.sessionID === sessionID).length
  return [
    count ? `${count} subagent${count === 1 ? "" : "s"}` : undefined,
    shells ? `${shells} shell${shells === 1 ? "" : "s"}` : undefined
  ].filter(Boolean)
}

const PromptFooter = (props) => {
  const location = createMemo(() => {
    const target = props.context.location ?? props.context.data.location.default()
    if (!target) return ""
    const path = props.context.ui.format.path(target.directory)
    const branch = props.context.data.location.vcs.info(target)?.branch?.current
    return branch ? `${path}:${branch}` : path
  })
  const usage = createMemo(() => {
    if (!props.showDetails || !props.sessionID) return ""
    const info = contextUsage(props.context, props.sessionID)
    if (!info) return ""
    return info.percent === undefined
      ? `ctx ${tokensLabel(info.tokens)}`
      : `ctx ${tokensLabel(info.tokens)} (${info.percent}%)`
  })
  const live = createMemo(() =>
    props.sessionID ? liveCounts(props.context, props.sessionID).join(" · ") : ""
  )
  const left = createMemo(() => {
    if (props.mode === "shell") return "esc exit shell mode"
    return [location(), usage(), live()].filter(Boolean).join(" · ")
  })

  return (
    <box width="100%" flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <Show when={left()}>
        {(value) => (
          <text fg={props.context.theme.text.muted} wrapMode="none" flexShrink={1}>{value()}</text>
        )}
      </Show>
      <Show when={props.mode !== "shell" && props.showDetails && props.usage()}>
        {(value) => (
          <text fg={props.context.theme.text.muted} wrapMode="none" flexShrink={0}>{value()}</text>
        )}
      </Show>
    </box>
  )
}

export default {
  id: plugin.id,
  setup: async (context) => {
    const disposals = []
    const cleanup = await plugin.setup(context)
    if (typeof cleanup === "function") disposals.push(cleanup)

    const store = context.data?.location?.usage
    const location = context.location ?? context.data.location.default()
    const [text, setText] = createSignal("")
    const refresh = async () => {
      if (!store) return
      try {
        await store.sync(location)
        setText(footerText(store.limits(location)))
      } catch {
        setText("")
      }
    }

    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    disposals.push(() => clearInterval(timer))
    const stop = context.data.on?.("session.execution.succeeded", refresh)
    if (typeof stop === "function") disposals.push(stop)

    const replace = context.ui.slot?.({
      replace: "prompt.footer",
      render: (input) => (
        <PromptFooter
          context={context}
          sessionID={input.sessionID}
          mode={input.mode}
          showDetails={input.showDetails}
          usage={text}
        />
      )
    })
    if (typeof replace === "function") disposals.push(replace)

    const render = () => (text() ? <text fg={context.theme.text.muted}>{text()}</text> : null)
    for (const slot of ["home.footer.status"]) {
      const dispose = context.ui.slot?.({ append: slot, render })
      if (typeof dispose === "function") disposals.push(dispose)
    }

    return () => disposals.reverse().forEach((dispose) => dispose())
  }
}
