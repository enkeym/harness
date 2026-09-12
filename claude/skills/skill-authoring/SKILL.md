---
name: skill-authoring
description: Format and style rules for this harness's own instruction files — SKILL.md frontmatter and body, claude/commands/*.md command files, and CLAUDE.md's own wording and its Skills section. Load before creating, editing or reviewing any skill, command file or CLAUDE.md, when the user says "создай скилл", "проверь скиллы", "проверь CLAUDE.md", "проверь правила", or when a skill's description fails to trigger it.
---

# Skill authoring

A skill is a reference card, not an article: the reader is Claude, who already
knows the domain. Every line is a rule it would otherwise get wrong or a fact it
cannot derive; anything else is deleted. CLAUDE.md decides when a skill is
loaded — this skill decides how one is written.

## Placement

- Global: `~/harness/claude/skills/<name>/SKILL.md` — `~/.claude/skills` is a
  symlink, write the harness path. Project: `<project>/.claude/skills/<name>/SKILL.md`.
- One area per skill. `Grep` the existing descriptions first: an overlap is
  extended, not duplicated.
- Extra files only when the body would pass ~150 lines: `reference/<topic>.md`,
  linked from SKILL.md, one level deep, with a contents list when longer than
  100 lines. No README, CHANGELOG or install notes inside a skill.

## Frontmatter

- `name` = directory name: lowercase letters, digits, hyphens; ≤64 chars; no
  "claude"/"anthropic". Noun phrase in the collection's form (`git-flow`,
  `review-security`, `nestjs-backend`); never `helper`, `utils`, `misc`.
- `description`: third person, ≤1024 chars, no XML. It is loaded into every
  session, so every word pays. Sentence 1: what the skill covers, with the
  terms Claude would match on. Sentence 2: `Load before/when …` with concrete
  triggers — task verbs, file kinds, the user's own phrases quoted verbatim.
  Never "helps with", "I can", "you can use".
- Command skill (`/name`): add `disable-model-invocation: true`,
  `allowed-tools` limited to the commands it runs, `argument-hint`; end the
  description with `User-invoked as /name.`
- No other field unless it changes behaviour (`user-invocable: false`,
  `context: fork`, `model`, `paths`).

## Body

- English only. Russian appears only as a literal output block the user copies
  (a template) or as a quoted user phrase that triggers the skill.
- `# <Subject>`, or `# /name` for a command. Then one or two lines: the rule
  that governs everything below, and the boundary with CLAUDE.md or a
  neighbouring skill ("Global rules are in CLAUDE.md", "Rest is in `testing-ts`").
- `##` per task or category, bullets inside. Fixed order → numbered list.
  Any order → bullets. Lookup → table.
- Directives in the imperative: "Mock the boundary, not the hook". Not "you
  should", not "you are an expert who", no narration of how a step is done.
- One "why" clause, only where the rule is counter-intuitive or high-stakes:
  "No `Co-Authored-By` — company policy". No paragraphs of rationale.
- Concrete over abstract: a command, a path, an identifier, an input → output
  pair. What Claude already knows (what a DTO is, how a library works) and
  what CLAUDE.md already states is not repeated.
- One term per concept, the project's own name for it.
- Output with a fixed shape gets a fenced template with placeholders and the
  rule for empty parts ("Empty section = нет").
- No time-bound facts, no version dates, no retired paths. Forward slashes.
  MCP tools by full name (`mcp__tokensave__tokensave_search`).
- Emphasis: bold once per section at most; no caps-shouting ("ALWAYS",
  "NEVER") — the directive plus its reason does the work.
- Length: 25–130 lines covers a single-area skill; a meta-skill spanning
  several artifact types runs longer. Hard ceiling 500 — longer → split
  into `reference/`.

## Commands (`claude/commands/*.md`)

A different mechanism from a skill, not a smaller version of one: no `name`
field (the filename is the command), no `disable-model-invocation` (a command
is never model-invoked to begin with), always user-invoked as `/<filename>`.

- Frontmatter: `description` (third person, what running it does), tight
  `allowed-tools`; `argument-hint` when it takes arguments.
- Body: the steps it runs, in order; a leading `` !`command` `` line when it
  needs live state before the rest makes sense. Same tone rules as a skill
  body — imperative, no narration, no rationale paragraphs.
- Never claim a skill-only field (`disable-model-invocation`, `user-invocable`)
  for a command file — it doesn't have one.

## CLAUDE.md

Not a SKILL.md: no frontmatter, no `name`/`description` limits, always loaded.
Its own rule (top of the file) is the scope test: a behaviour gate or routing
rule stays; anything else belongs in a skill. Checklist for an edit or an
audit:

- [ ] every skill directory has a Skills-table row or sits in the user-invoked
      line — and every table/line entry names a directory that exists
- [ ] no field or mechanism attributed to a file that doesn't carry it (a
      command wrongly called a skill, or vice versa)
- [ ] a rule stated once; a skill restating it is either deleted from the skill
      or is a deliberate "must not wait for a skill" gate, named as such
- [ ] every bullet is a directive, not narration; nothing Claude already knows
- [ ] paths, tool names, skill names current — no retired reference
- [ ] English core; Russian only as a quoted user trigger phrase

Report the same way as the skill checklist: `CLAUDE.md:<line> — <rule broken>
— <fix>`, fixed in place unless ask mode is on.

## Procedure — new skill

1. Name the failure the skill prevents. No observed failure → no skill; check
   whether CLAUDE.md or memory already covers it.
2. `Grep` the existing descriptions for the area. Overlap → edit that skill.
3. Write the description first; test it against the trigger: would this
   sentence be picked out of thirty others?
4. Body from the template below; run the checklist.
5. Auto-loaded skill → add its row to the **Skills** table in
   `~/harness/claude/CLAUDE.md`. Command → add it to the user-invoked line there.
6. Commit in `~/harness`: `feat(skills): <what the skill adds>`.

## Checklist

Run on every new or edited SKILL.md; on the whole collection when asked to audit.

- [ ] `name` = directory, valid characters, collection's naming form
- [ ] description: third person, what + when, trigger terms, ≤1024 chars
- [ ] command skill: `disable-model-invocation`, `allowed-tools`, `argument-hint`
- [ ] body English; Russian only in output templates and quoted user phrases
- [ ] opening line states the governing rule; boundary with CLAUDE.md or a
      neighbour named
- [ ] every bullet is a directive; no narration, no "you are", no preamble
- [ ] nothing Claude already knows; nothing already in CLAUDE.md
- [ ] paths and commands current; no retired location
- [ ] one term per concept; no caps-shouting; bold sparingly
- [ ] references one level deep; body sized to its scope (≤130 for one area)
- [ ] CLAUDE.md skills table or user-invoked line updated

Report as `<skill>: <line> — <rule broken> — <fix>`, one line each; fix in
place unless ask mode is on. Clean skill → `<skill>: ok`.

## Template

````markdown
---
name: <name>
description: <What it covers — key terms>. Load before <task> or when <trigger>.
---

# <Subject>

<Governing rule in one line.> <Boundary: what lives in CLAUDE.md or `<skill>`.>

## <Task or category>

- <Directive.>
- <Directive — reason only if counter-intuitive.>

## <Procedure>

1. <Step with the exact command or tool.>
2. <Step.>

## Output

```
<fixed shape with placeholders>
```
````
