---
name: review-security
description: "Security checklist for a diff or module — secrets, env fallbacks, input validation, auth and ownership, injection, SSRF, webhooks, data in logs and bundles, dependencies, docker and CI. Load on the diff before every commit, after review-standards, and when asked to check security or audit a module."
---

# Security review

security-guard judged command form; this judges code meaning. A finding is
exploitable or leaks. "Not best practice" without a scenario = *Info*, one line.

## Procedure

1. Scope. Uncommitted: `git diff HEAD` **and** `git status --short` —
   `/commit` stages with `git add -A`, so an untracked `.env`, dump, key,
   `*.pem` is the likely leak. Branch: `git diff <base>...HEAD` +
   `git log --stat <base>..HEAD`.
2. Secrets pass, always. Grep diff and new files for: high-entropy strings,
   `-----BEGIN`, `AKIA`, `sk_`, `ghp_`, `xox`, `eyJ`,
   `password|secret|token|api[_-]?key|private[_-]?key` next to a literal,
   `user:pass@` URLs, real infrastructure hosts/ports, real-looking emails and
   phones in fixtures. `tokensave_unsafe_patterns` first when indexed.
   Hit → stop, tell the user in one line. Secret in an earlier branch commit →
   needs **rotation**, not deletion; say so.
3. Missing controls. For every new or changed entry point — route, action,
   handler, webhook, job, upload, bot or CLI command — list what it needs:
   authentication, ownership, input validation, size and rate limits,
   idempotency, response mapping. Find each in code or in a guard it passes
   through; an absent control is a finding, as much as a wrong one.
4. Checklist for the categories the diff touches; walk callers of touched
   symbols (`tokensave_callers`) — the vulnerable path is often the caller.
5. High stakes (auth, sessions, payments, secrets/config, upload, outbound
   HTTP, docker, CI) → read the whole handler/module, every caller, and write
   the attack scenario tried per item before calling it clean.
6. Critical blocks the commit. Triage as in `review-standards` step 7:
   certain fix inside the diff → applied; a fix with a choice, a behaviour
   change or outside the diff → `AskUserQuestion`. Info: one line.

## Checklist

**Secrets and config**
- No literal secret in code, tests, fixtures, seeds, logs, errors, docker
  layers, CI output, comments. A "test" key that is real is real.
- Config through the project's config layer, validated at startup; new
  variable → `.env.example` with comment, no value. Environment values in
  constants: `code-rules.md`.
- A fallback that weakens protection when a variable is missing — auth or
  verification skipped, debug on, CORS open, a built-in key → Critical.
- `.env*`, dumps, keys, `*.pem`, local DBs in `.gitignore`.
- Tokens never in URLs, query strings, or the client bundle (`NEXT_PUBLIC_`,
  `VITE_` = public). Sensitive cookies `httpOnly`, `secure`, `sameSite`.

**Input**
- Every external input validated at the boundary the project's way (DTO with
  `whitelist` + `forbidNonWhitelisted`; client schema); numbers/ids parsed,
  enums checked, lengths and array sizes bounded.
- No mass assignment: body never spread into an entity/update; fields picked.
- Files: type from content, not the name or the client's content type,
  against an allowlist; size and count bounded while streaming; name
  replaced; stored outside the web root; never executed, included or served
  inline as active content — download disposition and `nosniff`. Archives:
  entry paths and unpacked size checked. Document parsers: external entities
  and macros off.

**Auth and access**
- Every non-public route guarded; `@Public()` is deliberate and named.
- Ownership, not just login: fetch by `id` **and** owner, or explicit check.
  Admin/role from config or DB, never a string compared in code.
- Chat bots: webhook secret verified; admin commands compare the sender id
  against config; side-effect commands refused from groups/inline; callback
  data validated.
- Sessions/tokens: expiry, refresh rotated, logout invalidates.
- Cookie-authenticated state change → CSRF protection the project's way.
- Login, reset, one-time codes, sign-up, expensive endpoints → rate limit or
  lockout.
- Signatures, tokens and hashes compared in constant time.

**Injection**
- SQL/ORM: parameters or QueryBuilder bindings; raw queries only parameterised;
  sort/column names from input via allowlist.
- Shell: no `exec`/`spawn` with a string from input; args as array.
- Path: `path.join` against a fixed root + inside-root check.
- HTML: no `dangerouslySetInnerHTML`/`innerHTML` with user data.
- Regex from input, `eval`, `new Function`, `vm` — finding until proven otherwise.
- Deep merge or dynamic key assignment from input → key allowlist or a
  null-prototype object.
- Untrusted data deserialised only by a format that cannot run code.
- Redirect target from input → relative path or allowlist.

**Outbound and integrations**
- URL from input = SSRF until an allowlist says otherwise. Timeouts, bounded
  retries, TLS verification on.
- Webhooks/payment provider callbacks: signature or source verified;
  amount/currency from the server-side order; idempotency by key; status
  changes only from a confirmed event, never from the redirect.
- Outgoing data is the minimum needed.

**Exposure**
- Entities mapped to responses; `passwordHash`, tokens, internal ids/flags
  excluded by construction.
- Client errors carry no stack, query, path, internal message.
- Logs carry no tokens, passwords, payment or full request bodies.
- Lists paginated with bounded size; CORS not `*` with credentials.

**Dependencies and infrastructure**
- `package.json`/lockfile changed → `npm audit --omit=dev`; new dependency
  named with why.
- Docker: non-root, minimal base, no secrets in layers/`ARG`s, minimal ports.
- CI/deploy: secrets from the runner store, never echoed; deploy jobs bound to
  protected branches.

## Output

Before a commit: fixes one line each; secret/Critical first; then
`Checked, no issues: <categories>`.

Requested review — readable in one pass, quoting only the lines a finding hinges on:

```
Verdict: pass | findings

Critical:  <path:line — vulnerability — attack scenario — fix>
Important: <…>
Info:      <hardening, one line each>

Checked, no issues: <categories>
```

Empty section = "нет". Outside competence (cryptography, protocol specifics) →
say so, don't guess.
