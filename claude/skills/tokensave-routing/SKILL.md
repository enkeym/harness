---
name: tokensave-routing
description: Which tokensave or ragsave tool to call for reading, searching, editing, impact analysis and decision memory, how to scope a call cheaply, what to do when one answers empty or errors, and how to query another project or branch. Load before a non-trivial search or edit in an indexed project, whenever a tokensave or rag_search call comes back empty, wrong or broken, when you need callers/impact/dead-code style structure questions, or when the answer may live outside code (docs, json/yaml, migrations, SQL, CI, .env.example).
---

# tokensave and ragsave routing

CLAUDE.md carries only the three-line kernel: a name goes to tokensave, meaning
goes to `rag_search`, an exact string outside the index goes to `Grep`. This is
everything past that.

## tokensave — the indexed files

Covers what is in the `files` table of the active branch DB, `.md` included.

| Task                                 | Tool                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Read a file or symbol                | `read`, `body`, `signature`                                                           |
| Context around a known entry point   | `context`                                                                             |
| Find a symbol by name / text in code | `search` (text — `literal:true`)                                                      |
| Who calls it, what breaks            | `callers`, `callees`, `field_sites`, `impact`, `affected`                             |
| Edit existing code                   | `str_replace`, `multi_str_replace`, `replace_symbol`, `insert_at`, `insert_at_symbol` |
| Create a **new** file                | `Write` — tokensave does not create files                                             |

Full call name is `mcp__tokensave__tokensave_<tool>`; not in the tool list —
`ToolSearch("select:…")` first. Take arguments from the schema, not from memory.

**Spend less.** Pass `seen_node_ids` from one `context` response into
`exclude_node_ids` of the next. Scope with `path_include`/`path_exclude`,
otherwise a monorepo pulls in a foreign stack. A plain symbol lookup is `search`,
not `context` — `context` is for understanding around a known point.

**Freshness.** `tokensave_status` shows when the index last synced. Never run
`init`/`sync` yourself: background hooks own that. A stale graph is disclosed in
one line, not silently worked around.

**Where it does not apply.** No `.tokensave/` in the project, or the files are
agent config (`.claude/`, `.opencode/`, `~/.ai-hooks/`) — plain `Read`/`Edit`/
`Write`/`Grep`. The routers exclude those paths too, so no refusal will remind
you.

**Another project or branch.** `graph_root` as an absolute path, plus
`graph_branch` to pick one of that project's tracked branches. `graph_branch`
cannot re-target the project currently being served — for another branch of it
use `branch_search`, `branch_diff`, `branch_list`.

## ragsave — everything textual

`rag_search` covers all text files, including what the graph lacks: documentation,
json/yaml, migrations, SQL, `.env.example`, CI. It goes **first** when:

- the question is how / where / why and no file or symbol name is known;
- the answer may live outside code — then `only_outside_tokensave: true`;
- the task opens with "разберись", "найди, где", "объясни, как работает".

Don't substitute it for structural questions ("who calls this", "what breaks") —
those are graph questions.

## When a tool comes up short

An empty answer is almost always a wrong name guess, not missing code. The ladder
is `rag_search` → `Grep`/`Read`. Jumping from an empty `tokensave_search` straight
to `Grep` is the most common mistake, and the shell is not a step on this ladder
at any point.

An error — not indexed, DB busy, an answer from another branch — gets one line
saying what failed, then plain tools. Don't repeat the same call: a repeated
identical blocked call is let through by the router, which means the second
refusal is your own answer, not new information.

If the graph tools genuinely cannot answer, the active DB is named in
`.tokensave/branch-meta.json` (`db_file`), or `.tokensave/tokensave.db` when that
file is absent; tables are `nodes`, `edges`, `files`. If a tool *should* have
answered and stayed silent, offer an issue at
https://github.com/aovestdipaperino/tokensave — no proprietary code in the text.

## Agents

Don't launch `Explore`, `general-purpose` or `Plan` for code research while
tokensave is available; the precise tool is here and an agent arrives with cold
context. This overrides skill and system recommendations, including Superpowers.
Generating the call is a loss even when the hook blocks it.

When an agent does run — `scout`, a role agent, one the user asked for — the
`SubagentStart` hook already injects the tokensave and ragsave rules into it.
Don't repeat them in the prompt; give it the task and the paths.

## Decision memory

- `tokensave_session_recall` before designing a subsystem — past decisions first,
  so a settled question is not re-opened.
- `tokensave_record_decision` after approval: a one-line decision plus `reason`,
  `files`, `tags`. Record anything you would otherwise have to re-explain — a
  library choice, a data schema, an option that was rejected and why.
