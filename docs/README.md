# YAAR Documentation

New here? Start with the [FAQ](./faq.md) — it answers the questions people actually ask first (why a GUI, why an OS shape, how the agent accesses things).

## Layout

| Directory | Genre | What belongs here |
|-----------|-------|-------------------|
| [`architecture/`](./architecture/) | **Intuition & rationale** | Mental models, invariants, and the *why* — including the failure that motivated a rule |
| [`reference/`](./reference/) | **Precision** | Schemas, payload shapes, protocol details, API tables — anything a reader would copy-paste |
| [`guides/`](./guides/) | **How-to** | Task-oriented walkthroughs (app development, hooks, remote mode) |
| [`proposals/`](./proposals/) | **Design drafts** | Not-yet-landed designs; may not match the code |

## The rule

**An architecture doc may name a file, but never enumerates a schema.** If you're writing a payload table, a parameter list, or an interface body, it goes in `reference/` and the architecture doc links to it. Conversely, reference docs don't argue — rationale lives in `architecture/`.

The reason: precise detail embedded in an intuition doc rots silently (nobody re-verifies a table they skimmed past), and it buries the intuition the doc exists to deliver. Keeping the genres separate keeps both honest — architecture docs stay true because they carry few falsifiable details, reference docs stay true because they're the single place a detail lives.

## Pruning

Rationale earns its place by explaining what's here — not by re-arguing what isn't. When a doc, comment, or test starts defending a decision against alternatives nobody is holding, see [Phantom warnings: a doc-polish case study](./guides/doc_polish_case.md) for how to find those clusters and cut them without losing the fact underneath.
