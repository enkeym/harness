# Commands (`claude/commands/*.md`)

A different mechanism from a skill, not a smaller version of one: no `name`
field (the filename is the command), no `disable-model-invocation` (a command
is never model-invoked to begin with), always user-invoked as `/<filename>`.

## Frontmatter

- `description` (third person, what running it does), tight `allowed-tools`;
  `argument-hint` when it takes arguments.

## Body

- The steps it runs, in order; a leading `` !`command` `` line when it needs
  live state before the rest makes sense.
- Same tone rules as a skill body (see `SKILL.md`) — imperative, no narration,
  no rationale paragraphs.
- Never claim a skill-only field (`disable-model-invocation`, `user-invocable`)
  for a command file — it doesn't have one.

## OpenCode (`opencode/command/*.md`)

- Skills are not slash commands in OpenCode; a skill the user runs by name
  needs a thin command here: frontmatter `description` only, body "Load the
  `<skill>` skill and follow it" plus `$ARGUMENTS`. No logic copied from the skill.
