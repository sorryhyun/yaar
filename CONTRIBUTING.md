# Contributing to YAAR

Thanks for your interest in YAAR. This project moves fast and stays small on
purpose, so contributions are organized into **three tiers**. Each tier has a
different path — knowing which tier your change falls into tells you exactly
what to do (and what *not* to do).

Read the tier that matches your change before opening anything.

---

## TL;DR

| Tier | Kind of change | What to do |
| ---- | -------------- | ---------- |
| **0** | Typos, doc drift, stale comments | **Open an issue. Do not send a PR.** |
| **1** | Bug fixes | PR with a failing-then-passing test. Issue first is recommended. |
| **2** | New features (libraries, compiler, new surfaces) | **Discuss first.** No PR until agreed. |

---

## Tier 0 — Small text fixes (issue only, no PR)

Typos, out-of-date docs, stale comments, a wrong path in a `CLAUDE.md`, a broken
link — anything where the fix is a few characters of prose.

**Please open an issue, not a pull request.**

This is deliberate. A PR for a one-character typo costs more to review, rebase,
and merge than it saves, and a stream of tiny PRs makes the history harder to
read. Instead, file an issue describing what's wrong and where (file + line is
ideal). A maintainer will fold it into a batch fix.

> One exception: if you're already touching a file for a Tier 1 or Tier 2 change
> and you spot an adjacent typo, fixing it in the same PR is fine. It's *only*
> the standalone typo-PR we're avoiding.

**How to file:** open a GitHub issue, point at the file and line, and say what
it should read instead. That's it.

---

## Tier 1 — Bug fixes (PR welcome, test required)

A bug is behavior that contradicts what the code is clearly meant to do: a crash,
a wrong result, a regression, a race. Fixing one is the most valuable
contribution you can make, and you may open a PR directly — **opening an issue
first is recommended** (it lets a maintainer confirm it's a real bug and not
intended behavior before you invest the time), but it isn't required for small,
clear-cut fixes.

**Every bug fix PR must include a test that reproduces the bug.** No exceptions.
The workflow is:

1. **Write a test that fails** because of the bug. This proves the bug exists and
   pins down exactly what "fixed" means.
2. **Fix the bug** so that test passes.
3. **Run the suite** and confirm the new test passes and nothing else broke.

```bash
bun install
bun run typecheck                                 # must pass
make lint                                          # must pass

# Run the package your change touches:
bun run --filter @yaar/frontend test
bun run --filter @yaar/server test
bun run --filter @yaar/shared test
```

A fix without a reproducing test won't be merged — even if it's obviously
correct — because without the test there's nothing stopping the bug from coming
back. If the bug is genuinely hard to cover with a test (e.g. it depends on live
provider I/O), say so in the PR description and explain how you verified the fix;
a maintainer will help find a testable seam.

**PR checklist for Tier 1:**

- [ ] A new test that fails on `main` and passes with your fix
- [ ] `bun run typecheck` passes
- [ ] `make lint` passes
- [ ] The relevant package's test suite passes
- [ ] PR description explains the bug, the root cause, and the fix

---

## Tier 2 — New features (discuss before you build)

New capability, not fixing existing behavior. For example:

- Adding a new bundled library (`@bundled/*`) or a gated SDK
- Compiler changes (new plugin, new import resolution, bundling behavior)
- A new surface — a new frontend (e.g. a CLI), a new provider, a new app-agent
  tool, a new OS Action, a new MCP namespace
- Anything that changes an architecture boundary described in a `CLAUDE.md` or
  `docs/architecture/`

**These must be discussed and agreed before any PR is opened.** Open an issue (or
a GitHub Discussion) describing:

- **What** you want to add and **why** — the use case, not just the mechanism
- **Where** it fits in the existing architecture (which package, which boundary)
- **What alternatives** you considered, especially doing it inside an app instead
  of in the core

The reason is cost of ownership. Every new library, surface, or compiler path is
something the project maintains, secures, and keeps working across releases
forever. A lot of what looks like a core feature can live as a YAAR **app**
instead (see [`docs/guides/app-development.md`](./docs/guides/app-development.md)) —
apps get the bundled libraries, the SDK, and the design system without expanding
the core's surface area. Part of the discussion is figuring out whether your idea
should be an app, a core change, or not built at all.

A PR that adds a Tier 2 feature without a prior agreed-upon issue will be asked to
pause for that discussion, regardless of code quality. This isn't about the code —
it's about making the decision to expand the project before, not after, the work
is done.

---

## Development setup

**Prerequisites:** Bun ≥ 1.3, and the Claude CLI (or Codex) installed and
authenticated.

```bash
bun install          # install all workspace deps
make dev             # start with auto-detected provider (http://localhost:5173)
make claude-dev      # Claude provider, no MCP auth (local dev)
make codex-dev       # Codex provider, no MCP auth (local dev)
```

Before pushing:

```bash
bun run typecheck
make lint
bun run format:check     # Prettier — bun run format to fix
```

CI (`.github/workflows/ci.yml`) runs `bun install` → build shared → typecheck →
test on every push and PR to `dev` or `main`. Merging into `main` additionally
runs lint, formatting, and the app rules, since `main` is the branch people
clone. A pre-commit hook (Husky + lint-staged) auto-applies Prettier and ESLint
fixes to staged files, so those extra checks should already be satisfied.

## Conventions

- **Branch:** work off `dev` and open your PR against `dev`. `main` is the
  stable branch — it is what `git clone` gives you and what releases are cut
  from, so it only ever receives merges from `dev`.
- **Commits:** Conventional Commits — `feat(...)`, `fix(...)`, `chore(...)`,
  `docs(...)`, matching the existing history.
- **TypeScript:** strict mode, ESM everywhere. Server imports use `.js`
  extensions (ESM requirement). Shared package uses Zod v4.
- **Docs:** each package has its own `CLAUDE.md` with architecture detail; the
  root `CLAUDE.md` is the map. If your change makes one of them wrong, that's a
  Tier 0 issue at minimum — and if you're already in the file for Tier 1/2 work,
  update it in the same PR.

## Questions

Not sure which tier your change is? Open an issue and ask — describing the change
is exactly what Tier 0 and Tier 2 want anyway, and for Tier 1 it's the
recommended first step.
