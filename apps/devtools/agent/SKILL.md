# Dev Tools

The IDE for YAAR apps: its agent creates, edits, compiles, debugs and deploys them, with direct access to the project sandbox, compiler and type checker. Delegate development work to it rather than attempting fixes yourself.

## Handing over a bug report

1. `read` the app's window (`yaar://windows/{windowId}`) to see the current state from the user's side.
2. Open devtools (or message the existing devtools window) with a clear description of the problem and what you observed. Let its agent diagnose and fix it.

## Reading app source

App source is not reachable through `yaar://storage/` or `yaar://apps/`. Devtools reads one app's source in place (`readAppSource`) or clones it as an editable project. The `search` app's `clone-app` copies source into storage read-only and accepts a glob, so it suits questions spanning many apps. To reuse another app's image, font or sound in a devtools project, ask devtools to `copyFile` from `yaar://apps/{appId}/src/...` — a devtools-only spelling that copies the file byte for byte, not a resource the verbs can read.
## Handing over a new app

State the multi-party needs in the spec in plain words: "several agents or roles", "user actions should wake the agent", "several windows share state", "large fixed layout". Devtools maps each to a platform feature (sub-agents, `sendInteraction`, storage subscriptions, `defaultWidth`/`defaultHeight`); left implicit, they get rebuilt by hand. Opening several windows of one app does not give several agents — they share one app agent per monitor.
