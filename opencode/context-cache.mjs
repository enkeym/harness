import { createHash } from "node:crypto"
import { cachePolicy } from "./cache-policy.mjs"
import { readTexts } from "./read-results.mjs"

export function deduplicateContext(messages) {
  const held = new Map()
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || part.providerExecuted) return part
        const result = part.result
        const text =
          result?.type === "text" && typeof result.value === "string"
            ? result.value
            : result?.type === "content" &&
                result.value.every(
                  (item) =>
                    item.type === "text" && typeof item.text === "string"
                )
              ? result.value.map((item) => item.text).join("\n")
              : null
        if (text === null) return part
        const read = readTexts(text).length > 0
        if (
          (!read && part.name !== "skill") ||
          Buffer.byteLength(text) < cachePolicy.readResultMinBytes ||
          /full_result=|unchanged: true/.test(text)
        )
          return part
        const key = createHash("sha256")
          .update(
            JSON.stringify([part.namespace, part.name, result.type, text])
          )
          .digest("hex")
        const previous = held.get(key)
        if (!previous) {
          held.set(key, part.id)
          return part
        }
        return {
          ...part,
          result: {
            type: "text",
            value: `[harness: identical read result retained in tool call ${previous} in this request; use that complete text.]`
          }
        }
      })
    }
  })
}
