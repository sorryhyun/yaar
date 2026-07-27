# Phantom warnings: a doc-polish case study

A **phantom warning** is prose that defends a decision against an alternative nobody
is holding. It reads like a hazard note, but the hazard is settled history — a mode
that was removed, a bug that was fixed, an app that never shipped.

One is harmless. They accumulate, because each one looks locally justified: the writer
has just made a decision and the reasoning is fresh. The reader arrives a year later
with no such context and cannot tell "this is a live trap" from "this argument is over."

This doc is the method for removing them, worked against a real one in this repo.
Use it as the pattern when you find the next.

## The signal is repetition, not negation

Do not grep for negative words. A codebase should say "never hardcode colors" and
"descent never adds capability" — those are rules, stated once, load-bearing.

What marks a phantom is that **the same absence is asserted many times in many
places**. Search for clusters:

```bash
# Rank docs by negation density — outliers are the candidates, not the whole list
for f in $(find docs -name '*.md'); do
  n=$(grep -oiE "there is no|no longer|never |was removed|used to " "$f" | wc -l)
  l=$(wc -l < "$f")
  [ "$l" -gt 40 ] && printf "%6.1f  %s\n" "$(echo "scale=2; $n*100/$l" | bc)" "$f"
done | sort -rn | head
```

Then confirm the cluster is one topic restated, not many distinct facts. (This doc
ranks first, since it quotes phantom warnings as specimens — expect a few such
false positives and read the hits before trusting the ranking.)

> **Count occurrences, not lines, and anchor the word.** `grep -c -i "LAN"` is wrong
> twice: `-c` counts matching *lines* (three mentions on one line score 1), and `-i`
> without `-w` matches `planned`, `language`, `Atlantic`. Use
> `grep -ow LAN file | wc -l`. This mistake understated the case below by 4×.

## The case: "there is no LAN mode"

YAAR's remote mode tunnels over Tailscale. An older version could bind the LAN with
`{ "disabled": true }`; that was removed because one host on one port cannot publish
the two browser origins app-origin isolation needs.

A true fact, and worth recording once. It was recorded **43 times**:

| File | Before | After |
|---|---:|---:|
| `docs/guides/remote_mode.md` | 14 | 1 |
| `docs/ko/remote_mode.md` | 14 | 1 |
| `packages/server/src/lifecycle.ts` | 8 | 0 |
| `packages/frontend/.../QrCodeModal.tsx` | 3 | 2 |
| `lib/tunnel/config.ts`, `tests/tunnel-config.test.ts` | 4 | 2 |
| **Total** | **43** | **6** |

In the English guide alone: a dedicated `#### Why there is no LAN mode` section, four
cross-links pointing at it, the banner string `(loopback only — no LAN)`, a table cell
reading `Only value accepted`, and a running commentary —

- *"there is no LAN fallback, by design"*
- *"a LAN bind buys nothing and YAAR never opens one"*
- *"never silently LAN-wide"*
- *"there is no plain-`http://` LAN mode any more"*
- *"there is no LAN URL to fall back to"*
- *"which is why tunnel-off remote mode was removed rather than documented"*

The reader who wanted to know how to reach YAAR from their phone had to wade through
six rebuttals of a question they never asked.

## The method

### 1. Find the one audience the passage still serves

Most of the cluster served nobody. The removal history had exactly one live audience:
**someone holding an old `tunnel.json` that will now be refused.** That person needs a
migration note. Everyone else was reading a closed argument.

So the 150-word `> **Removed:**` blockquote became:

```markdown
> **Upgrading from an older config:** earlier versions used an SSH reverse tunnel via
> `localhost.run` (or a custom SSH server), and accepted `{ "disabled": true }` to run
> with no tunnel. Both are gone, along with the `ssh2` dependency. A `tunnel.json` still
> asking for either is refused with a warning and Tailscale is used instead; replace it
> with `{ "service": "tailscale" }`.
```

Same facts, addressed to the person who needs them, with the action they should take.

### 2. Say what *is*, then route

Replace "why X doesn't exist" with "what does exist" plus a pointer for anyone who
actually wanted X. The whole `#### Why there is no LAN mode` section collapsed to:

```markdown
**Reach:** the server stays on loopback, so what can connect is your tailnet (through
the daemon) plus this machine — not the whole internet, and not your LAN. If you want
YAAR reachable some other way, put an [external tunnel](#external-tunneling-alternatives)
in front of the loopback port.
```

One clause carries the fact. The link does what six paragraphs of rationale could not:
gets the reader unstuck.

### 3. In code, keep the mechanism and drop the litigation

Comments earn their place by explaining the code in front of you. Before:

```ts
/**
 * `tailscaled` reaches YAAR at `127.0.0.1`, so the tunnel needs nothing else, and the
 * one configuration that ever wanted `0.0.0.0` — remote mode with the tunnel disabled —
 * no longer exists. That mode published one host on one port, which cannot carry the
 * app-origin boundary; a LAN bind is not something YAAR offers to reach it.
 *
 * So a failed Tailscale tunnel means localhost-only, never LAN-only: someone who asked
 * for tailnet-only must not silently get their whole LAN exposed on a bearer token
 * because `tailscaled` was down.
 */
```

After — the invariant and the non-obvious consequence survive; the argument with the
deleted mode goes:

```ts
/**
 * `tailscaled` reaches YAAR at `127.0.0.1`, so the tunnel needs nothing else. A failed
 * tunnel therefore leaves the server localhost-only — the daemon being down is not
 * consent to expose a wider surface on a bearer token.
 */
```

### 4. In tests, let the assertion carry the claim

A test file's header should say what the rows pin down. Ours spent two paragraphs on
why a removed transport was removed, then asserted on a warning string. Keep the part
that explains *why the assertion exists* — here, that the warning is the contract:

```ts
/**
 * The part worth pinning is what happens to a config asking for a removed transport —
 * the SSH tunnel, or `{ "disabled": true }`. Each asked for a *public* or LAN URL, so
 * falling through to Tailscale silently would swap the user's posture without a word:
 * the warning is the contract, and these rows assert on it.
 */
```

Inline comments restating what the `expect()` already says are pure deletion.

### 5. Sweep the blast radius

Removing a section breaks things that point at it. Check all of these:

```bash
grep -rn "why-there-is-no-lan-mode" .        # anchors, both languages
grep -rn "loopback only" packages/           # tests asserting on banner strings
```

Cross-links, anchor slugs, translated mirrors, and any test that string-matches
console output. In this case four cross-links died with the section, and the banner
string `(loopback only — no LAN)` was printed by `lifecycle.ts` — a real behavior
change, small, worth naming in the commit message.

### 6. Verify you changed only prose

```bash
bun run --filter @yaar/server test    # the suites covering the touched files
bunx prettier --write <changed files>
```

Confirm any pre-existing failures also fail on the base commit before blaming your
diff — `git stash && bun run typecheck` settles it in one step.

## What is *not* a phantom warning

The same greps surface plenty of legitimate prose. Do not cut these:

- **A one-off note tied to a real fixed bug**, where the code still looks odd because
  of it. `action-emitter.ts` says *"A late reply used to be dropped in silence"* — that
  explains why a branch exists. Deleting it invites someone to delete the branch.
- **A rule stated once.** *"Descent never adds capability."* *"Never hardcode colors."*
- **A live hazard.** *"In those two states, don't install apps you don't trust"*
  describes a configuration a user can actually be in today.

The distinguishing question:

> Does this explain the shape of the code or docs in front of me — or is it arguing
> with a reader who might have preferred a different design?

Explanation stays. Argument goes.

## Checklist

- [ ] Cluster confirmed by counting occurrences (`grep -ow`), not lines
- [ ] Kept **once**, in the one place the reader meets the topic
- [ ] Rewritten as what *is*, with a link out for anyone who wanted the alternative
- [ ] Removal history reduced to a migration note aimed at people holding the old config
- [ ] Code comments keep mechanism, drop rationale for the road not taken
- [ ] Translated mirrors updated in the same commit
- [ ] Anchors, cross-links, and string-matching tests swept
- [ ] Behavior changes (banner text, log strings) named explicitly in the commit
