# Crystallization — compiling repeated flows into apps

**Status:** proposal. Nothing below is implemented; the reload cache it critiques still exists at `packages/server/src/reload/`.

YAAR pays a frontier-model turn for everything interesting it does, every time it does it. The
reload cache was the first attempt to claw some of that back, and it is honest to call it a
failure: it is almost never hit. This document explains why, and proposes the replacement — a
mechanism that turns a *task the user does repeatedly* into an app in `user-apps/`, so the
second-similar time (not just the second-identical time) is fast, cheap, and mostly or entirely
model-free.

The name is **crystallization**: dissolved, expensive, live-agent behavior precipitating into a
solid, reusable artifact.

## Why the reload cache missed

The reload cache memoizes **outputs**, keyed on **input equality** (fingerprints). Real usage
almost never repeats an input exactly — same task, different CSV; same chart, different week;
same bug-report ritual, different bug. Input-equality is the wrong axis: what repeats in practice
is the *shape* of the task, not its bytes.

> A cache asks at serving time: "have I seen this input before?" — almost never true.
> Crystallization asks **once, at build time**: "what is this request an instance of?" — and
> stores the answer as *code with parameters*. After that, sameness no longer needs to be exact,
> because the variation has a name and a slot.

The model moves from serving time to build time. That is the entire difference, and everything
below is machinery to make it safe.

## Three kinds of variation

Not everything crystallizes the same way. The running example throughout is the flow that
motivated this document — the ritual that plays out whenever a YAAR bug surfaces during app
development:

```
user → monitor → devtools (spots the bug) → monitor → user (confirms)
     → monitor → devtools (gathers evidence) → monitor → github app → issue filed
```

The choreography repeats every time. The contexts and timings never do.

| Kind | What varies | Example | Crystallizes into |
|---|---|---|---|
| **Parametric** | Values only — the skeleton is fixed | "chart this CSV" with a different file each time | Fully compiled app: UI + verb script, zero model calls on replay |
| **Contextual** | The content of judgment steps — but the *route* is fixed | The bug-report flow: every bug is different, but who-talks-to-whom, the destinations, and the approval point never change | Partially compiled flow: verb steps + **agentic holes** with scoped context |
| **Structural** | The flow itself | Open-ended exploration | Nothing. Stays interpreted. Not a target. |

The bug-report flow is the design driver precisely because it is **contextual**, and neither a
cache nor a pure verb-script can touch it. Look at what is actually constant in it:

- the **route** — monitor delegates to devtools, evidence comes back, github app files
- the **destinations** — which repo, what an issue looks like, which labels
- the **checkpoint** — the user approves the draft before anything leaves the machine

And what varies: the bug, the evidence, the wording, the timing. The constant part is code. The
varying part is either a parameter (timing, evidence URIs) or a *small, scoped* model call (write
the issue body from this evidence). Crystallization's job is to make that cut.

## Execution model: interpreted → compiled → deopt

Borrow the JIT vocabulary, because YAAR can implement it literally:

| Tier | What runs | Cost | Flexibility |
|---|---|---|---|
| **Interpreted** | The monitor agent, live, full context tape — today's behavior | High, every time | Unbounded |
| **Compiled** | A crystallized app: verb steps free, agent steps scoped | Zero to small, bounded | The parameterized common case |
| **Deopt** | The app's own app agent, carrying the distilled intent + original trace | One agent turn | Handles off-script requests — and can **patch the app** to cover them next time |

The deopt tier is the load-bearing decision. Generalizing from one or two traces means the
parameter guesses will sometimes be wrong. The design does not try to prevent that — it makes
being wrong **cheap**: a bad guess is one fallback to the app agent and a re-crystallization, not
a broken app. This is what the reload cache never had: a recovery path other than a silent miss.

Cost accounting, honestly: a contextual flow still spends tokens on its agentic holes. The win is
that today, every rerun re-derives the entire choreography inside the monitor agent's full
context tape — several turns, several tool round-trips, the user re-explaining the ritual — while
a crystallized flow spends model tokens only inside holes that receive a distilled prompt plus
the outputs of prior steps, nothing else. The routing itself is free, and the flow runs off the
monitor queue instead of occupying it.

## Anatomy of a crystallized flow

Four step kinds:

| Step | What it is | Cost | In the bug-report flow |
|---|---|---|---|
| **verb** | A deterministic `yaar://` call | Free | Read devtools state; snapshot the window; invoke the github app |
| **agent** | A scoped one-shot model call: distilled prompt + prior-step outputs only | Bounded | "Distill this evidence into `{title, body, repro, labels}`" |
| **checkpoint** | A window presented to the user; the flow blocks until response | Free | The issue draft, editable, with a File button |
| **trigger** | What starts the flow | — | Explicit invoke in v1 (see Open Questions for hooks) |

Checkpoints deserve a note: windows are already YAAR's input surface, and sessions already
survive disconnect. A checkpoint is therefore naturally **resumable** — the draft window can sit
on the desktop until the user returns. This is how the flow absorbs the "timings differ" part of
the variation without any scheduling machinery.

### The artifact is an app folder — nothing new

```
user-apps/yaar-bug-report/
  app.json          ← permissions = exactly the verbs the source trace used
  agent/prompt.md   ← distilled intent + the original trace: the deopt context
  src/main.ts       ← the flow: checkpoint UI + verb steps + agent-step calls
  dist/index.html
```

Three existing mechanisms do most of the work:

1. **Least privilege for free.** The crystallizer saw exactly which URIs and verbs the live
   agents touched, so the generated `app.json` declares exactly those scopes — and the existing
   install-consent dialog gates them.
2. **`controls` already expresses cross-app flows.** Devtools driving the Browser app is the
   precedent; the bug-report flow driving the github app is the same shape.
3. **The app agent is already the deopt tier.** App agents exist per `monitorId::appId`, spin up
   on interaction, and are reclaimed when idle. `agent/prompt.md` is already the mechanism for
   giving one a purpose.

Flows are **code, not a declarative DSL**. Apps are already code, the compiler already exists,
and a `flow.json` interpreter would be a second runtime that grows conditionals until it becomes
a worse programming language. The one genuinely new capability is the **agent step**: an app
needs a door through which to request a one-shot, scoped model call. The `subagent` MCP namespace
(`SUB_AGENT_MCP_SERVER`, `agents/profiles/sub-agent.ts`) already exists for agent-spawned
subagents; whether flows ride that with an app-scoped door (e.g.
`invoke('yaar://apps/self/agent', { task, inputs })`) or message their own app agent is an open
question below — but either way it is a narrow addition to an existing mechanism, not a new
subsystem.

## Worked example: `yaar-bug-report`

Today, interpreted: four-plus monitor turns, two devtools round-trips, the user steering each
hop, full context on every turn. Crystallized:

| # | Step | Kind | Notes |
|---|---|---|---|
| 1 | User invokes the app (or tells the monitor "file this bug" and the monitor invokes it) | trigger | |
| 2 | Gather evidence: session-log excerpt, devtools error state, window snapshot | verb | Parameters: which window, which time range |
| 3 | Distill evidence → structured draft `{title, body, repro, labels}` | agent | Scoped: sees only step 2's outputs |
| 4 | Present the draft; user edits and approves | checkpoint | Resumable; sits on the desktop |
| 5 | File the issue via the github app | verb | Via declared `controls` |
| 6 | Notify with the issue link | verb | |

Deopt example: the user says "actually this one is the *app's* bug, not YAAR's." That is outside
the flow's parameters, so the app agent takes over — and on re-crystallization the flow may gain
a routing parameter (`target: yaar | app`) it did not have before. Wrong generalizations heal.

## How a flow gets born

**1. Trigger for crystallization: explicit only, in v1.** A pin / "save this as an app" gesture
on a window, or the user saying "make this reusable." No similarity miner. The user knows better
than any detector when a ritual is worth keeping, and this skips the hardest ML problem in the
design. A background miner over session logs that *suggests* candidates is a later, additive
layer — and it also solves its own data problem, because two traces of the same task make the
variation self-identifying.

**2. Trace assembly — the real plumbing item.** The bug-report flow spans **three agents**
(monitor, devtools, github). Session logs are per-session JSONL; cutting one flow's trace out of
interleaved multi-agent activity requires a causal thread — a request id propagated through
agent-to-agent messaging so "which verb calls, by which agent, served which originating request"
is a query, not an inference. This is Phase 0, and it is independently valuable (session-log
debugging wants it too).

**3. Generalization — the one expensive step.** An app-dev-class subagent takes the trace and
makes three decisions:

- **Parameters:** values that flowed from the user's message into verb args become inputs; file
  paths become drop targets; dates and ranges become controls.
- **Verb vs. hole:** steps whose outputs are a structural function of prior steps' data become
  verbs; steps that produced novel prose or judgment become agent steps. With two traces, the
  cut is nearly mechanical — outputs that diverge in unstructured ways mark the holes. With one
  trace it is a model's guess, insured by deopt.
- **Data out, never baked in.** The trace contains the user's actual data; the generated app
  must re-read from `yaar://storage/...` at runtime. This is a correctness rule and, later, what
  makes a crystallized app shareable.

**4. Self-verification.** Compile, then replay the app against the source trace's inputs —
devtools driving the Browser app, exactly as app-dev verification works today — with the agent
steps **mocked by the trace's recorded outputs**. This checks the deterministic skeleton
independently of the model. An app that cannot reproduce the session it came from does not get
installed.

**5. Greenhouse lifecycle.** Crystallized apps will be numerous and mostly disposable, and
sprawl is the failure mode that gets the feature turned off — the way exact-match misses got the
reload cache ignored. So: they land in a staging namespace (a **greenhouse**), get promoted to a
real dock presence only after repeated use, and are garbage-collected when untouched. The
app-agent idle-reclaim policy is the precedent.

## Non-goals

- **No similarity miner in v1.** Explicit gesture only, per above.
- **No sharing of crystallized apps yet.** The data-out rule keeps the door open; Market
  distribution is a separate proposal.
- **No scheduling.** "Run this flow every morning" is the daemon-tier proposal, not this one.
  Flows are trigger-agnostic by construction so that proposal can plug in.
- **Not a reload-cache replacement in code.** Orthogonal mechanisms; the reload cache can be
  retired or kept independently.

## Open questions

1. **The agent-step door.** One-shot subagent (context hygiene: each hole sees only its inputs)
   vs. the app's own app agent (simpler: the mechanism fully exists, but context accumulates
   across steps and runs). Leaning one-shot, contract to be confirmed against
   `mcp/sub-agent/`.
2. **Hook-triggered flows.** Today `tool_use` hooks can only emit `os_action`s and `interaction`
   is `launch`-only — so a hook cannot start a flow. Auto-triggering (e.g. on a devtools error
   pattern) needs either `interaction` on `tool_use` or a new `flow` action type. Deferred past
   v1; explicit triggers first.
3. **Checkpoint expiry.** A resumable draft window is right for the bug-report flow, but flows
   over volatile data may need stale-checkpoint semantics (expire? re-run the gather step on
   resume?).
4. **Invisible tiering.** The user should not need to know whether a request hit the compiled
   path or deopted to the agent — the app must feel like one thing that is sometimes instant. If
   deopt is visible and clunky, users will route around the app back to the monitor agent, and
   the flywheel stalls. This is a UX requirement as binding as any of the mechanics.

## Phasing

| Phase | Deliverable | Unlocks |
|---|---|---|
| **0** | Causal request threading across agents in session logs | Trace assembly; better log debugging generally |
| **1** | Explicit pin → **parametric** apps (single window, single agent, verbs only) | The flywheel exists end-to-end; validates trace → generalize → verify → greenhouse |
| **2** | **Contextual** flows: agent steps + checkpoints + `controls`; canonical target: `yaar-bug-report` | The class of repetition that actually occurs |
| **3** | Miner suggestions; greenhouse promotion/GC tuning | Crystallization without the user asking |

Phase 1 is deliberately modest — its point is to prove the pipeline, not to be useful on its
own. Phase 2 is where the proposal earns its keep, and `yaar-bug-report` is the acceptance test:
when a YAAR bug surfaces and filing it well costs one scoped model call and one click, the
mechanism works.
