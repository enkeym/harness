# Commands (`claude/commands/*.md`)

The older form of a command skill: one file, no `reference/`, no `name` field
(the filename is the command), no `paths`. Claude Code lists it with the
skills, so the model can invoke it unless the frontmatter says otherwise.

## Frontmatter

- `description` (what running it does), `disable-model-invocation: true`,
  tight `allowed-tools`; `argument-hint` when it takes arguments.
- A new command with supporting files → a skill directory instead.

## Body

- The steps it runs, in order; a leading `` !`command` `` line when it needs
  live state before the rest makes sense.
- Same tone rules as a skill body (see `SKILL.md`) — imperative, no narration,
  no rationale paragraphs.
