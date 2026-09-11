---
name: react-frontend
description: React/TypeScript client conventions — components, hooks, state, data fetching, forms, styling through project tokens, accessibility, tests. Load before writing or reviewing any client-side code: component, page, hook, store, form, or stylesheet.
---

# React frontend conventions

The project outranks this list: copy neighbouring components first
(`tokensave_context` with `path_include` on the client). Global rules (no
`any`, reuse first, no hardcoded design values) are in CLAUDE.md.

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
- Loading, error and empty states handled, not only the happy path.

## Forms
- The project's form library and validation schema; errors beside the field;
  submit disabled while the request is in flight.

## Styles
- Only project tokens: colors, spacing, fonts, radii, z-index. A raw px/hex is
  the signal a token is needed; none exists → report, don't hardcode.
- One styling method — the project's (CSS modules, styled, utility classes).

## Accessibility and UX
- Real `button`/`a`/`input`, not `div onClick`; `aria-label` on icon buttons;
  visible focus.
- User-facing strings where the project keeps them (i18n or constants).

## Tests
- Testing Library: query by role and text; `userEvent` over `fireEvent`.
- Mock the boundary (API client, timers), not the component's own hooks.
  Rest is in `testing-ts`.

## Types
- API responses typed by interfaces shared with the server when the project
  shares them.
