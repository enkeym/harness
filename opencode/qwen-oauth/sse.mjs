const LOG = "[qwen.oauth]"
const DATA_PREFIX = "data:"
const DONE = "[DONE]"

function payloadText(line) {
  return line.slice(DATA_PREFIX.length).trim()
}

function parsePayload(text, log) {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === "object") return value
  } catch {}
  log(`malformed stream payload: ${text.slice(0, 200)}`)
  return undefined
}

function contributes(chunk) {
  if (chunk.usage !== undefined || chunk.error !== undefined) return true
  return (chunk.choices ?? []).some(
    (choice) =>
      Boolean(choice?.finish_reason) ||
      Boolean(choice?.delta && Object.keys(choice.delta).length > 0)
  )
}

function toolCallsOf(chunk) {
  const found = []
  if (!Array.isArray(chunk.choices)) return found
  for (const choice of chunk.choices) {
    const list = choice?.delta?.tool_calls
    if (!Array.isArray(list)) continue
    for (const call of list) {
      if (call && typeof call === "object") found.push(call)
    }
  }
  return found
}

function functionName(call) {
  const name = call.function?.name
  return typeof name === "string" && name ? name : undefined
}

function indexOf(call) {
  return Number.isInteger(call.index) ? call.index : 0
}

function syntheticID(index) {
  return `call_qwen_${index}`
}

export function sanitizeChatStream(
  body,
  log = (message) => console.warn(`${LOG} ${message}`)
) {
  const known = new Map()
  const queue = []
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let tail = ""

  const resolve = (chunk, index) => {
    for (const call of toolCallsOf(chunk)) {
      if (!Number.isInteger(call.index)) call.index = index
      const entry = known.get(call.index) ?? {}
      if (typeof call.id === "string" && call.id) entry.id = call.id
      const name = functionName(call)
      if (name) entry.name = name
      if (!entry.id && name) entry.id = syntheticID(call.index)
      known.set(call.index, entry)
      if (!call.id && entry.id) call.id = entry.id
      if (call.id && !call.type) call.type = "function"
      if (!name && entry.name) {
        call.function = { ...(call.function ?? {}), name: entry.name }
      }
    }
    return toolCallsOf(chunk).every(
      (call) => Boolean(call.id) && Boolean(functionName(call))
    )
  }

  const encode = (chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)

  const pushRaw = (text, controller) => {
    if (queue.length) {
      queue.push(text)
      drain(controller)
      return
    }
    controller.enqueue(encoder.encode(text))
  }

  function drain(controller) {
    while (queue.length) {
      const item = queue[0]
      if (typeof item === "string") {
        queue.shift()
        controller.enqueue(encoder.encode(item))
        continue
      }
      const first = toolCallsOf(item)[0]
      if (!resolve(item, first ? indexOf(first) : 0)) break
      queue.shift()
      controller.enqueue(encode(item))
    }
  }

  function handle(line, controller) {
    if (!line.trim()) return
    if (!line.startsWith(DATA_PREFIX)) {
      pushRaw(`${line}\n`, controller)
      return
    }
    const text = payloadText(line)
    if (text === DONE) {
      pushRaw(`data: ${DONE}\n\n`, controller)
      return
    }
    if (!text) return
    const payload = parsePayload(text, log)
    if (!payload) return
    if (!toolCallsOf(payload).length) {
      if (queue.length) {
        queue.push(payload)
        drain(controller)
      } else controller.enqueue(encode(payload))
      return
    }
    const resolved = resolve(payload, 0)
    if (queue.length || !resolved) {
      queue.push(payload)
      drain(controller)
      return
    }
    controller.enqueue(encode(payload))
    drain(controller)
  }

  function finalize(controller) {
    for (const item of queue) {
      if (typeof item === "string") {
        controller.enqueue(encoder.encode(item))
        continue
      }
      const broken = []
      for (const choice of item.choices ?? []) {
        const list = choice?.delta?.tool_calls
        if (!Array.isArray(list)) continue
        const kept = list.filter((call) => {
          const ok = Boolean(call.id) && Boolean(functionName(call))
          if (!ok) broken.push(call)
          return ok
        })
        if (kept.length) choice.delta.tool_calls = kept
        else delete choice.delta.tool_calls
      }
      if (broken.length) {
        const shape = broken.map((call) => ({
          index: call.index,
          hasID: Boolean(call.id),
          hasName: Boolean(functionName(call)),
          argumentChars:
            typeof call.function?.arguments === "string"
              ? call.function.arguments.length
              : 0
        }))
        log(`dropped tool call without id/name: ${JSON.stringify(shape)}`)
      }
      if (contributes(item)) controller.enqueue(encode(item))
    }
    queue.length = 0
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
