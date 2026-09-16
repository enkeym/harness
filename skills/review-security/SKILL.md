---
name: review-security
description: "Security checklist for a diff or module and the procedure to run it — leaked secrets (code, tests, fixtures, untracked files about to be staged), env and config, input validation and mass assignment, auth and ownership, injection (SQL/ORM, shell, path, HTML, regex), SSRF and outbound calls, bot webhooks and payment provider callbacks, sensitive data in logs and responses, client bundle exposure, dependencies, docker and CI. Load on the diff before every commit and whenever asked to check security or audit a module. Complements the security-guard hook, which sees commands, not code."
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
3. Checklist for the categories the diff touches; walk callers of touched
   symbols (`tokensave_callers`) — the vulnerable path is often the caller.
4. High stakes (auth, sessions, payments, secrets/config, upload, outbound
   HTTP, docker, CI) → read the whole handler/module, every caller, and write
   the attack scenario tried per item before calling it clean.
5. Critical blocks the commit. Important: fixed inside the diff, reported
   outside. Info: one line.

## Checklist

**Secrets and config**
- No literal secret in code, tests, fixtures, seeds, logs, errors, docker
  layers, CI output, comments. A "test" key that is real is real.
- Config through the project's config layer, validated at startup; new
  variable → `.env.example` with comment, no value.
- `.env*`, dumps, keys, `*.pem`, local DBs in `.gitignore`.
- Tokens never in URLs, query strings, or the client bundle (`NEXT_PUBLIC_`,
  `VITE_` = public). Sensitive cookies `httpOnly`, `secure`, `sameSite`.

**Input**
- Every external input validated at the boundary the project's way (DTO with
  `whitelist` + `forbidNonWhitelisted`; client schema); numbers/ids parsed,
  enums checked, lengths and array sizes bounded.
- No mass assignment: body never spread into an entity/update; fields picked.
- Files: type and size checked server-side, name sanitised, stored outside the
  web root, never executed or included.

**Auth and access**
- Every non-public route guarded; `@Public()` is deliberate and named.
- Ownership, not just login: fetch by `id` **and** owner, or explicit check.
  Admin/role from config or DB, never a string compared in code.
- Chat bots: webhook secret verified; admin commands compare the sender id
  against config; side-effect commands refused from groups/inline; callback
  data validated.
- Sessions/tokens: expiry, refresh rotated, logout invalidates.

**Injection**
- SQL/ORM: parameters or QueryBuilder bindings; raw queries only parameterised;
  sort/column names from input via allowlist.
- Shell: no `exec`/`spawn` with a string from input; args as array.
- Path: `path.join` against a fixed root + inside-root check.
- HTML: no `dangerouslySetInnerHTML`/`innerHTML` with user data.
- Regex from input, `eval`, `new Function`, `vm` — finding until proven otherwise.

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

Requested review — ≤40 lines, ≤5 lines of quoted code:

```
Verdict: pass | findings

Critical:  <path:line — vulnerability — attack scenario — fix>
Important: <…>
Info:      <hardening, one line each>

Checked, no issues: <categories>
```

Empty section = "нет". Outside competence (cryptography, protocol specifics) →
say so, don't guess.
