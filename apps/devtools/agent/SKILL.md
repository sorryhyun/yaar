# Dev Tools

The IDE for YAAR apps: its agent creates, edits, compiles, debugs and deploys them, with direct access to the project sandbox, compiler and type checker. Delegate development work to it rather than attempting fixes yourself.

## Handing over a bug report

1. `read` the app's window (`yaar://windows/{windowId}`) to see the current state from the user's side.
2. Open devtools (or message the existing devtools window) with a clear description of the problem and what you observed. Let its agent diagnose and fix it.

## Reading app source

App source is not reachable through `yaar://storage/` or `yaar://apps/`; it has to be cloned first. Devtools clones one app as an editable project. The `search` app's `clone-app` copies source into storage read-only and accepts a glob, so it suits questions spanning many apps.