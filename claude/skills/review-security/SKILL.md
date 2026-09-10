---
name: review-security
description: Security checklist for a diff or module and the procedure to run it — leaked secrets and credentials (in code, tests, fixtures, untracked files about to be staged), env and config handling, input validation and mass assignment, auth and ownership checks, injection (SQL/ORM, shell, path, HTML, regex), SSRF and outbound calls, webhooks and payments (Telegram bots, YooKassa), sensitive data in logs and responses, client bundle exposure, dependencies, docker and CI. Load on the diff before every commit, and whenever asked to check security or audit a module. Complements the security-guard hook, which sees commands, not code.
---

# Security review

Two layers, both required. The `security-guard` hook judges the **form** of a
command and has already run. This skill judges the **meaning** of the code: an
unguarded route, a body spread into an entity, a token in a fixture — nothing a
hook can see. A finding is something exploitable or something that leaks; "not
best practice" without a scenario is *Info*, one line, and does not block.

## Procedure

1. **Scope.** Uncommitted work: `git diff HEAD` **and** `git status --short` —
   `/commit` stages with `git add -A`, so an untracked `.env`, dump, key, export
   or `*.pem` is the most likely leak, and it is not in the diff. A branch:
   `git diff <base>...HEAD` plus `git log --stat <base>..HEAD` for files added
   earlier in the branch.
2. **Secrets pass, always.** Grep the diff and the new files for: long
   high-entropy strings, `-----BEGIN`, `AKIA`, `sk_`, `ghp_`, `xox`, `eyJ` (JWT),
   `password|secret|token|api[_-]?key|private[_-]?key` next to a literal, URLs
   with `user:pass@`, hosts and ports of real infrastructure, real-looking
   emails and phone numbers in fixtures. `tokensave_unsafe_patterns` first when
   the index is up. Any hit → stop, tell the user in one line. A secret already
   in an earlier commit of the branch needs **rotation**, not deletion — git
   history keeps it; say so explicitly.
3. **Checklist by what the diff touches.** Go through the categories below that
   apply; name in the report which were checked and clean. For each touched
   symbol look at its callers (`tokensave_callers`) — the vulnerable path is
   often the caller, not the diff.
4. **Go deeper where the stakes are.** The diff touches auth, sessions,
   payments, secrets or config, file upload, outbound HTTP, docker or CI →
   don't stop at the diff: read the whole handler or module end to end, walk
   every caller, and write down the attack scenario you tried for each item
   before calling it clean. A renamed DTO gets the checklist; money and access
   get the adversary's pass. There is no second reviewer — you are it.
5. **Critical blocks the commit.** Fix it first. *Important* is fixed when it
   is inside the diff, reported when it is not. *Info* is a line in the report.

## Checklist

### Secrets and configuration

- No literal secret in code, tests, fixtures, seeds, logs, error messages,
  docker layers, CI output, or comments. A "test" key that is a real key is a
  real key.
- Configuration only through the project's config layer, validated at
  startup; a new variable lands in `.env.example` with a comment and no value.
- `.env*`, dumps, keys, `*.pem`, local databases are in `.gitignore`; check
  when a new kind of file appears.
- Tokens never in URLs, query strings, or the client bundle (`NEXT_PUBLIC_` and
  its equivalents mean *public*). Sensitive cookies `httpOnly`, `secure`,
  `sameSite`, the way the project already sets them.

### Input

- Every external input is validated at the boundary in the project's way (DTO
  with `whitelist` + `forbidNonWhitelisted`, schema on the client); numbers and
  ids parsed, enums checked, string lengths and array sizes bounded.
- No mass assignment: a request body is never spread into an entity or an
  update; fields are picked.
- Files: type and size checked server-side, name sanitised, stored outside the
  web root, never executed or included.

### Auth and access

- Every non-public route has a guard; "public" is deliberate and named, not
  the default of a forgotten decorator.
- Ownership, not just login: the resource is fetched by `id` **and** owner, or
  the check is explicit. Admin and role checks come from config or the DB,
  never from a string compared in code.
- NestJS: `ValidationPipe({ whitelist, forbidNonWhitelisted })` is global; a
  `@Public()` route is a deliberate decision with a reason, not a forgotten
  decorator.
- Telegram bots: the webhook secret is verified; admin commands compare
  `from.id` against a list from config, never a string in code; side-effect
  commands are refused from groups and inline mode where nobody expects them;
  callback data is validated like any input.
- Sessions and tokens: expiry present, refresh rotated, logout invalidates.

### Injection

- SQL/ORM: parameters or QueryBuilder bindings, never concatenated strings;
  raw queries only with parameters. Sorting and column names from input go
  through an allowlist.
- Shell: no `exec`/`spawn` with a string built from input; arguments as an
  array.
- Path: `path.join` against a fixed root and a check the result stays inside.
- HTML: no `dangerouslySetInnerHTML` / `innerHTML` with anything user-sourced;
  templates escape by default.
- Regex built from input, `eval`, `new Function`, `vm` — a finding until proven
  otherwise.

### Outbound and integrations

- A URL that comes from input is SSRF until an allowlist says otherwise.
  Timeouts, bounded retries, TLS verification left on.
- Webhooks and payment callbacks (YooKassa and the like): signature or source
  verified; amount and currency taken from the server-side order, never from
  the client's request; idempotency by key; the order's status changes only
  from a confirmed event, never from the redirect back.
- Outgoing data is the minimum the integration needs.

### Exposure

- Entities are mapped to responses; `passwordHash`, tokens, internal ids and
  flags are excluded by construction, not by forgetting to include them.
- Client-facing errors carry no stack, query, path or internal message.
- Logs carry no tokens, passwords, card or payment bodies, full request bodies.
- Lists are paginated with a bounded page size; CORS is not `*` together with
  credentials.

### Dependencies and infrastructure

- `package.json` or the lockfile changed → `npm audit --omit=dev`; a new
  dependency is named in the report with why it was needed.
- Docker: non-root user, minimal base, no secrets baked into layers or
  `ARG`s, ports exposed only as needed.
- CI and deploy: secrets from the runner's store, never echoed; deploy jobs
  bound to protected branches.

## Output

Self-check before a commit: fixed items one line each; a found secret or a
Critical is reported before anything else; then `Checked, no issues: <categories>`
in one line so the user sees what was covered.

A requested review of a module, branch or MR — a verdict block, at most 40
lines, no code quoted beyond five lines:

```
Verdict: pass | findings

Critical:  <path:line — vulnerability — attack scenario — fix>
Important: <…>
Info:      <hardening with no known exploit — one line each>

Checked, no issues: <categories that applied and were clean>
```

Empty section is "нет". Outside your competence (cryptography, a protocol's
specifics) → say so rather than guess.
