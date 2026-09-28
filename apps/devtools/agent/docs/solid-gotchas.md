---
name: solid-gotchas
description: Read when a Solid view misrenders, a template throws, a <select> snaps back, or built HTML strings lose closing tags — the traps are silent.
audience: agent
---

## Solid.js Gotchas

- **Nothing may precede the first tag, and a lone `${}` is not a template.** `solid-js/html`
  drops top-level text before the first tag, and a template whose only top-level node is the
  expression emits `.firstChild` with no parent — a stackless `SyntaxError` from
  `new Function`. So `` html`${x}` ``, `` html`hi ${x}` `` and `` html`hi` `` throw, and
  `` html`lead <b>x</b>` `` silently loses `lead `. **Return the accessor instead of wrapping
  it** — `() => (cond() ? a() : b())`, not `` html`${() => (cond() ? a() : b())}` `` — or
  give the template markup (`` html`<span>hi ${x}</span>` ``). The usual case is a
  conditional row or panel wrapped in `` html`` ``. The guard (`solid-html-guard.ts`)
  rejects all four, and `typecheck` reports them too.
- **`flex: 1` breaks inside reactive expressions** — Solid's `html` inserts comment markers
  that break flex chains. Use `position: absolute; inset: 0`.
- **Zero-arg function props are invoked, not passed through** — `html` wraps any component
  prop whose value is a zero-argument function in a reactive getter, so
  `` html`<${C} foo=${accessor} />` `` hands the component the *current value*, not the
  accessor, and `props.foo()` throws `foo is not a function` (typechecks clean, renders a
  blank window). Same mechanism fires a zero-arg event handler during render. Wrap it
  (`foo=${() => accessor}`) to deliver the callable, share a module-level signal, or delegate
  handlers on a parent DOM element. "Zero-arg" is `fn.length === 0`, which counts
  parameters only up to the first default or rest: `(e) => …` passes through untouched, but
  `(x = 1) => …`, `(...args) => …` and `({ a } = {}) => …` are invoked like accessors.
- **A render callback passed as children must sit tight against the tags.** A `For`-like
  component taking `(item) => row` as `children` gets an *array* (whitespace text nodes plus
  the function) when the template has spaces or newlines around it — `>${(x) => …}</>`,
  not `> ${…} </>`. It compiles and renders a blank list. Calling a component as a plain
  function (`${Field({ … })}`) sidesteps prop wrapping entirely when that is simpler.
- **HTML entities inside `${}` don't decode** — interpolated strings are set as
  `textContent`, so `&#128247;` renders literally. Use the actual character (📷). Entities
  work only in static template text.
- **A handler that takes a parameter receives the event in it.** `onclick=${refresh}`
  where `refresh(pages = 1)` is called as `refresh(mouseEvent)` — no throw, just a
  `MouseEvent` where a number belonged. Write `onclick=${() => refresh()}`.
- **A `<select>` inside `Show`/`For` needs `selected` on its options, not only `value`.**
  Assigning `value` before the `<option>`s exist is a silent no-op, so a subtree rebuilt
  on a tab switch snaps back to the first option while the signal holds the right id.
  Bind `` selected=${() => o.id === choice()} `` on each option as well.
- **The compiler rewrites `</${anything}>` to `</>` in every `.ts` file** — meant for
  `` html`<${C}>…</${C}>` ``, but it matches plain template strings too, so
  `` `<${tag}>${v}</${tag}>` `` in an export or serializer ships as `<th>Task</>`, which
  parsers drop. Source, typecheck and unbundled tests all look right; only `dist` is
  wrong. Spell closing tags as literals, or build with DOM calls and take `outerHTML`.
- **A Solid store value cannot cross the protocol.** Returning a `createStore` array or
  object from a state getter or `run` fails structured clone; copy it (`[...s.items]`,
  `unwrap()`) at the boundary.
