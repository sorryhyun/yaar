---
name: uri-reference
description: Read before writing code against a yaar:// URI — what devtools holds, and what is refused here.
audience: agent
---

## URI Reference

Verify a URI before writing code against it with
`command({ command: "inspectUri", params: { uri } })`. Describe works without holding the
permission, so it is the cheap way to check any path not listed below — `yaar://windows/`,
`yaar://skills/{topic}` and the rest.

| URI | Verbs | Notes |
|-----|-------|-------|
| `yaar://apps/` | describe, list | Installed apps. `yaar://apps/{id}` gives metadata + protocol + skill — **not source**. |
| `yaar://storage/` | describe, read, list, invoke, del | The **whole** tree — the Shared Storage section of your prompt. `invoke` actions: `write`, `edit`, `grep`. Every app already holds `shared/` — never add `yaar://storage/shared/` to an app.json you write. |
| `yaar://http` | describe, invoke | HTTP proxy (SSRF-protected, domain allowlist). |

`yaar://session/` and `yaar://` itself are session-principal-only — an app agent (this one
included) gets a 403. Devtools holds no permission for `yaar://config/` or `yaar://history/`
either, so neither is usable here even though both exist elsewhere.
