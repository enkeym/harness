---
name: nextjs-app
description: "Next.js App Router conventions on top of react-frontend — Server and Client Components and the 'use client' boundary, Server Actions and route handlers (validation, auth, ownership, return values), data access layer and server-only, async params/cookies/headers, caching (cacheComponents, 'use cache', cacheTag, revalidateTag, updateTag), proxy.ts, Metadata API, next/image, next/font, NEXT_PUBLIC_ exposure. Load together with react-frontend before writing or reviewing code in a project whose package.json has `next`: app/ routes, layouts, pages, actions, route.ts, proxy.ts, next.config."
---

# Next.js App Router

Next adds a server to React: every rule below is about where code runs and
what crosses the boundary. Components, hooks, forms, a11y stay in
`react-frontend`; types and reuse in [../shared/code-rules.md](../shared/code-rules.md).

## Version first

1. Read `next` in `package.json`. The installed version decides, not memory:
   `node_modules/next/dist/docs/` holds the matching docs (16.2+) — read the
   guide for the API before writing it. Project `AGENTS.md` with the
   `nextjs-agent-rules` block points there too.
2. Pages Router project (`pages/`, no `app/`) → only `react-frontend` and the
   neighbours; the rules below are App Router.
3. Breaking points to check against the version: request APIs async
   (`await params`, `await searchParams`, `await cookies()`, `await headers()`);
   `middleware.ts` renamed `proxy.ts` with `export function proxy` (Node runtime);
   `revalidateTag(tag, profile)` takes two arguments; parallel route slots need
   `default.tsx`; `next lint` gone — the ESLint CLI.

## Server and client

- Server Component by default. `'use client'` only on the leaf that needs
  state, effects, browser APIs or handlers — never on a layout or page to "make
  it work".
- Props crossing into a client component are serialisable and minimal: pick
  fields, never pass a DB record or session object.
- Modules touching DB, secrets or `process.env` start with `import 'server-only'`.
- Data read in Server Components through one data access layer (`data/`,
  `lib/dal`, or the project's API client) — whichever the project has; never a
  second approach beside it. `React.cache` for per-request dedupe.
- `NEXT_PUBLIC_` is shipped to the browser — never a secret behind it.

## Mutations

- Server Action = public POST endpoint, reachable without the UI. Inside each:
  validate input with the project's schema (`zod` or neighbour), check session,
  check ownership of the resource, return only what the UI needs
  (`{ ok, errors }`), never the updated record.
- A page-level auth check does not cover the actions on that page.
- After a write: `updateTag` for read-your-writes, `revalidateTag(tag, 'max')`
  for content that may be stale, `revalidatePath` when the project uses paths,
  `refresh()` for router-only state.
- Forms: `useActionState` + `useFormStatus` for pending and errors, unless the
  project's form library owns it.
- `route.ts` for webhooks, external clients, files; not for the app's own
  mutations. Same validation and auth as an action. A NestJS backend exists →
  the app calls it, business logic stays there.

## Rendering and cache

- `cacheComponents` on → uncached data sits inside `<Suspense>`; cached work is
  marked `'use cache'` with `cacheLife` and `cacheTag`. Off → follow the
  version's fetch/segment config the neighbours use. Never mix the two models.
- `loading.tsx`, `error.tsx` (client), `not-found.tsx` per segment that fetches;
  `notFound()` on a missing entity, not an empty page.
- Parallel fetches with `Promise.all`; no waterfall of awaits for independent data.
- No side effects in render (cookies, revalidation, writes) — actions only.

## Routing

- `proxy.ts` only for redirects, rewrites, headers and cheap auth gating; real
  authorisation stays in the DAL/action.
- Dynamic segment params are user input: parse and validate.
- `Link` for internal navigation; `redirect()` in server code, `useRouter` only
  in client handlers.

## Assets and metadata

- `next/image` with `width`/`height` or `fill` + `sizes`; remote hosts in
  `images.remotePatterns`; `priority` only on the LCP image.
- `next/font` in the root layout, not CSS `@import`.
- `metadata` / `generateMetadata`, `app/robots.ts`, `app/sitemap.ts`,
  `opengraph-image` — conventions; what goes into them is `seo`.

## Checks

- `npx tsc --noEmit`, the project's lint script, `next build` for the touched
  routes — build errors catch boundary and cache mistakes `tsc` misses.
- Tests: `testing-ts`; Server Actions tested as functions with mocked session
  and DAL.
