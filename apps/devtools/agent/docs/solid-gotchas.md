---
name: solid-gotchas
description: Read when a Solid view misrenders or a template throws — the four traps are silent.
audience: agent
---

## Solid.js Gotchas

- **Nothing may precede the first tag, and a lone `${}` is not a template.** `solid-js/html`
  drops top-level text before the first tag, and a template whose only top-level node is the
  expression emits `.firstChild` with no parent — a stackless `SyntaxError` from
  `new Function`. So `` html`${x}` ``, `` html`hi ${x}` `` and `` html`hi` `` throw, and
  `` html`lead <b>x</b>` `` silently loses `lead `. **Return the accessor instead of wrapping
  it** — `() => (cond() ? a() : b())`, not `` html`${() => (cond() ? a() : b())}` `` — or
  give the template markup (`` html`<span>hi ${x}</span>` ``). This is the most common
  broken-template shape by far: a conditional row or panel wrapped in `` html`` `` out of
  habit. The guard (`solid-html-guard.ts`) rejects all four, and `typecheck` reports them
  too, so you do not have to reach a compile to find out.
- **`flex: 1` breaks inside reactive expressions** — Solid's `html` inserts comment markers
  that break flex chains. Use `position: absolute; inset: 0`.
- **Don't pass event handlers as component props** — `html` wraps props in reactive getters,
  so handlers fire during render. Delegate on a parent DOM element.
- **HTML entities inside `${}` don't decode** — interpolated strings are set as
  `textContent`, so `&#128247;` renders literally. Use the actual character (📷). Entities
  work only in static template text.
