---
name: react-frontend
description: "React client conventions — components, hooks, state, data fetching, forms, styling through project tokens, accessibility. Load before writing or reviewing a component, page, hook, store, form or stylesheet."
---

# React frontend conventions

The project outranks this list: copy neighbouring components first
(scoped search, then `tokensave_read` mode="lines" on the client). Read
[../shared/code-rules.md](../shared/code-rules.md) (types, reuse order, tokens,
KISS/SOLID/DRY) before the first edit; this file adds only React structure.
`next` in `package.json` → load `nextjs-app` too. Tests are written only when
asked or before an MR (`test-coverage`), never as a side effect of a UI edit.

## Components
- Function components, named exports, one per file, file named after it.
- Props = `XProps` beside the component, `type` or `interface` as the project
  writes them; `children` typed explicitly.
- Component renders, hook computes: loading, transformation, side effects go
  into `useX`; the component stays markup.
- Derivable from props/state → computed, not stored. `useEffect` syncs with
  the outside world, never recomputes state.
- The installed `react` decides, not memory. 19+: `ref` is a plain prop — no
  new `forwardRef`; context rendered as `<Ctx value>`, not `<Ctx.Provider>`.
  19.2+: a value an effect reads without reacting to it → `useEffectEvent`,
  not a silenced deps rule. 19.3+: a client-only subtree → `use(browser())`,
  not `useEffect` + `mounted` state or a `typeof window` check; focus or
  listeners on a group of siblings → a Fragment ref, not a wrapper `div`.
- React Compiler on (`reactCompiler` in the config or its Babel plugin) → no
  new `useMemo`/`useCallback`/`memo` for speed; existing ones stay unless the
  task is that cleanup.

## Data and state
- Call the API the way the project already does (its client, data hook or
  store). Never a second way beside the first.
- State as close to its use as possible; global only when several trees need it.

## Forms
- The project's form library and validation schema; errors beside the field;
  submit disabled while the request is in flight.
- No form library yet and the form has validation → propose one from the
  reuse order, don't hand-roll field state.

## Accessibility and UX
- Real `button`/`a`/`input`, not `div onClick`; `aria-label` on icon buttons;
  visible focus.
- User-facing strings where the project keeps them (i18n or constants).

## Tests
- How: `test-conventions`, including its React lines.

## Types
- API responses typed by interfaces shared with the server when the project
  shares them.
