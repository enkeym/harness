# Working rules

- Reply in Russian; briefly state the next action before commands or edits.
- Before coding, load project rules and inspect package scripts, types and configs. Search for the operation in the module, shared code and installed packages; read the closest implementation and its callers before writing. Reuse or extend it; a second use of the same logic requires one shared implementation with both callers updated, respecting module boundaries. No speculative abstractions.
- Never add or rewrite code comments or documentation comments (including JSDoc, TODOs and suppression directives); project permission or neighbouring examples do not lift this ban. Explain in chat or external docs; preserve unrelated existing comments. Only an explicit user request can lift this ban.
- Reuse existing constants, enums, config and UI tokens. Environment-dependent values belong in the project's config layer; do not hide hardcoded values behind new local constants.
- Use precise types or unknown with narrowing, never TypeScript any. Use DTOs for service inputs and interfaces for responses.
- Follow tokensave-routing for indexed search/read and shell fallbacks. Edit with apply_patch.
- Discover only needed MCP schemas; never dump the catalog or repeated server descriptions. Load each relevant skill/rule once per session.
- Batch independent reads/searches. Reuse passing checks until inputs change; poll jobs at sensible intervals. For noisy commands use bash ~/.ai-hooks/bin/brief-output.sh <command> [args...], then inspect error excerpts. Keep review evidence complete; never wrap interactive commands.
- Keep notes as paths, decisions and next actions; logs in files. Compact current state without accumulated snapshots. No subagents unless requested.
- Reload rules/skills and schemas only after changes or compaction. For `harness-context`, see ~/.config/harness/repo/docs/context-automation.md; a persistent digest alone does not prove content is still held.
- Complete authorized edits, local commands, tests and commits without confirmation. Infer routine choices; ask for information only when progress is blocked. Preserve unrelated user changes.
- Ask before push, publication, deployment, data deletion, irreversible Git operations and changes to secrets. Explicit user authorization covers the named operation within the requested scope; do not ask again. Routine edits and local checks need no confirmation.
- Review the diff for duplicated logic, hardcoded values, added comments and unused scaffolding; fix these before handoff. Report reuse evidence briefly (searched scope → reused symbol, or why new code was needed) and run focused checks. Full suites and coverage only when project rules or impact require them.

## Browser and internet requests

- For requests to search the internet, open a website, or inspect an account/dashboard (including Cloudflare DNS), use the connected Playwright MCP first. Discover its tools directly; do not search plugins or project indexes to find a browser, domain or account already visible in tabs. Follow any explicitly requested source/tool instead.
- Start with browser_tabs list, select the matching tab by its current title/URL, then take browser_snapshot. If no tab matches, navigate to the supplied URL or search the web in a new tab. Do not navigate away from an unrelated user tab. Ask only when account/zone selection remains ambiguous after inspection.
- After navigation or switching tabs, use a fresh snapshot and its refs. On a stale-ref error, refresh the snapshot before retrying; do not guess refs or reuse refs from another tab. Distinguish the extension welcome page from the target website.
- Listing/selecting tabs, browsing, searching and reading requested pages need no conversational confirmation. Reuse authorization for the requested task; sensitive actions still follow the confirmation rule above. If Playwright is unavailable, state the limitation and use an available search tool for public information; do not infer private account settings from project logs.

## Skills

Load the relevant SKILL.md once before its workflow. Match the user's intent, including ordinary Russian requests; a slash command is not required. Explicitly requested workflows stay within that request's scope.

- Harness installation, missing skills, MCP or index health: doctor; hook refusals, trust and sandbox diagnosis: hooks-guards; context and tool overhead: optimize.
- Code navigation: tokensave-routing; large or ambiguous implementation/design: task-brief; skills and AGENTS.md: skill-authoring.
- Server: nestjs-backend; UI: react-frontend; Next.js: also nextjs-app; Python: python.
- Review requests: review; code quality and impact checks: review-standards; security audits: review-security. Load both checks before every commit.
- Tests: test-conventions; requested coverage analysis: also test-coverage; explicitly requested browser QA: test-browser.
- Git branches, commits and MR/Jira text: git-flow; explicit commit-and-push workflow: commit (its push still requires authorization).
- Requested creation or seeding of the implicit-links map: impact-map. During implementation/review, use existing docs/links through shared/impact-map.md when assessing affected contracts; seeding is a separate requested workflow.
- Russian website copy: copywriting; requested SEO audit/setup: seo; requested transfer to another session: handoff.

Skills are instructions, not hook handlers. shared/ contains references, not a separate skill. SessionStart/Stop maintain existing RAG indexes; helpers under ai-hooks/bin run only when the selected workflow needs them. Check hook trust through /hooks; file presence or a successful manual handler run does not prove lifecycle execution.
