---
name: react-frontend
description: "React/TypeScript client conventions — components, hooks, state, data fetching, forms, styling through project tokens, accessibility, tests. Load before writing or reviewing any client-side code: component, page, hook, store, form, or stylesheet."
---

# React frontend conventions

The project outranks this list: copy neighbouring components first
(`tokensave_context` with `path_include` on the client). Read
[../shared/code-rules.md](../shared/code-rules.md) (types, reuse, tokens,
KISS/SOLID/DRY) before the first edit; this file adds only React structure.

## Components
- Function components, named exports, one per file, file named after it.
- Props = `XProps` interface beside the component; `children` typed explicitly.
- Component renders, hook computes: loading, transformation, side effects go
  into `useX`; the component stays markup.
- Derivable from props/state → computed, not stored. `useEffect` syncs with
  the outside world, never recomputes state.

## Data and state
- Call the API the way the project already does (its client, data hook or
  store). Never a second way beside the first.
- State as close to its use as possible; global only when several trees need it.

## Forms
- The project's form library and validation schema; errors beside the field;
  submit disabled while the request is in flight.

## Accessibility and UX
- Real `button`/`a`/`input`, not `div onClick`; `aria-label` on icon buttons;
  visible focus.
- User-facing strings where the project keeps them (i18n or constants).

## Tests
- `testing-ts`, including its React lines.

## Types
- API responses typed by interfaces shared with the server when the project
  shares them.
