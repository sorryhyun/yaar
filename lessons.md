# Lessons from Pretext for YAAR

What pretext teaches, and what it suggests about where YAAR could go.

---

## The Core Insight: Separate Understanding from Rendering

Pretext's architecture is built on one split:

1. **Prepare** — expensive, one-time. Normalize text, segment it, measure each segment via canvas, cache everything.
2. **Layout** — cheap, many times. Pure arithmetic over cached numbers. No DOM, no canvas, no strings. ~0.0002ms per text block.

This isn't just a performance trick. It's a statement about *who owns layout knowledge*. The browser owns it today — you put text in a box, and the browser tells you how tall it is, but only if you ask nicely (and pay for reflow). Pretext inverts that: the application understands its own text, and the browser just paints pixels.

YAAR has an analogous split that isn't fully realized yet:

1. **AI decides** — what to show, what shape it takes (OS Actions, Component DSL)
2. **Frontend renders** — React receives the decision and paints it

But between "AI decides" and "frontend renders," there's a missing phase: **layout computation**. Right now the browser handles that entirely. The server sends abstract commands, the frontend puts them in the DOM, and CSS figures out where everything goes. This works, but it means:

- The server can't predict how tall a window's content will be
- Resize reflows require the browser to re-layout everything
- Virtualization (rendering only visible items) is hard because you don't know item heights without rendering them
- The CLI panel, conversation history, and long window content all render every item

Pretext shows that this middle phase — understanding layout without rendering — is tractable and fast.

---

## What "Userland Layout Control" Means for AI-Generated UI

From `thoughts.md`:

> 80% of CSS spec could be avoided if userland had better control over text.

This is provocative on its own, but for YAAR it hits differently. YAAR doesn't have a designer placing elements — an AI generates the UI structure on every interaction. The AI already thinks in terms of abstract layout (the flat Component DSL with grid columns, gaps, alignments). But the moment that structure reaches the browser, control is handed off to CSS.

What if it wasn't?

Consider: the AI generates a component layout. Today, `ComponentRenderer.tsx` translates that to CSS Grid. But the AI already *knows* the content — it wrote it. If the content were `prepare()`-d at generation time (or at first render), the application would know exact dimensions for every text block. Then:

- **Window auto-sizing** could be exact, not heuristic
- **Streaming responses** could predict final height and pre-allocate scroll space
- **Monitor layout** (tiling, stacking) could account for content dimensions, not just window frames
- **The server could lay out windows** without a browser, enabling headless clients or server-side rendering of initial state

This isn't about replacing CSS everywhere. It's about having a fallback that doesn't require a browser for the cases where precision matters.

---

## The Virtualization Pattern

The `markdown-chat` demo is a working proof: 10,000 markdown messages, virtualized, with full rich text (headings, code blocks, lists, blockquotes, inline code, links). Only visible messages get DOM nodes. Scroll performance is constant regardless of conversation length.

The pattern:

```
prepare all messages once (text analysis + canvas measurement)
    ↓
on resize: layout all messages (pure arithmetic → cumulative heights)
    ↓
on scroll: binary-search visible range → create/recycle DOM nodes
```

YAAR has two places this would matter most:

1. **CLI Panel** — `TerminalPane` renders every entry. Long sessions with many tool calls, thinking blocks, and responses will slow down. Pretext's model would let it virtualize: prepare each entry's text once, compute heights on resize, render only what's visible.

2. **Window content** — Markdown and text renderers could pre-compute content height, enabling the window frame to know its ideal size before rendering, and enabling virtualized scrolling for long content.

The interesting part is that pretext's virtualization doesn't use `IntersectionObserver` or `react-virtuoso` or any framework abstraction. It's direct: compute geometry → binary search → DOM manipulation. This is faster and more predictable than framework-based virtualization because there are no intermediate abstractions guessing at heights.

---

## Bubble Shrinkwrap (A Small but Telling Detail)

`bubbles-shared.ts` solves a common chat UI problem: a message bubble with `max-width: 80%` wastes space when the text doesn't fill the width. CSS has no way to say "be as wide as the longest line of wrapped text."

Pretext's solution: binary search for the narrowest width that doesn't increase line count.

```typescript
function findTightWrapMetrics(prepared, maxWidth) {
  const initial = collectWrapMetrics(prepared, maxWidth)
  let lo = 1, hi = Math.ceil(maxWidth)
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layout(prepared, mid).lineCount <= initial.lineCount) hi = mid
    else lo = mid + 1
  }
  return collectWrapMetrics(prepared, lo)
}
```

This works because `layout()` is so cheap (~0.0002ms) that binary-searching across hundreds of widths is still sub-millisecond.

This is a microcosm of the larger point: when layout computation is cheap, you can do things that are architecturally impossible with CSS. You can *search* for optimal layouts rather than *declaring* them and hoping the browser gets close enough.

---

## Zero-Allocation Discipline

Pretext's `layout()` allocates nothing. It mutates no arrays, creates no objects, does no string work. This is deliberate — the function runs on every resize frame, potentially for hundreds of text blocks.

YAAR's hot paths aren't as extreme, but the discipline is worth noting:

- **WebSocket event dispatch** (`BroadcastCenter`) — serializes and sends to all connections per session. Pre-serializing payloads once (instead of per-connection) is the same instinct.
- **Window drag/resize** — fires continuously during interaction. If layout computation touched the DOM on every move, it would jank.
- **Streaming AI responses** — tokens arrive rapidly. Each token appended to content shouldn't trigger full re-measurement.

The general rule: identify the operation that runs N times per frame, and make sure it does O(1) work with zero allocations.

---

## Engine Profiles (A Pattern for Browser Differences)

Instead of:
```typescript
if (navigator.userAgent.includes('Safari')) {
  // special handling...
}
```

Pretext detects the engine once and creates a profile object:
```typescript
const engineProfile = {
  lineFitEpsilon: isSafari ? 1/64 : 0.005,
  carryCJKAfterClosingQuote: isChromium,
  preferPrefixWidthsForBreakableRuns: isSafari,
  preferEarlySoftHyphenBreak: isSafari,
}
```

Then the hot path reads flags from the profile — no string comparisons, no scattered conditionals.

YAAR's frontend likely has or will accumulate browser-specific workarounds (especially around WebSocket behavior, CSS rendering, font rendering with `NanumSquareNeo`). Consolidating these into a single detected profile keeps them discoverable and testable.

---

## Rendering-Agnostic Computation

Pretext gives you `{ text, width, height, cursors }`. It doesn't care if you render to DOM, Canvas, SVG, or a headless test. The layout engine is pure computation.

YAAR already has a version of this: OS Actions are abstract commands (`open_window`, `update_content`, `show_notification`) that don't specify rendering. The frontend interprets them into React components.

Taking this further: if window content layout were also computed abstractly (like pretext does for text), the entire "what does this session look like" question could be answered without a browser. This enables:

- **Server-side layout testing** — verify that AI-generated UIs are well-formed without rendering
- **Headless clients** — a terminal or API client that understands window positions and content dimensions
- **Session replay** — reconstruct visual state from logs with exact layout, not just content

---

## The Inline Flow Model

`inline-flow.ts` handles mixed inline runs: regular text interspersed with atomic boxes (pills, mention chips, inline code) that have their own padding and break behavior. It collapses whitespace across item boundaries and keeps atomic items unbroken.

This maps to a real need in YAAR's Component DSL. Today, components are grid items — they sit in cells. But there's no inline-level mixing (text with embedded badges, mentions, or interactive chips in a flowing paragraph). The inline flow model is exactly what you'd need for richer AI-generated content that mixes text and interactive elements in a natural reading flow.

---

## What This Doesn't Solve

Pretext is horizontal text layout only. It doesn't help with:

- **Vertical layout** — window stacking, monitor tiling, z-ordering
- **Interactive layout** — drag constraints, snap points, collision detection
- **Responsive breakpoints** — YAAR's desktop metaphor doesn't use traditional responsive design
- **Complex CSS** — floats, columns, absolute positioning, transforms

These remain browser/CSS territory. Pretext is specifically about reclaiming the one thing CSS handles worst for applications: knowing how text wraps before you render it.

---

## Possible Directions

Not a plan — just threads worth pulling on.

**As a bundled library for apps:** Add pretext to `@bundled/*` so YAAR apps can use it. Apps that render custom text (editors, chat views, code viewers) would get pretext's measurement for free. Low effort, immediate value.

**For CLI panel virtualization:** The terminal pane is the most obvious bottleneck for long sessions. Prepare each entry's text on arrival, compute heights lazily, virtualize the scroll. Medium effort, high impact for power users.

**For content-aware window sizing:** When the AI creates a window with text/markdown content, prepare the content and compute its natural dimensions. Use that to suggest or auto-set the window size. Medium effort, improves the "AI decides the UI" experience.

**For server-side layout prediction:** The most ambitious direction. If the server could `prepare()` + `layout()` content (using `OffscreenCanvas` in a worker), it could send pre-computed dimensions with OS Actions. The frontend would know exact sizes before rendering. High effort, but it completes the "application owns its layout" vision.

**For streaming response layout:** As tokens stream in from the AI, incrementally prepare and re-layout. Pre-allocate scroll space based on predicted height. Prevents the "jumping scroll" problem during streaming. Medium effort, nice UX improvement.

---

## The Deeper Question

Pretext's `thoughts.md` ends with:

> The cost of any verifiable software will trend toward 0

In a world where AI generates UI, the question isn't "how do we make CSS better?" but "what layout capabilities does the *application* need to retain control over its own rendering?" CSS is designed for human authors declaring intent. When the author is an AI that already knows the content, the intent, and the structure — what's the right level of abstraction?

YAAR's flat Component DSL is one answer: strip away CSS complexity, give the AI a simple vocabulary. Pretext suggests another layer: give the application (not the browser) the ability to *understand* its own text layout, so the AI's decisions can be precise rather than approximate.

The two ideas aren't in tension. The DSL handles structure; pretext handles measurement. Together, they'd let the AI say "here's a window with this content, and it should be exactly 347px tall" — and be right.
