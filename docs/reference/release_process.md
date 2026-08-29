# Release Process, CI Tiers, and Branch Protection

**Source:** `.github/workflows/checks.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/release-draft-check.yml`, `scripts/release/`, `packages/server/src/config/env.ts`

How a change travels from `dev` to a published release, and which checks guard each step.

## Branches

`dev` is where work lands; `main` is the stable branch (the default, so it is what `git clone`
gives you) and only receives merges from `dev`; releases are cut by publishing a GitHub draft
release targeting `main`. Open PRs against `dev` unless the change is a release promotion.

## CI (`.github/workflows/ci.yml` → `checks.yml`)

`ci.yml` is a thin caller for `.github/workflows/checks.yml` — install → build shared + compiler →
typecheck → test → check:docs → check:openapi. Runs on push/PR to `dev` and `main`.

**`checks.yml` is the one definition of "is this tree good?"**, shared by CI and release so they
cannot drift. Its `full` input adds lint, format:check, and check:apps. Three tiers, escalating:

- `dev` gets the baseline (fast inner loop).
- Anything touching `main` gets `full` (it is the clone target).
- A release gets `full` plus the version-vs-tag assertion and the artifact smoke test.

A check that should guard every push goes in the baseline; one that need only hold at promotion or
ship time goes behind `full`.

## Branch protection

Enforced by repo rulesets, not files — inspect with `gh api repos/sorryhyun/yaar/rulesets`:

- `main` and `dev` both block deletion and force-push.
- `refs/tags/v*` blocks deletion and force-update, so a botched release is retried with a new
  patch version rather than by moving a tag.
- `main` additionally requires the `ci / check` status. The reusable-workflow name is
  `<caller job> / <called job>`, so that string is `ci.yml`'s job id (`ci`) followed by
  `checks.yml`'s (`check`) — renaming *either* silently detaches the rule.

Nothing bypasses these; the Actions bot *cannot* be given a bypass on a user-owned repo, which is
what shaped the release flow below. A fast-forward `dev` → `main` push is still allowed: the commit
already carries a green `ci / check` from its `dev` run. Note that push satisfies the rule with the
**baseline** tier — only a PR into `main` runs `full` *before* the branch moves.

## Cutting a release

`bun run release:prepare <version>` stamps the version on `dev` (this replaced a workflow that
committed the bump straight to `main`; it can't, now that `main` requires a status a `GITHUB_TOKEN`
push never produces), the bump is promoted to `main` like any other change, then a draft release
targeting `main` is published.

- `release-draft-check.yml` warns while the release is still a draft if the target commit's version
  disagrees with the tag.
- On publish, `release.yml`'s `resolve` pins the tag's SHA and re-asserts the version → `verify`
  runs `checks.yml` with `full: true` against that SHA (a draft may target any branch or SHA, so
  the released commit is not necessarily ruleset-gated) → `release` builds and smoke-tests the
  artifacts, then publishes a `SHA256SUMS` manifest alongside them.

## The `SHA256SUMS` manifest

The manifest is generated after every artifact exists, so it can never describe files the release
did not ship. `install.sh`/`install.ps1` verify against it, hard-failing on a mismatch and
warning-but-continuing when it is absent (releases predating it, and `VERSION=` pins at those
tags). It rides the same HTTPS channel as the artifacts, so it is integrity, not provenance —
signing is a separate, later step. The installers are deliberately excluded from it: a user who
pipes one to a shell has already trusted that URL.

## Version at runtime

`YAAR_VERSION` (`packages/server/src/config/env.ts`), served by `GET /api/version` with
`bundled`/`platform`/`arch`. Two sources, one per build shape — the `__YAAR_VERSION` compile-time
define for the exe (which has no `package.json` beside it, since `PROJECT_ROOT` there is wherever
the binary was dropped), and `package.json` at `PROJECT_ROOT` under `bun run`.
`scripts/release/set-version.ts` stamps that file and `scripts/build/exe-bundle.js` reads it for
the define, so the two agree by construction; `0.0.0-unknown` means neither answered. The route is
on `PUBLIC_ENDPOINTS` (the iframe allowlist) with no permission check, so an app can read the
version without declaring anything in its `app.json`.

## Bun version

CI/release pin the version in `.bun-version` (via setup-bun's `bun-version-file`). `engines.bun`
states the supported *floor*; the two are intentionally different numbers.
