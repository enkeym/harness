const MENU_TOOLS = new Set(["question"])

const FENCE_RE = /^\s*(```|~~~)/
const QUOTE_RE = /^\s*>/
const INLINE_CODE_RE = /`[^`\n]*`/g
const HEADING_RE = /^#{1,6}\s/
const QUESTION_END_RE = /\?[:!\s*_)\]»"'“”\p{Extended_Pictographic}\u{FE0F}\u{200D}]*$/u
const QUESTION_MID_RE = /\?[*_)\]»"'“”]*\s+[\p{Lu}]/u
const OPEN_RE = /(?<![\p{L}\p{N}])(?:открыт\p{L}*\s+(?:[\p{L}\p{N}]+\s+){0,2}вопрос|вопрос\p{L}*\s+(?:[\p{L}\p{N}]+\s+){0,2}открыт|open questions?(?![\p{L}\p{N}]))/iu
const OPEN_CLOSED_RE = /(?<![\p{L}\p{N}])(?:нет|не остал\p{L}*|закрыл\p{L}*|снят\p{L}*|решён|решен\p{L}*|none)(?![\p{L}\p{N}])/iu
const OPEN_PARAS = 2
const QUOTED_RE = /«[^»]*»|„[^“”]*[“”]|"[^"]*"|“[^”]*”/g
const AWAIT_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:'
  + 'как скажете|скажите|напишите|дайте знать|подтвердите'
  + '|жду (?:вашего|вашей|ваш|ответа|решения|подтверждения|отмашки|команды|ок)'
  + '|если (?:согласны|хотите|не против|скажете)'
  + '|если (?:нужно|надо)[^.]*могу'
  + '|решать вам|на ваше усмотрение|выбор за вами'
  + '|let me know|should i|shall i|want me to|do you want|would you like'
  + "|if you(?:'d)? (?:like|want|prefer|agree)"
  + ')(?![\\p{L}\\p{N}])', 'iu')
const OPTIONS_HEAD_RE = /^(?:варианты|на выбор|options)(?![\p{L}\p{N}])|^можно(?! было)\s.+\sили\s/iu
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*•]|[a-zа-я]\))\s+\S/i
const UAC_RE = /(?<![\p{L}\p{N}])uac(?![\p{L}\p{N}])/iu
const MIN_OPTIONS = 2
const HISTORY_LIMIT = 500

export const REASON = "The reply ends with a question to the user or waits for their decision in text. "
  + "core.md rule: a question goes only through the question tool, choices in options, "
  + "the recommended one first. Ask it now through the question tool. A rhetorical question "
  + "that expects no answer — rewrite the ending without it. An offer of more work or a wait "
  + "for the user's action — an option in the menu, or drop it."

function proseLines(text) {
  const out = []
  let fenced = false
  let para = 0
  for (const line of String(text).split("\n")) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced
      para++
      continue
    }
    if (fenced) continue
    if (!line.trim() || QUOTE_RE.test(line)) {
      para++
      continue
    }
    const prose = line.replace(INLINE_CODE_RE, "").trim()
    if (prose && !HEADING_RE.test(prose)) out.push({ text: prose, para })
  }
  return out
}

const asks = (line) => QUESTION_END_RE.test(line)
  || QUESTION_MID_RE.test(line)
  || (!UAC_RE.test(line) && AWAIT_RE.test(line.replace(QUOTED_RE, "")))
  || OPTIONS_HEAD_RE.test(line)

export function pendingQuestion(text) {
  const lines = proseLines(text)
  if (!lines.length) return null
  const lastPara = lines[lines.length - 1].para
  const hit = lines.find((line) => line.para === lastPara && asks(line.text))
  if (hit) return hit.text
  const tailParas = [...new Set(lines.map((line) => line.para))].slice(-OPEN_PARAS)
  const open = lines.find((line) => {
    const prose = line.text.replace(QUOTED_RE, "")
    return tailParas.includes(line.para) && OPEN_RE.test(prose) && !OPEN_CLOSED_RE.test(prose)
  })
  if (open) return open.text
  let i = lines.length
  while (i > 0 && LIST_ITEM_RE.test(lines[i - 1].text)) i--
  if (lines.length - i >= MIN_OPTIONS && i > 0 && asks(lines[i - 1].text)) return lines[i - 1].text
  return null
}

export function lastTurn(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = list.length
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i]?.type === "user") {
      start = i
      break
    }
  const human = start < list.length ? list[start].id ?? `index:${start}` : null
  let text = null
  let menu = false
  let tools = false
  for (let i = start + 1; i < list.length; i++) {
    const message = list[i]
    if (message?.type !== "assistant") continue
    const parts = Array.isArray(message.content) ? message.content : []
    for (const part of parts) {
      if (part?.type !== "tool") continue
      tools = true
      if (MENU_TOOLS.has(part.name)) menu = true
    }
    const texts = parts.filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
    if (texts.length) text = texts[texts.length - 1].text
  }
  const first = start >= list.length || !list.slice(0, start).some((message) => message?.type === "assistant")
  return { human, text, menu, tools, first }
}

export async function registerQuestionGuard(context) {
  const guarded = new Map()
  const check = async (sessionID, source) => {
    if (!sessionID) return null
    if (source?.parentID) return null
    const messages = await context.session.context({ sessionID })
    const { human, text, menu, tools, first } = lastTurn(messages)
    if (human === null || guarded.get(sessionID) === human) return null
    if (menu || !text) return null
    if (first && !tools && proseLines(text).length === 1) return null
    const line = pendingQuestion(text)
    if (!line) return null
    guarded.set(sessionID, human)
    if (guarded.size > HISTORY_LIMIT) guarded.delete(guarded.keys().next().value)
    const notice = `${REASON} Triggered by the line: «${line.slice(0, 200)}».`
    try {
      await context.session.synthetic({ sessionID, text: notice })
    } catch (error) {
      guarded.delete(sessionID)
      throw error
    }
    return line
  }
  return { check }
}
