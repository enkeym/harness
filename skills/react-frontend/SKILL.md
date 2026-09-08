---
name: react-frontend
description: React/TypeScript client conventions — components, hooks, state, data fetching, forms, styling through project tokens, accessibility, tests. Load before writing or reviewing any client-side code: a component, page, hook, store, form, or stylesheet.
---

# React frontend conventions

The project outranks this list: look at neighbouring components first
(`tokensave_context` with `path_include` on the client) and repeat their way.
Global rules — no `any`, reuse before writing new, never hardcode a design value
— live in CLAUDE.md and are not repeated here.

## Components

- Function components, named exports, one component per file, file named after
  the component.
- Props are an `XProps` interface next to the component; `children` is typed
  explicitly.
- The component renders, the hook computes: loading, transformation and side
  effects go into a `useX` hook and the component stays markup.
- Don't grow state: anything derivable from props or other state is computed,
  not stored. `useEffect` synchronises with the outside world; it does not
  recompute state.

## Data and state

- Call the API the way the project already does — its API client, data hook or
  store. A second way is never introduced next to the first.
- Keep state as close to its use as possible; only what several trees genuinely
  need goes global.
- Loading, error and empty-list states are always handled, not just the happy
  path.

## Forms

- The project's form library and its validation schema; error messages next to
  the field; the submit button disabled while the request is in flight.

## Styles

- Only project tokens and variables: colors, spacing, fonts, radii, z-index. A
  raw px or hex value in a component is the signal that a token is needed —
  if none exists, say so in the report instead of hardcoding.
- Repeat the project's styling method (CSS modules, styled, utility classes);
  never mix two.

## Accessibility and UX

- Real `button`/`a`/`input`, not a `div` with `onClick`; `aria-label` on icon
  buttons; focus stays visible.
- User-facing strings go where the project keeps them (i18n or constants), not
  into JSX literals, when that is the project's way.

## Tests

- Testing Library: query by role and text, the way a user sees it; `userEvent`
  over `fireEvent` where event order matters.
- Mock the boundary (API client, timers), not the component's own hooks.
- Everything else about tests is in the `testing-ts` skill.

## Types

- API responses are typed by interfaces shared with the server when the project
  shares them.
