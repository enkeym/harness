import assert from "node:assert/strict"
import { test } from "node:test"
import { lastTurn, pendingQuestion, registerQuestionGuard, REASON } from "../../opencode/question-guard.mjs"

const user = (id, text) => ({ id, type: "user", text })
const say = (...texts) => ({ type: "assistant", content: texts.map((text) => ({ type: "text", text })) })
const tool = (name) => ({ type: "assistant", content: [{ type: "tool", id: `t-${name}`, name, state: { status: "completed" } }] })

function turn(text) {
  return [user("msg_1", "x"), say(text)]
}

function fixture(messages) {
  const notices = []
  const context = {
    session: {
      context: async () => messages,
      synthetic: async ({ sessionID, text }) => notices.push({ sessionID, text })
    }
  }
  return { context, notices }
}

test("a reply ending with a question is reported", () => {
  for (const text of [
    "Починил.\n\nКоммитить сейчас?",
    "Итог.\n\n**Какой вариант берём?**",
    "Итог:\n\n- хук поправлен\n- пушить?",
    "Причина в авторизации.\n\nКакой метод показывает `/status`? По нему можно сузить причину."
  ])
    assert.ok(pendingQuestion(text), text)
})

test("an open question stated without a question mark is reported", () => {
  for (const text of [
    "Проверки прошли.\n\nОткрытыми остаются три вопроса из ревью.\n\nКоммит делайте через `/commit`.",
    "Вопрос открыт: таймер или проверка в фильтре.\n\nПосле ответа доделаю.",
    "Разобрался.\n\nВарианты:\n\n1) блокировать\n2) подсказка",
    "Тест падает из-за кэша.\n\nМожно сбрасывать кэш или убрать его совсем.",
    "Как скажете „ок“ по каждой, прогоню ревью и закоммичу.",
    "Жду вашего «ок».",
    "Напишите, когда проверите.",
    "Дайте знать, если нужен другой текст.",
    "Подтвердите, и я запушу.",
    "Если согласны — сделаю так же в остальных хуках.",
    "Могу также покрыть тестами адаптер, если хотите.",
    "Если нужно — могу разнести на два коммита.",
    "Let me know if the wording works.",
    "Should I push it now.",
    "Want me to add the adapter test as well."
  ])
    assert.ok(pendingQuestion(text), text)
})

test("reports, code, quotes and headings are not questions", () => {
  for (const text of [
    "Готово.",
    "Сделано:\n\n- хук\n- тест",
    "Почему падало? Кэш не сбрасывался.\n\nПочинил.",
    "Условие x ? y : z осталось.",
    "Регэксп готов:\n\n```js\nconst re = /a?/;\n```",
    "Добавил `a?.b ?? c?`",
    "Пользователь спросил:\n\n> а тесты зелёные?",
    "Поле стало необязательным: `foo?: string`",
    "Деплой тут: https://x/y?z=1",
    "## Что сломалось?\nКэш не сбрасывался.\n\n## Итог\nПочинил, тесты зелёные.",
    "Текст ошибки обновлён.\n\nЕсли бэкенд ответит иначе, поправим текст.",
    "Установка идёт; если появится запрос UAC — подтвердите его.",
    "Открытых вопросов нет.",
    "Открытый вопрос из плана закрылся: файл читается.",
    "Остался вопрос к Dockerfile: он не менялся.",
    "Открытый вопрос: кэш.\n\nРазобрался: кэш не сбрасывался.\n\nПочинил.",
    "Можно было сбрасывать кэш или убрать его, убрал.",
    "Хук теперь ловит «Дайте знать» и «Жду вашего ок»."
  ])
    assert.equal(pendingQuestion(text), null, text)
})

test("the last turn stops at the last user message", () => {
  const { human, text, menu, tools } = lastTurn([
    user("msg_1", "a"),
    say("Старый вопрос?"),
    user("msg_2", "b"),
    say("Готово."),
    tool("read")
  ])
  assert.equal(human, "msg_2")
  assert.equal(text, "Готово.")
  assert.equal(menu, false)
  assert.equal(tools, true)
})

test("a text question after the turn resumes the session once", async () => {
  const { context, notices } = fixture(turn("Починил.\n\nКоммитить сейчас?"))
  const guard = await registerQuestionGuard(context)

  assert.ok(await guard.check("ses_1", { parentID: undefined }))

  assert.equal(notices.length, 1)
  assert.equal(notices[0].sessionID, "ses_1")
  assert.ok(notices[0].text.startsWith(REASON))
  assert.ok(notices[0].text.includes("«Коммитить сейчас?»"))
})

test("one notice per user turn even when the resume ends with a question again", async () => {
  const messages = turn("Починил.\n\nКоммитить сейчас?")
  const { context, notices } = fixture(messages)
  const guard = await registerQuestionGuard(context)

  assert.ok(await guard.check("ses_1"))
  messages.push(say("Всё ещё жду ответа — коммитить?"))
  assert.equal(await guard.check("ses_1"), null)

  assert.equal(notices.length, 1)
})

test("a new user turn is guarded again", async () => {
  const messages = turn("Починил.\n\nКоммитить сейчас?")
  const { context, notices } = fixture(messages)
  const guard = await registerQuestionGuard(context)

  assert.ok(await guard.check("ses_1"))
  messages.push(user("msg_2", "коммить"), say("Закоммитил.\n\nПушить?"))
  assert.ok(await guard.check("ses_1"))

  assert.equal(notices.length, 2)
})

test("a turn that asked through the menu is not reported", async () => {
  const { context, notices } = fixture([
    user("msg_1", "x"),
    tool("question"),
    say("Беру первый. Всё верно?")
  ])
  const guard = await registerQuestionGuard(context)

  assert.equal(await guard.check("ses_1"), null)
  assert.equal(notices.length, 0)
})

test("a subagent session is not reported", async () => {
  const { context, notices } = fixture(turn("Сделал.\n\nПродолжать?"))
  const guard = await registerQuestionGuard(context)

  assert.equal(await guard.check("ses_1", { id: "ses_1", parentID: "ses_parent" }), null)
  assert.equal(notices.length, 0)
})

test("a one-line greeting on the first turn is not reported", async () => {
  const { context, notices } = fixture(turn("Привет! Чем могу помочь в web_groza?"))
  const guard = await registerQuestionGuard(context)

  assert.equal(await guard.check("ses_1"), null)
  assert.equal(notices.length, 0)
})

test("a one-line question after a tool in the first turn is reported", async () => {
  const { context, notices } = fixture([
    user("msg_1", "x"),
    tool("shell"),
    say("Ветка чистая. Что делаем?")
  ])
  const guard = await registerQuestionGuard(context)

  assert.ok(await guard.check("ses_1"))
  assert.equal(notices.length, 1)
})
