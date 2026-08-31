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
- **Zero-arg function props are invoked, not passed through** — `html` wraps any component
  prop whose value is a zero-argument function in a reactive getter, so
  `` html`<${C} foo=${accessor} />` `` hands the component the *current value*, not the
  accessor, and `props.foo()` throws `foo is not a function` (typechecks clean, renders a
  blank window). Same mechanism fires a zero-arg event handler during render. Wrap it
  (`foo=${() => accessor}`) to deliver the callable, share a module-level signal, or delegate
  handlers on a parent DOM element. Functions with declared parameters (`(e) => …`) pass
  through untouched.
- **HTML entities inside `${}` don't decode** — interpolated strings are set as
  `textContent`, so `&#128247;` renders literally. Use the actual character (📷). Entities
  work only in static template text.
