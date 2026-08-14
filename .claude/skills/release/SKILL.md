---
name: release
description: Cutting a YAAR release or changing CI. Use for release:prepare, version bumps, promoting dev to main, CI tiers, or branch protection questions.
---

# Release & CI

## Branch model

`dev` is where work lands. `main` is the stable, clone-default branch and only receives merges
from `dev`. Releases are cut by publishing a GitHub draft release targeting `main`. Open PRs
against `dev` unless the change *is* a release promotion.

## CI tiers

`.github/workflows/ci.yml` is a thin caller for `.github/workflows/checks.yml` — the **one**
definition of "is this tree good?", shared by CI and release so they can't drift. Three tiers,
escalating:

- **baseline** — `dev` gets this: install → build shared+compiler → typecheck → test →
  check:docs → check:openapi.
- **`full`** — anything touching `main` gets this too: adds lint, format:check, check:apps.
- **release** — a release adds the version-vs-tag assertion and an artifact smoke test on top
  of `full`.

Rule of thumb: a check that should guard *every push* goes in the baseline; one that only needs
to hold at promotion/ship time goes behind `full`.

**Job-id constraint**: `main`'s branch protection requires the `ci / check` status check, so
`ci.yml`'s job id must stay `check` (reusable-workflow status names are
`<caller job> / <called job>`). Renaming it silently breaks the required check.

## Branch protection

Enforced by repo rulesets (not files) — inspect with `gh api repos/sorryhyun/yaar/rulesets`.
`main`/`dev` block deletion+force-push; `refs/tags/v*` blocks deletion+force-update. `main` also
requires `ci / check`. A fast-forward `dev` → `main` push is allowed (it already carries a green
baseline-tier `ci / check`); only a PR into `main` runs `full` before the branch moves.

## Cutting a release

```bash
bun run release:prepare <version>   # stamps the version on dev
```

Then: promote the bump to `main` like any normal change → publish a GitHub **draft release
targeting `main`**. On publish, `release.yml` pins the tag's SHA, re-asserts the version, reruns
`checks.yml` with `full: true` against that exact SHA, builds + smoke-tests artifacts, and
publishes a `SHA256SUMS` manifest alongside them.

Full detail — ruleset rationale, the `SHA256SUMS` integrity model (not provenance — signing is
separate), `GET /api/version`'s two version sources, `.bun-version` vs `engines.bun` — in
`docs/reference/release_process.md`.
