# Working rules

- Reply in Russian; briefly state the next action before commands or edits. Preserve unrelated user changes.
- Before coding, load project rules and inspect scripts, types and configs. Search the module, shared code and installed packages; read the closest implementation and callers. Reuse or extend it; a second use requires one shared implementation and updated callers within module boundaries. No speculative abstractions.
- Never add or rewrite code/documentation comments, including JSDoc, TODOs and suppression directives, unless explicitly requested by the user; project permission and examples do not lift this ban. Preserve unrelated comments; explain in chat or external docs.
- Reuse constants, enums, config and UI tokens; environment-dependent values belong in the config layer, not new local constants. Use precise types or narrowed unknown, never TypeScript any; DTOs for service inputs, interfaces for responses.
- Follow tokensave-routing for indexed search/read and shell fallbacks. Before judging code, check index freshness (tokensave_status, stale_commits); Stop sync can lag one commit.
- Discover only needed MCP schemas; for deferred tools, run tool_search select:<name> before the first tool_call and review its schema. Reuse schemas; never dump catalogs or repeated server descriptions.
- Read the intended target immediately before editing; use apply_patch and never edit the same file concurrently. After every write, re-read changes, validate JSON where applicable and explicitly report verification.
- Batch independent reads/searches; reuse passing checks until inputs change and poll sensibly. For noisy commands use bash ~/.ai-hooks/bin/brief-output.sh <command> [args...], inspect errors and retain complete review evidence; never wrap interactive commands.
- Keep notes as paths, decisions and next actions; logs in files. Compact current state without accumulated snapshots. No subagents unless requested.
- Load each relevant rule/skill once; reload rules, skills and schemas only after changes or compaction. For harness-context see ~/.config/harness/repo/docs/context-automation.md; a persistent digest alone does not prove retained content.
- Complete authorized edits, local commands, tests and commits autonomously; infer routine choices and ask for information only when blocked.
- Ask before push, publication, deployment, data deletion, irreversible Git operations and secret changes. Reuse explicit authorization within its named scope; routine edits and local checks need no confirmation.
- Secrets never enter Git: ignore their file or store values in ~/.config/harness/env and reference them by name.
- Before handoff, fix duplicated logic, hardcoded values, added comments and unused scaffolding in the diff. Briefly report reuse evidence (searched scope → reused symbol, or why new code was needed); run focused checks, full suites/coverage only when project rules or impact require them.

## Browser and internet
- Use connected Playwright MCP first for internet searches, websites and account/dashboard inspection, including Cloudflare DNS; follow an explicitly requested source/tool instead. Discover browser tools directly, not through plugins or project indexes.
- Start with browser_tabs list, select by current title/URL and take browser_snapshot. If unmatched, open the supplied URL or search in a new tab; preserve unrelated tabs. Ask only if account/zone remains ambiguous after inspection.
- After navigation/tab changes, use fresh snapshots and refs; refresh stale refs before retrying, never guess or reuse another tab's refs. Distinguish extension welcome from target. Reading/searching needs no confirmation; sensitive actions follow the rule above. If Playwright is unavailable, state that and use public search; never infer private settings from project logs.

## Skills and hooks
Read the relevant SKILL.md before its workflow, matching intent including ordinary Russian requests; no slash command is required. Keep explicitly requested workflows within scope.
- Harness installation/skills/MCP/index health: doctor; hook refusals/trust/sandbox: hooks-guards; context/tool overhead: optimize; navigation: tokensave-routing; large/ambiguous implementation/design: task-brief; skills/AGENTS.md: skill-authoring.
- Server: nestjs-backend; UI: react-frontend; Next.js: also nextjs-app; Python: python. Reviews: review; quality/impact: review-standards; security: review-security; load both review checks before every commit.
- Tests: test-conventions; requested coverage: also test-coverage; explicitly requested browser QA: test-browser. Branches/commits/MR/Jira: git-flow; explicit commit-and-push: commit (push still needs authorization).
- Requested implicit-links map creation/seeding: impact-map; implementation/review uses existing docs/links through shared/impact-map.md for affected contracts, without seeding. Russian website copy: copywriting; requested SEO: seo; session transfer: handoff.
- After skill renames/deletions, run find ~/.qwen/skills -maxdepth 1 -xtype l; install.sh --check misses this mirror and Qwen silently ignores broken links.
Skills are instructions, not hook handlers; shared/ holds references. SessionStart/Stop maintain existing RAG indexes; run ai-hooks/bin helpers only as needed by the workflow. Check trust through /hooks: file presence or successful manual execution does not prove lifecycle execution.
