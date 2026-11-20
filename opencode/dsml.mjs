const LOG = "[harness.dsml]"
const DATA_PREFIX = "data:"
const DONE = "[DONE]"
const CHAT_CHUNK = "chat.completion.chunk"
const TAG = /<[^<>\s]{0,6}DSML[^<>\s]{0,10}\s*[a-z_]*\s*[^<>]*>/gi
const DSML_NEEDLE = "DSML"
const MAX_PENDING_TAG = 96

const tagKind = (tag) => {
  const body = tag.replace(/^<\/?/, "").replace(/>$/, "")
  if (body.startsWith("/") || tag.startsWith("</")) {
    if (/\bparameter\b/.test(body)) return "parameter-close"
    if (/\binvoke\b/.test(body)) return "invoke-close"
    if (/\bcalls?\b/.test(body)) return "calls-close"
    return "unknown"
  }
  if (/\bparameter\b/.test(body)) return "parameter-open"
  if (/\binvoke\b/.test(body)) return "invoke-open"
  if (/\bcalls?\b/.test(body)) return "calls-open"
  return "unknown"
}

const attribute = (tag, name) => {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return match ? match[1] : undefined
}

const parameterValue = (raw, isString) => {
  if (isString) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function parseDsmlCalls(block) {
  TAG.lastIndex = 0
  const calls = []
  let invoke
  let parameter
  let match
  while ((match = TAG.exec(block))) {
    const tag = match[0]
    const kind = tagKind(tag)
    if (kind === "invoke-open") {
      invoke = { name: attribute(tag, "name"), arguments: {} }
      parameter = undefined
    } else if (kind === "parameter-open") {
      parameter = {
        name: attribute(tag, "name"),
        string: attribute(tag, "string") === "true",
        start: TAG.lastIndex
      }
    } else if (kind === "parameter-close" && parameter && invoke) {
      const raw = block.slice(parameter.start, match.index)
      if (parameter.name) {
        invoke.arguments[parameter.name] = parameterValue(raw, parameter.string)
      }
      parameter = undefined
    } else if (kind === "invoke-close" && invoke) {
      if (invoke.name) calls.push(invoke)
      invoke = undefined
      parameter = undefined
    }
  }
  return calls
}

const findDsmlStart = (text) => {
  let index = text.indexOf(DSML_NEEDLE)
  while (index >= 0) {
    const open = text.lastIndexOf("<", index)
    if (open >= 0 && index - open <= 24) return open
    index = text.indexOf(DSML_NEEDLE, index + 1)
  }
  return -1
}

const findTagEnd = (text, from) => {
  const end = text.indexOf(">", from)
  return end < 0 ? -1 : end + 1
}

const callLabel = (calls) =>
  `[unexecuted tool call: ${calls.map((call) => call.name ?? "unknown").join(", ")}]`

export function stripDsmlText(text) {
  if (typeof text !== "string" || !text.includes(DSML_NEEDLE)) return text
  let result = ""
  let cursor = 0
  for (;;) {
    const start = findDsmlStart(text.slice(cursor))
    if (start < 0) break
    const open = cursor + start
    result += text.slice(cursor, open)
    const end = findTagEnd(text, open)
    if (end < 0) return result
    const tag = text.slice(open, end)
    if (tagKind(tag) !== "calls-open") {
      cursor = end
      continue
    }
    TAG.lastIndex = end
    let closing
    let match
    while ((match = TAG.exec(text))) {
      if (tagKind(match[0]) === "calls-close") {
        closing = { start: match.index, end: TAG.lastIndex }
        break
      }
    }
    const blockEnd = closing ? closing.end : text.length
    const calls = parseDsmlCalls(text.slice(open, blockEnd))
    if (calls.length) result += callLabel(calls)
    cursor = blockEnd
  }
  result += text.slice(cursor)
  return result
}

export function sanitizeDsmlJson(payload) {
  const choices = payload?.choices
  if (!Array.isArray(choices)) return { changed: false }
  let changed = false
  for (const choice of choices) {
    const message = choice?.message
    if (!message || typeof message.content !== "string" || !message.content.includes(DSML_NEEDLE))
      continue
    const calls = parseDsmlCalls(message.content)
    const content = stripDsmlText(message.content)
    if (content !== message.content) {
      message.content = content
      changed = true
    }
    if (!calls.length) continue
    message.tool_calls = calls.map((call, index) => ({
      id: `call_dsml_json_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }))
    choice.finish_reason = "tool_calls"
    changed = true
  }
  return { changed }
}

export function sanitizeMessageTexts(messages) {
  if (!Array.isArray(messages)) return { changed: 0, repeated: [] }
  let changed = 0
  const seen = new Set()
  const repeated = new Set()
  for (const message of messages) {
    if (!message) continue
    if (typeof message.content === "string") {
      if (!message.content.includes(DSML_NEEDLE)) continue
      const next = stripDsmlText(message.content)
      if (next !== message.content) {
        message.content = next
        changed += 1
      }
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes(DSML_NEEDLE))
        continue
      const next = stripDsmlText(part.text)
      const key = next.trim()
      if (message.role === "assistant" && key) {
        if (seen.has(key)) repeated.add(key)
        else seen.add(key)
      }
      if (next !== part.text) {
        part.text = next
        changed += 1
      }
    }
  }
  return { changed, repeated: [...repeated] }
}

export function sanitizeDsmlJsonStream(
  body,
  log = (message) => console.warn(`${LOG} ${message}`)
) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ""
  return body.pipeThrough(
    new TransformStream({
      transform(bytes) {
        buffer += decoder.decode(bytes, { stream: true })
      },
      flush(controller) {
        buffer += decoder.decode()
        let text = buffer
        try {
          const payload = JSON.parse(buffer)
          const { changed } = sanitizeDsmlJson(payload)
          if (changed) {
            text = JSON.stringify(payload)
            log("converted DSML tool calls in a non-streaming response")
          }
        } catch {
          log("non-streaming response body is not JSON; left unchanged")
        }
        controller.enqueue(encoder.encode(text))
      }
    })
  )
}

const deltaOf = (payload) => {
  const choice = payload?.choices?.[0]
  if (!choice) return undefined
  return choice.delta
}

const contributes = (payload) => {
  if (payload?.usage !== undefined || payload?.error !== undefined) return true
  return (payload?.choices ?? []).some(
    (choice) =>
      Boolean(choice?.finish_reason) ||
      Boolean(choice?.delta && Object.keys(choice.delta).length)
  )
}

const contentOf = (payload) => {
  const text = deltaOf(payload)?.content
  return typeof text === "string" ? text : undefined
}

export function sanitizeDsmlStream(
  body,
  log = (message) => console.warn(`${LOG} ${message}`)
) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let tail = ""
  let template

  const encode = (payload) => encoder.encode(`${DATA_PREFIX} ${JSON.stringify(payload)}\n\n`)

  const raw = (line, controller) => controller.enqueue(encoder.encode(`${line}\n\n`))

  const chunk = (text, extra = {}) => ({
    ...(template ?? { object: CHAT_CHUNK }),
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
        ...extra
      }
    ]
  })

  const toolChunk = (calls, converted) => {
    const sequence = converted ? `_${converted}` : ""
    return {
      ...(template ?? { object: CHAT_CHUNK }),
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call_dsml${sequence}_${index}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments)
              }
            }))
          },
          finish_reason: null
        }
      ]
    }
  }

  const state = {
    hold: "",
    inDsml: false,
    converted: 0
  }

  const pendingTagStart = (text) => {
    if (text.length > MAX_PENDING_TAG) return text.length
    const lastOpen = text.lastIndexOf("<")
    if (lastOpen < 0) return text.length
    if (text.indexOf(">", lastOpen) >= 0) return text.length
    return lastOpen
  }

  const flushText = (text, controller) => {
    if (!text) return
    controller.enqueue(encode(chunk(text)))
  }

  const consume = (controller) => {
    for (;;) {
      if (!state.inDsml) {
        const start = findDsmlStart(state.hold)
        if (start < 0) {
          const cut = pendingTagStart(state.hold)
          flushText(state.hold.slice(0, cut), controller)
          state.hold = state.hold.slice(cut)
          return
        }
        const end = findTagEnd(state.hold, start)
        if (end < 0) {
          flushText(state.hold.slice(0, start), controller)
          state.hold = state.hold.slice(start)
          return
        }
        const tag = state.hold.slice(start, end)
        if (tagKind(tag) !== "calls-open") {
          flushText(state.hold.slice(0, end), controller)
          state.hold = state.hold.slice(end)
          continue
        }
        flushText(state.hold.slice(0, start), controller)
        state.hold = state.hold.slice(end)
        state.inDsml = true
        continue
      }
      TAG.lastIndex = 0
      let closing
      let match
      while ((match = TAG.exec(state.hold))) {
        if (tagKind(match[0]) === "calls-close") {
          closing = { start: match.index, end: TAG.lastIndex }
        }
      }
      if (!closing) return
      const block = state.hold.slice(0, closing.end)
      state.hold = state.hold.slice(closing.end)
      state.inDsml = false
      const calls = parseDsmlCalls(block)
      if (!calls.length) {
        log(`unparsed DSML block of ${block.length} chars`)
        continue
      }
      state.converted += 1
      log(`converted ${calls.length} DSML call(s): ${calls.map((call) => call.name).join(", ")}`)
      controller.enqueue(encode(toolChunk(calls, state.converted)))
    }
  }

  const handle = (line, controller) => {
    if (!line.trim()) return
    if (!line.startsWith(DATA_PREFIX)) {
      controller.enqueue(encoder.encode(`${line}\n`))
      return
    }
    const text = line.slice(DATA_PREFIX.length).trim()
    if (text === DONE) {
      controller.enqueue(encoder.encode(`${DATA_PREFIX} ${DONE}\n\n`))
      return
    }
    if (!text) return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      log(`malformed stream payload: ${text.slice(0, 200)}`)
      raw(line, controller)
      return
    }
    if (!payload || typeof payload !== "object") {
      raw(line, controller)
      return
    }
    if (payload.object !== CHAT_CHUNK) {
      raw(line, controller)
      return
    }
    template ??= payload
    const content = contentOf(payload)
    if (content !== undefined) {
      state.hold += content
      const { content: _dropped, ...rest } = deltaOf(payload) ?? {}
      if (Object.keys(rest).length) {
        const forwarded = {
          ...payload,
          choices: payload.choices.map((choice) => ({
            ...choice,
            delta: rest
          }))
        }
        controller.enqueue(encode(forwarded))
      }
      consume(controller)
      return
    }
    if (
      payload.choices?.some((choice) => choice?.finish_reason) &&
      state.converted &&
      !state.inDsml &&
      !state.hold
    ) {
      const rewritten = {
        ...payload,
        choices: payload.choices.map((choice) =>
          choice?.finish_reason
            ? { ...choice, finish_reason: "tool_calls" }
            : choice
        )
      }
      controller.enqueue(encode(rewritten))
      return
    }
    if (contributes(payload)) controller.enqueue(encode(payload))
  }

  const finalize = (controller) => {
    if (!state.hold) return
    const text = state.hold
    state.hold = ""
    const unterminated = state.inDsml
    state.inDsml = false
    if (unterminated) {
      const calls = parseDsmlCalls(text)
      if (calls.length) {
        state.converted += 1
        log(`converted unterminated DSML block (${calls.length} calls)`)
        controller.enqueue(encode(toolChunk(calls, state.converted)))
        controller.enqueue(
          encode({
            ...(template ?? { object: CHAT_CHUNK }),
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
          })
        )
        return
      }
      const stripped = stripDsmlText(text)
      log(`stripped unterminated DSML block of ${text.length} chars`)
      flushText(stripped, controller)
      return
    }
    flushText(stripDsmlText(text), controller)
  }

  return body.pipeThrough(
    new TransformStream({
      transform(bytes, controller) {
        const text = tail + decoder.decode(bytes, { stream: true })
        const lines = text.split("\n")
        tail = lines.pop() ?? ""
        for (const line of lines) handle(line, controller)
      },
      flush(controller) {
        const rest = tail + decoder.decode()
        tail = ""
        for (const line of rest.split("\n")) handle(line, controller)
        finalize(controller)
      }
    })
  )
}
