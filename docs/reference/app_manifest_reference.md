# App Manifest Reference (`app.json`)

**Source:** `packages/server/src/features/apps/manifest.ts`, `packages/server/src/features/apps/discovery.ts`, `packages/server/src/features/dev/deploy.ts`, `packages/server/src/features/apps/capabilities.ts`, `packages/compiler/src/compile.ts`, `packages/compiler/src/bundled/three-renderer.ts`

Every key an app's `app.json` can carry: its type, what happens when it is absent, and what reads
it. For why the manifest is shaped this way (gated SDKs, grants, where apps live), see
[Apps: From Source to a Running Window](../architecture/app_pipeline.md).

- The app's **id is its folder name**. The manifest's `appId` key must agree with it, but the
  folder is what every lookup uses.
- The server reads the file once, through `normalizeManifest()` in `manifest.ts`. That gives
  the *declared* manifest. `discovery.ts` then narrows it to what the app's source (bundled or
  installed) and the user's install-time grant allow. That gives the *effective* manifest,
  which is what `read('yaar://apps/{appId}')` returns.
- The compiler reads four keys (`name`, `bundles`, `three`, `links`) straight off the file, and
  protocol extraction reads `appId`. These keys take effect on the next compile. Because
  `app.json`'s hash is in the build manifest, editing any of them makes the app stale.

---

## Parsing rules

| Input | Result |
|---|---|
| File missing, not JSON, or not a JSON object | Treated as no manifest: every key takes its default |
| Unknown key | Ignored by every reader. It is kept in the raw object and carried through clone and deploy |
| Known key with the wrong type | Treated as absent. There is no error and no warning |
| List key with some malformed entries | The well-formed entries are kept, the rest are dropped |
| Empty string for `appId`, `description` or `icon` | Treated as absent |

Parsed manifests of installed apps are cached by file identity (inode, size, mtime) and re-read
when that changes. A file written within the last 2 s is always re-read, so an edit made by hand
in a checkout is picked up without a restart.

---

## Fields

### Identity and display

| Field | Type | When absent | Read by / effect |
|---|---|---|---|
| `appId` | `string` | No id check at compile | Protocol extraction fails the build unless `defineApp({ id })` equals it. Deploy refuses a project whose `appId` differs from the deploy target, and **stamps** it on every deploy. It should equal the folder name. Nothing else compares it with the folder |
| `name` | `string` | Listings show the id title-cased (`my-app` → `My App`). The compiled page's `<title>` is `App` | App listings, `describe`, and the compiled page's `<title>` |
| `description` | `string` | None | App listings (`GET /api/apps`, `list('yaar://apps')`) and `describe` |
| `icon` | `string` (emoji) | None, or an image file if one exists | An image file named `icon` with extension `.png`, `.webp`, `.jpg`, `.jpeg`, `.gif` or `.svg` in the app folder takes precedence. It is served at `/api/apps/{appId}/{file}` |
| `version` | `string` | None | `describe`. Publishing refuses unless this is strictly newer than the published version. Only the numeric `major.minor.patch…` core is compared (pre-release and build suffixes are ignored), and a version that cannot be parsed is allowed through |
| `author` | `string` | None | `describe` |
| `kind` | `"system"` | `"app"` | **Bundled apps only.** On an installed app it reads as `"app"`. A system app cannot be uninstalled and cannot be replaced by a marketplace install. Its iframe token carries `systemApp`, which admits it to session-principal doors (`yaar://session/*`) |

### Launch and window

| Field | Type | When absent | Read by / effect |
|---|---|---|---|
| `run` | `string` | `yaar://apps/{appId}` if `dist/index.html` exists, otherwise no iframe entry | The iframe entry. A relative path resolves to `yaar://apps/{appId}/{run}`. A value starting with `/` is used as-is. Deploy sets it to `dist/index.html` whenever it ships a compiled app |
| `createShortcut` | `boolean` | `true` | `false` means no desktop shortcut is created, and any existing one is removed at the next deploy, install or restore. The monitor agent's app roster marks the app `[system]`. The legacy `"hidden": true` means the same thing (see [Legacy keys](#legacy-and-retired-keys)) |
| `variant` | `"widget"` \| `"panel"` | Standard window | Applied to every window of the app. Any other value reads as standard |
| `dockEdge` | `"top"` \| `"bottom"` | `"bottom"` for a panel | The screen edge a `panel` window docks to |
| `frameless` | `boolean` | `false` | Only the literal `true` enables it: the window is drawn without its chrome |
| `windowStyle` | `object` (CSS properties) | None | Spread onto the window frame's style *after* its position and size, so it overrides them. Values are not validated |
| `defaultWidth` / `defaultHeight` | `number` (px) | The user's `windowSize` setting | Initial size. The order of precedence is the size in the `create` call, then these fields, then the user's setting |

### Agent

| Field | Type | When absent | Read by / effect |
|---|---|---|---|
| `agentType` | `string` | Sonnet tier | The **model** the app agent runs on: `"haiku"`, `"sonnet"`, `"opus"`, or any full model id. Under Codex, `opus` maps to `gpt-5.6-sol`, `sonnet` and `haiku` to `gpt-5.6-terra`, and an unknown id falls back to the Codex default. `FABLE=1` pins every app agent to Opus whatever this says (`agents/profiles/model-tiers.ts`) |
| `agent` | `{ prompt?, hint?, skill? }` (string paths) | `agent/prompt.md`, `agent/hint.md`, `agent/SKILL.md` | Where the agent docs live, relative to the app folder. An absolute path, or one containing `..`, is ignored and the default is used. Clone and deploy copy the docs from these paths. Read through `agentDocPaths()` in `discovery.ts`, not `normalizeManifest` |
| `messaging` | `"all"` | Monitor and user only | Gives the app agent `direct_message` to other apps' agents and windows |
| `controls` | `(string \| { appId, commands?, minimized? })[]` | None | **Bundled apps only**; on an installed app it is dropped. Lists other apps this app's agent may `describe`/`query`/`command` by passing their `appId`. `commands` restricts the target to the named commands (omitted means all). If the target has no window on the caller's monitor, one is opened. `minimized: true` opens it minimized |

### Capabilities

| Field | Type | When absent | Read by / effect |
|---|---|---|---|
| `permissions` | `(string \| { uri, verbs? })[]` | Only the implicit grants below | URIs the app's iframe (and its agent, for storage) may reach beyond itself. A string entry allows every verb. An object entry allows only `verbs`. **If `verbs` is present but not an array of strings, the whole entry is dropped (it grants nothing); an unknown verb name is ignored. Either is logged with the app id, refused by deploy, and fails `check:apps`.** On an installed app, any entry reaching into another app's private storage is capped to the shared tree. Carried on the iframe token. Matching rules: [URI Reference → Permission Enforcement](./uri_reference.md#permission-enforcement) |
| `bundles` | `string[]` | No gated SDKs | Gated `@bundled/*` SDKs the app may import. The gated set is every registry name starting with `yaar-`: `yaar-dev`, `yaar-web`, `yaar-ml`, `yaar-media`. Enforced by the bundler, by the typecheck, and at runtime by the server doors those SDKs use (the list rides on the iframe token). Shown in the install dialog. Non-string entries are dropped |
| `streams` | `string[]` | None | Streamable sources the app may subscribe to. The only source is `"agents"`, which covers `yaar://agents/{id}/stream`. **Approved at install**: see [Entitlement by source](#entitlement-by-source) |
| `subagents` | `{ max: number }` | No sub-agents | How many sub-agents the app may run per (monitor, app). `max` is clamped to 16. A `max` that is not an integer, or is ≤ 0, reads as absent. Extra keys are ignored. **Approved at install** |

### Build-time

The compiler reads these straight off the file. `normalizeManifest` does not type them.

| Field | Type | When absent | Read by / effect |
|---|---|---|---|
| `three` | `"webgpu"` | WebGL build | Only the exact string `"webgpu"` enables it. `@bundled/three`, and every bare `three` an addon imports, then resolve to the WebGPU build, and `@bundled/three/webgpu` and `@bundled/three/tsl` become importable. Without it those two imports are refused by both the build and the typecheck. It is deliberately not a `bundles` entry: it grants nothing |
| `links` | `{ base: string }` | None | The site that relative hrefs in the app's rendered content belong to. It is baked into `dist/index.html` as `window.__yaar_links__`, and the link guard resolves anchors against it. `base` must parse as an `http:` or `https:` URL, otherwise the key is ignored. See [`apps/CLAUDE.md`](../../apps/CLAUDE.md#links-out-of-an-app) |

---

## Implicit grants

These need no `permissions` entry. Declaring one of them changes nothing.

| Reach | Granted by |
|---|---|
| `yaar://apps/self/storage/`, `yaar://apps/self/db/`, `yaar://apps/self/agents/` | Every app token (`SELF_GRANTS` in `http/iframe-tokens.ts`). `self` always resolves to the token's own app id. Spawning sub-agents still needs `subagents` |
| `yaar://storage/shared/` (the commons) | Every app token. A declared entry for it is left out of the install dialog |
| `yaar://system/ytdlp` | The `yaar-media` bundle. A `permissions` entry naming it grants nothing and is left out of the install dialog |
| `describe` on any URI | Always allowed (metadata only) |

---

## Entitlement by source

A bundled app is taken at its word. An installed (marketplace) app's manifest is a request.

| Key | Bundled app (`apps/`) | Installed app (user-apps root) |
|---|---|---|
| `kind: "system"` | Honored | Reads as `"app"` |
| `controls` | Honored | Dropped |
| `permissions` | Honored | Honored, with cross-app storage capped to the shared tree. Prompted at install |
| `bundles` | Honored | Honored. Prompted at install |
| `streams` | Honored | Only the declared values that are also in the recorded grant |
| `subagents` | Honored | `max` is the lower of the declared value and the granted value. No grant means none |

Grants are recorded in `config/app-grants.json` when the user accepts the install dialog. The
dialog lists permissions, bundles, streams and a sub-agent ceiling. On an update it lists only
what the new manifest *adds*: a new permission, bundle or stream, or a higher `max`. An install
with nothing to ask about skips the dialog. The dialog is also skipped during onboarding and when
the `allowAllApps` setting is on, and the grant is recorded anyway. A grant that predates the
dialog, or a declined one, holds nothing.

---

## What deploy writes

Deploy (`features/dev/deploy.ts`) builds the installed `app.json` as follows:

1. Start from the installed `app.json` (if any), then apply the project's `app.json` over it.
   The project's keys win.
2. Apply the deploy arguments `name`, `icon` and `description` when given.
3. Stamp `appId` with the deployed id. Deploy refuses if the project declares a different one.
4. Set `run` to `dist/index.html` if a compiled app is shipped.
5. Fill defaults for missing keys: `name` → the id title-cased, `icon` → `🎮`,
   `version` → `1.0.0`, `author` → `YAAR`.
6. Delete `hidden`, `appProtocol` and `protocol`.

Unknown keys pass through untouched.

---

## Legacy and retired keys

| Key | Status |
|---|---|
| `hidden` | Legacy. `true` is still read as `createShortcut: false`. Deploy rewrites `hidden: true` as `createShortcut: false`. Use `createShortcut` |
| `personas` | Retired spelling of `subagents`. Not read. An app that still uses it gets no sub-agents, the server logs a warning naming the rename, and the spawn refusal says "rename", not "add" |
| `appProtocol`, `protocol` | Not read. Deploy strips them. An app opts into the protocol by calling `defineApp()`, and the manifest is `dist/protocol.json` |
| `id` | Not read. The key is `appId` |

---

## Example

```json
{
  "appId": "photo-lab",
  "name": "Photo Lab",
  "icon": "🧪",
  "description": "Edit and batch-process images",
  "version": "1.2.0",
  "author": "you",
  "run": "dist/index.html",
  "permissions": [
    "yaar://http",
    { "uri": "yaar://storage/photos/", "verbs": ["read", "list"] }
  ],
  "bundles": ["yaar-ml"],
  "agentType": "haiku",
  "defaultWidth": 960,
  "defaultHeight": 640
}
```
