# Dev Tools

The IDE for YAAR apps: its agent creates, edits, compiles, debugs and deploys them, with direct access to the project sandbox, compiler and type checker.

## Handing over a new app

State the multi-party needs in the spec in plain words: "several agents or roles", "user actions should wake the agent", "several windows share state", "large fixed layout". Devtools maps each to a platform feature (sub-agents, `sendInteraction`, storage subscriptions, `defaultWidth`/`defaultHeight`); left implicit, they get rebuilt by hand. Opening several windows of one app does not give several agents — they share one app agent per monitor.
