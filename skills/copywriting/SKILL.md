---
name: copywriting
description: "Russian web copy a site visitor reads — landing sections, cards, articles, title and meta description, CTA, microcopy — for a named audience and query list. Load before writing or rewriting such text or fixing an seo content finding; not for code comments, docs, commit or MR text."
---

# Copywriting

A reader decides in seconds whether the page answers their question; write for
that reader, the search engine follows. Technical SEO and where text lives in
markup are `seo`; strings go where the project keeps them (i18n or constants,
`react-frontend`).

## Brief before writing

Collect, ask once for what is missing (one question tool call, ≤3 questions):

| Item | Without it |
| --- | --- |
| Page and its goal (buy, leave a request, read, sign up) | ask — no default |
| Audience: who, what they already know, the objection that stops them | infer from the product, state it under `Допущения` |
| Queries: primary + 3–10 secondary, from Wordstat / Search Console | write for intent only, mark `запросы не даны` |
| Facts: prices, terms, guarantees, numbers, cases | never invent — leave `[уточнить: …]` |
| Tone: existing pages of the site | match the neighbours |
| Length limits: design blocks, character counts | take them from the layout in code |

## Structure

- First screen: what it is, for whom, the main benefit, one CTA. The primary
  query or its natural form in the H1.
- One section — one question the reader has, in the order they have them:
  what → why this → how it works → price/terms → proof → objections → action.
- H2s say the content of the section ("Сколько стоит доставка"), not a label
  ("Преимущества").
- Informational page: the direct answer in the first 2–3 sentences, details after.
- Lists for parameters and steps, tables for comparisons, paragraphs ≤4 lines.

## Language

- Concrete over general: "доставка за 2 часа по Москве", not "быстрая доставка".
  A claim without a number, fact or example is cut or backed.
- Benefit in the reader's terms, then the feature that delivers it.
- Active verbs, "вы"-address the way the site already does (with or without
  capital), no bureaucratese: "осуществляем", "производим", "является",
  "данный", "в рамках", "широкий ассортимент", "индивидуальный подход",
  "команда профессионалов", "качественно и в срок".
- No filler intros ("В современном мире…"), no rhetorical questions in a row,
  no exclamation marks in body copy.
- Russian typography: «ёлочки», em dash with spaces ( — ), non-breaking space
  after short prepositions and between number and unit (`10 000 ₽`, `5 кг`).
- CTA says the result: "Рассчитать стоимость", not "Отправить".

## Queries in text

- Primary query: H1, first paragraph, `title`, once or twice more in body in
  natural forms — cases, word order, synonyms. Exact-match repetition beyond
  that is a finding, not an optimisation.
- Secondary queries become H2s or answers inside sections; a query that needs
  its own section to answer it → maybe its own page, say so.
- Word forms the reader types (city names, colloquial names of the product)
  appear as the reader writes them.
- Never hidden text, lists of cities or queries at the bottom, text written
  for density.

## Meta

- `title` ≈ 50–60 characters: primary query first, differentiator, brand last.
- `description` ≈ 120–160 characters: the offer plus a concrete reason to click
  (price from, term, guarantee); unique per page.
- Template pages (cards, cities): template with real variable data, not the
  same sentence with a swapped name.

## Microcopy

- Button = verb + object. Error = what happened + what to do
  ("Карта отклонена банком. Попробуйте другую карту"). Empty state = why empty +
  the next action.
- Same term for the same thing across the whole interface.

## Output

```
Страница: <URL или экран> — цель: <…> — аудитория: <…>
Запросы: <основной>; <дополнительные | запросы не даны>

title: <…> (<n> символов)
description: <…> (<n> символов)

<текст по блокам: H1, H2, абзацы, списки, CTA — в порядке вёрстки>

Допущения: <что додумано и почему | нет>
Уточнить: <факты в [уточнить: …] | нет>
```

Edits to existing copy: the changed block only, before → after, one line why.
Empty section = `нет`.
