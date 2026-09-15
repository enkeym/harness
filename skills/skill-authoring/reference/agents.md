# OpenCode agent files

`opencode/agent/<name>.md`, symlinked as `~/.config/opencode/agent`. The file
name is the agent name. Body rules are the skill rules: English, imperative,
Russian only in output templates and quoted user phrases.

## Frontmatter

- `description`: third person, what it does + when it runs, ≤1024 chars. A
  subagent the user calls by mention ends with
  `Invoked by the user as @<name>; never self-triggered.` Quote it when it
  contains `: `.
- `mode`: `primary` (Tab-switchable), `subagent` (`@name`, `task`), `all`.
- `model` only when the agent is pinned: `<provider>/<model>` exactly as
  `opencode models` prints it.
- `permission` instead of the retired `tools` map. Last matching rule wins:
  `"*"` first, narrow patterns after, denies of dangerous forms last.
- Chat-only agent: `edit: deny`, `task: deny`, tokensave write tools
  (`tokensave_tokensave_str_replace`, `_multi_str_replace`, `_replace_symbol`,
  `_insert_at`, `_insert_at_symbol`) denied, `bash` `"*": deny` plus read-only
  git.
- No `prompt:` key — the body is the prompt. Allowed keys: `name, model,
  variant, description, mode, hidden, color, steps, options, permission,
  disable, temperature, top_p`; anything else is silently routed into `options`.

## Body

- `# <Name>` or `# @<name>`, then the governing rule and the boundary with the
  skill it defers to (`git-flow`, a stack skill) — a pointer, never a restatement.
- A bash step names one command per call: `$(…)` and `;` chains are matched part
  by part, and an unmatched part is refused in a non-interactive run.
- Fixed reply shape → fenced template with placeholders.

## Verify

1. `opencode debug agent <name>` — model, mode and the resolved permission list.
2. `opencode run "@<name> …"` in a scratch repository for a subagent,
   `opencode run --agent <name> …` for a primary one.
3. Tell the user to restart OpenCode: config is read once at startup.
