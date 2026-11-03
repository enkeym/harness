export function readTexts(value, depth = 0) {
  if (depth > 10 || value == null) return []
  if (typeof value === "string") {
    if (
      /^file: .+\nmode: (?:full|lines|map|signatures)\ndigest: [a-f0-9]{64}\n/.test(value) &&
      (value.match(/^file: /gm)?.length ?? 0) === 1
    )
      return [value]
    if (/^\s*[{[]/.test(value)) {
      try {
        return readTexts(JSON.parse(value.replace(/\n\ntokensave_metrics: [^\n]*\n?$/, "")), depth + 1)
      } catch {
        return []
      }
    }
    return []
  }
  if (
    typeof value === "object" &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    !/[\r\n]/.test(value.file) &&
    /^(?:full|lines|map|signatures)$/.test(value.mode) &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.body === "string" &&
    !value.unchanged &&
    !value.full_result
  )
    return [`file: ${value.file}\nmode: ${value.mode}\ndigest: ${value.digest}\n\n${value.body}`]
  if (typeof value === "object" && "file" in value && "mode" in value) return []
  return typeof value === "object"
    ? Object.values(value).flatMap(part => readTexts(part, depth + 1))
    : []
}
