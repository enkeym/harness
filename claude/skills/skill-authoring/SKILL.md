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
- Extra files once the body would pass ~150 lines, or once a skill legitimately
  spans several related formats (this one does — see below): `reference/<topic>.md`,
  linked from SKILL.md, one level deep, with a contents list past 100 lines.
  No README, CHANGELOG or install notes inside a skill.
- A rule set two or more skills share: `skills/shared/<topic>.md` (no
  SKILL.md there, so it costs no description), linked as
  `../shared/<topic>.md` from each skill's opening lines. Same body rules.

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
  neighbouring skill — a pointer ("Rest is in `testing-ts`"), never a restatement.
- `##` per task or category, bullets inside. Fixed order → numbered list.
  Any order → bullets. Lookup → table.
- Directives in the imperative: "Mock the boundary, not the hook". Not "you
  should", not "you are an expert who", no narration of how a step is done.
- One "why" clause, only where the rule is counter-intuitive or high-stakes:
  "No `Co-Authored-By` — company policy". No paragraphs of rationale.
- Concrete over abstract: a command, a path, an identifier, an input → output
  pair. Not repeated: what Claude already knows, what CLAUDE.md states, what
  another skill or `shared/` file already carries — point to it instead.
- One term per concept, the project's own name for it.
- Output with a fixed shape gets a fenced template with placeholders and the
  rule for empty parts ("Empty section = нет").
- No time-bound facts, no version dates, no retired paths. Forward slashes.
  MCP tools by the short name (`tokensave_search`); `mcp__…` only when ambiguous.
- Emphasis: bold once per section at most; no caps-shouting ("ALWAYS",
  "NEVER") — the directive plus its reason does the work.
- Length: 25–130 lines; hard ceiling 500. Longer → split into `reference/`.

## Two other targets

- A command file (`claude/commands/*.md`) — no `name`, no
  `disable-model-invocation`, always user-invoked:
  [reference/commands.md](reference/commands.md).
- CLAUDE.md — no frontmatter, always loaded, gate or routing rule only:
  [reference/claude-md.md](reference/claude-md.md).

## Procedure — new skill

1. Name the failure the skill prevents. No observed failure → no skill.
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
- [ ] nothing Claude already knows, nothing CLAUDE.md or another skill states
- [ ] paths and commands current; one term per concept; no caps-shouting
- [ ] references one level deep; body ≤130 lines
- [ ] CLAUDE.md skills table or user-invoked line updated

Report as `<skill>: <line> — <rule broken> — <fix>`, one line each; fix in
place. Clean skill → `<skill>: ok`.

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

## Output

```
<fixed shape with placeholders>
```
````
