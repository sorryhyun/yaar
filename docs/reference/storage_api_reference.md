# Storage API Reference

The Storage API provides persistent file storage accessible to AI agents via MCP tools and to frontends/apps via REST endpoints. Storage is session-independent — files written in one session are available in all subsequent sessions.

---

## Directory Layout

```
PROJECT_ROOT/
├── storage/                     # Persistent user files (git-ignored)
│   ├── temp/                    # Dropped images (auto WebP conversion)
│   ├── files/                   # Uploaded files
│   ├── mounts/                  # Virtual — maps to host directories
│   └── {app-specific}/          # App data
└── config/                      # Configuration (git-ignored)
    ├── {appId}.json             # App credentials / config
    ├── mounts.json              # Mount definitions
    ├── permissions.json         # Saved permission decisions
    ├── settings.json            # User settings
    ├── shortcuts.json           # Desktop shortcuts
    ├── hooks.json               # Event-driven hooks
    └── mcp-servers.json         # MCP server configuration
```

Default base: `PROJECT_ROOT/storage`. Override with the `YAAR_STORAGE` environment variable.

---

## MCP Tools

File I/O is handled by the 5 generic verb tools (`describe`, `read`, `list`, `invoke`, `delete`) with `yaar://storage/` URIs. `write`, `edit`, and `grep` are not separate tools — they're `invoke` actions (dispatched via `payload.action`).

**Source:** `packages/server/src/handlers/index.ts`, `packages/server/src/handlers/storage.ts`

### `read`

Read a file by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `yaar://storage/docs/readme.txt`) |
| `lines` | `string` | no | Line range to read, 1-based inclusive (e.g. `"10-20"`, `"50"`, `"100-"`) |
| `pattern` | `string` | no | Regex — returns only matching lines, with line numbers |
| `context` | `number` | no | Context lines around pattern matches (default: `0`) |
| `pdfText` | `boolean \| string` | no | PDF only: extract the text layer. `true` (or `"all"`) reads the whole document; a range like `"1-3"` scopes it. |
| `pdfPages` | `string` | no | PDF only: page range to rasterize to images, e.g. `"1-3"`, `"5"`, `"2-"` — for scanned/visual PDFs. |

**Returns (text files):** Line-numbered content as an embedded resource — the full file, or filtered by `lines`/`pattern`.

**Returns (PDF files):** View-first by default — reading a PDF with no `pdfText`/`pdfPages` returns metadata only (`pdfMeta: true`, page count, byte size) plus a hint to open it in a viewer window (`yaar://storage/` iframe content), with zero bytes ingested. Pass `pdfText` to extract the text layer (cheapest way to actually read the content), or `pdfPages` to rasterize a page range to base64 PNG images — capped at `MAX_PDF_RASTER_PAGES` (20 pages) per request.

**Returns (image files):** Base64-encoded image content with MIME type.

**Returns (binary files):** A message explaining the file can't be read as text, with a pointer to the REST API.

**Errors:** Path traversal detected, file not found. Reading a directory falls back to `list` with a note.

### `list`

List directory contents by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | Directory URI (e.g. `yaar://storage/`, `yaar://storage/docs`) |

Returns `resource_link` entries, directories first then alphabetically. Mounted directories appear as virtual entries under `yaar://storage/mounts/`. Listing a file path falls back to `read` with a note.

**Returns:** Resource links, or `"(empty)"` if the directory has no entries.

### `invoke` — write / copy / edit / grep

Dispatches on `payload.action`.

**`write`** — write a file:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `yaar://storage/docs/file.txt`) |
| `content` | `string` | yes | Content to write |
| `encoding` | `'base64'` | no | Set when `content` is base64-encoded binary (images, PDFs). Omit for text — writing binary without it stores the base64 text itself. |

Parent directories are created automatically. Overwrites existing files. Fails on read-only mounts. **Returns:** `"Written to yaar://storage/{path}"`

**`copy`** — copy bytes server-side between two `yaar://storage` URIs, without round-tripping the content through the conversation:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | Destination file URI (e.g. `yaar://storage/docs/copy.txt`) |
| `from` | `string` | yes | Source `yaar://` storage URI to copy bytes from. Either spelling works: `yaar://storage/…` or `yaar://apps/{id}/storage/…`. |

Prefer this over reading a file and writing it back when moving/duplicating content — a read/write round-trip drags the bytes through the conversation. **Returns:** `"Copied {from} → yaar://storage/{path} ({bytes} bytes)"`

**`edit`** — apply an edit to a file. Two modes:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `old_string` | `string` | no | Exact text to find (must be unique). Omit to use line mode. |
| `new_string` | `string` | yes | Replacement text |
| `start_line` | `number` | no | First line to replace (1-based). Requires line mode. |
| `end_line` | `number` | no | Last line to replace (1-based, inclusive). Defaults to `start_line`. |

**String mode** (`old_string` + `new_string`): Finds the exact match and replaces it. The match must be unique in the file.

**Line mode** (`start_line` + `new_string`): Replaces lines `start_line..end_line`. Line numbers are 1-based, matching `read` output.

Cannot mix both modes. **Returns:** `"Edited yaar://storage/{path}"`

**`grep`** — search text files under a directory URI:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | yes | Regex pattern |
| `glob` | `string` | no | Glob to filter files searched |

Searches recursively through known text file extensions. Returns up to 100 matches as JSON: `{ matches: [{ file, line, content }], truncated }`.

### `delete`

Delete a file (or directory, recursively) by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `yaar://storage/docs/draft.txt`) |

Fails on read-only mounts.

**Returns:** `"Deleted yaar://storage/{path}"`

---

## Mount System

Host directories can be mounted at `yaar://storage/mounts/{alias}/` via the `yaar://config/mounts` resource (part of the generic verb tools).

**Source:** `packages/server/src/storage/mounts.ts`, `packages/server/src/features/config/mounts.ts`

### Mount a directory

```
invoke('yaar://config/mounts', { alias, hostPath, readOnly? })
```

| Field | Type | Description |
|-------|------|-------------|
| `alias` | `string` | Mount name. Must match `/^[a-z][a-z0-9-]{0,49}$/`. Reserved: `temp`, `files`, `credentials`, `mounts`. |
| `hostPath` | `string` | Absolute path to an existing directory. Cannot be inside the storage directory. |
| `readOnly` | `boolean` | Optional, defaults to `false`. |

Requires user permission dialog. Config persisted in `config/mounts.json`.

### List mounts

```
read('yaar://config/mounts')
```

Returns `{ mounts: MountEntry[] }`.

### Unmount

```
delete('yaar://config/mounts/{alias}')
```

### Mount behavior

- Mounted directories appear as `yaar://storage/mounts/{alias}/...` in all tools (read, write, list, delete, edit)
- The virtual `mounts/` directory is injected into storage root listings when mounts exist
- Path traversal protection ensures resolved paths stay within the mount
- Read-only mounts reject write, delete, and edit operations

---

## REST API

**Source:** `packages/server/src/http/routes/files.ts`

Base URL: `/api/storage/{filePath}`

All paths are relative to the storage directory. Path traversal is blocked (HTTP 403). Read-only mounts block POST and DELETE (HTTP 403).

Every storage HTTP call also goes through the access chokepoint (`packages/server/src/http/access.ts`): `resolvePrincipal` resolves the caller to `host` (the desktop, unconfined) or `app` (an iframe token, confined to its `app.json` permissions), then `requirePermission` checks the resolved principal against the storage URI equivalent of the requested path and verb (`read`/`list`/`invoke`/`delete`). This can independently 403 with `"Not permitted: {verb} {uri}"` for an app lacking the grant, on top of the path-traversal and read-only-mount checks above. For app-scoped storage, a request path under `apps/self/` is rewritten to `apps/{appId}/` for the calling app (`storageUriFor` in `access.ts`) before the permission check and the actual file resolution, so an app can address its own storage as `self` without needing its literal id.

### GET — Serve file

```
GET /api/storage/documents/report.pdf
```

Returns the raw file with `Content-Type` inferred from the extension (see [MIME types](#mime-types)). Returns `Cache-Control: no-cache`.

**Status codes:** 200, 404 (not found), 403 (path traversal, or app lacks permission for the resource).

### GET — List directory

```
GET /api/storage/documents/?list=true
```

Returns a JSON array of `StorageEntry` objects:

```json
[
  { "path": "documents/readme.txt", "isDirectory": false, "size": 1024, "modifiedAt": "2025-01-01T12:00:00.000Z" },
  { "path": "documents/images", "isDirectory": true, "size": 0, "modifiedAt": "2025-01-01T12:00:00.000Z" }
]
```

### POST — Write file

```
POST /api/storage/notes/memo.txt
Body: <raw file content>
```

Creates parent directories if needed. Binary-safe (supports any file type).

**Maximum body size:** 50 MB. Returns HTTP 413 if exceeded.

**Response:** `{ "ok": true, "path": "notes/memo.txt" }`

### DELETE — Remove file

```
DELETE /api/storage/documents/old.pdf
```

**Response:** `{ "ok": true, "path": "documents/old.pdf" }`

**Status codes:** 200, 500 (file not found or delete failed — `errorResponse()` defaults to 500 when no status is passed, unlike GET's explicit 404), 403 (path traversal, read-only mount, or app lacks permission for the resource).

---

## PDF Rendering Endpoint

```
GET /api/pdf/{storagePath}/{pageNumber}
```

Renders a single PDF page as a PNG image at 1.5× scale via poppler.

**Example:** `GET /api/pdf/documents/paper.pdf/1` returns page 1 as `image/png`.

**Status codes:** 200, 400 (not a PDF), 404 (page not found).

---

## Types

**Source:** `packages/server/src/storage/types.ts`, `packages/server/src/storage/mounts.ts`

```typescript
interface StorageEntry {
  path: string;          // Relative to storage/
  isDirectory: boolean;
  size: number;          // Bytes (0 for directories)
  modifiedAt: string;    // ISO 8601
}

interface StorageReadResult {
  success: boolean;
  content?: string;
  images?: StorageImageContent[];
  totalPages?: number;
  pdfMeta?: boolean;     // Set for PDFs read without pdfText/pdfPages — metadata only, no images
  error?: string;
}

interface StorageWriteResult {
  success: boolean;
  path: string;
  error?: string;
}

interface StorageListResult {
  success: boolean;
  entries?: StorageEntry[];
  error?: string;
}

interface StorageDeleteResult {
  success: boolean;
  path: string;
  error?: string;
}

interface StorageGrepMatch {
  file: string;
  line: number;
  content: string;
}

interface StorageGrepResult {
  success: boolean;
  matches?: StorageGrepMatch[];
  truncated?: boolean;
  error?: string;
}

interface StorageImageContent {
  type: 'image';
  data: string;          // Base64 encoded
  mimeType: string;
  pageNumber?: number;
}

interface MountEntry {
  alias: string;
  hostPath: string;      // Absolute path
  readOnly: boolean;
  createdAt: string;     // ISO 8601
}

interface ResolvedPath {
  absolutePath: string;
  readOnly: boolean;
}
```

---

## Storage Manager

**Source:** `packages/server/src/storage/storage-manager.ts`

Core functions used by both MCP tools and REST routes:

| Function | Signature | Description |
|----------|-----------|-------------|
| `storageRead` | `(filePath: string, opts?: StorageReadOptions) → Promise<StorageReadResult>` | Read file; PDFs return metadata only unless `opts.pdfText`/`opts.pdfPages` are given, images to base64, text with line numbers |
| `storageWrite` | `(filePath: string, content: string \| Buffer) → Promise<StorageWriteResult>` | Write file; creates parent dirs; respects read-only mounts |
| `storageList` | `(dirPath?: string) → Promise<StorageListResult>` | List directory; injects virtual `mounts/` entry at root |
| `storageDelete` | `(filePath: string) → Promise<StorageDeleteResult>` | Delete file or directory (recursively); respects read-only mounts |
| `storageGrep` | `(dirPath: string, pattern: string, glob?: string) → Promise<StorageGrepResult>` | Regex search across text files under a directory; max 100 matches |
| `ensureStorageDir` | `() → Promise<void>` | Create `storage/` if missing |
| `resolvePath` | `(filePath: string) → ResolvedPath \| null` | Resolve storage-relative path; checks mounts first, then default storage dir |
| `resolvePathAsync` | `(filePath: string) → Promise<ResolvedPath \| null>` | Same as `resolvePath` but resolves symlinks before the containment check |
| `configRead` | `(filePath: string) → Promise<StorageReadResult>` | Read from `config/` directory |
| `configWrite` | `(filePath: string, content: string) → Promise<StorageWriteResult>` | Write to `config/` directory |

### Path Resolution

All operations resolve paths in order:

1. **Mount check** — if path starts with `mounts/{alias}/...`, resolve against the mount's `hostPath`
2. **Default** — resolve against `STORAGE_DIR`
3. **Traversal check** — reject if resolved path escapes the target directory

### File Type Handling

| File Type | Behavior |
|-----------|----------|
| Text files (`.txt`, `.md`, `.ts`, `.json`, etc.) | Read as UTF-8, line-numbered output |
| PDF (`.pdf`) | View-first: returns metadata only (page count, byte size) by default. `pdfText` extracts the text layer; `pdfPages` rasterizes a page range to PNG via poppler (capped at 20 pages) |
| Images (`.png`, `.jpg`, `.gif`, `.webp`) | Return as base64 image content |
| Other binary | Return explanation message, point to REST API |

---

## MIME Types

**Source:** `packages/server/src/config.ts`

| Extension | Content-Type |
|-----------|-------------|
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.ico` | `image/x-icon` |
| `.pdf` | `application/pdf` |
| `.json` | `application/json` |
| `.txt` | `text/plain` |
| `.html` | `text/html` |
| `.css` | `text/css` |
| `.js` | `application/javascript` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.csv` | `text/csv` |
| `.zip` | `application/zip` |
| `.md` | `text/markdown` |
| `.xml` | `application/xml` |
| `.mp3` | `audio/mpeg` |
| `.mp4` | `video/mp4` |
| `.wasm` | `application/wasm` |
| `.ttf` | `font/ttf` |
| `.woff` | `font/woff` |
| `.woff2` | `font/woff2` |

Unknown extensions fall back to `application/octet-stream`.

## Upload Size Limit

`MAX_UPLOAD_SIZE` (50 MB) caps every request body the server reads, not just storage writes. It is applied via `readBodyWithLimit()` in the `/api/storage`, `/api/verb`, `/api/bridge`, `/api/proxy`, `/api/browser`, and `/api/dev` routes. Exceeding it returns HTTP 413.

---

## Frontend Integration

### File Upload

**Source:** `packages/frontend/src/lib/uploadImage.ts`

Images dropped onto the UI are converted to WebP and uploaded to `storage/temp/`:

```typescript
const res = await apiFetch(`/api/storage/${storagePath}`, {
  method: 'POST',
  body: file,
});
```

Non-image files are uploaded to `storage/files/` with sanitized filenames.

### Iframe SDK

**Source:** `packages/shared/src/iframe-scripts/storage-sdk.ts` (`IFRAME_STORAGE_SDK_SCRIPT`)

Apps access storage via `@bundled/yaar` imports (`appStorage` for app-scoped, `storage` for raw). The underlying SDK is injected automatically.

`storage` (raw, `window.yaar.storage` — dispatches straight to `/api/storage/*`):

| Method | Signature | Description |
|--------|-----------|-------------|
| `save` | `(path, data) → Promise<{ok, path}>` | Write file. Accepts `string`, `Blob`, `ArrayBuffer`, `Uint8Array`. |
| `read` | `(path, options?) → Promise<*>` | Read file. `options.as`: `'text'`, `'json'`, `'blob'`, `'arraybuffer'`, or `'auto'` (default, guesses from Content-Type). |
| `list` | `(dirPath?) → Promise<StorageEntry[]>` | List directory contents. |
| `remove` | `(path) → Promise<{ok, path}>` | Delete file. |
| `url` | `(path) → string` | Get the HTTP URL: `/api/storage/{path}`. |

`appStorage` (app-scoped, `packages/compiler/src/shims/yaar/app-storage.ts` — wraps the `yaar://apps/self/storage/` verbs, a different shape from `storage` above):

| Method | Signature | Description |
|--------|-----------|-------------|
| `save` | `(path, content, options?) → Promise<void>` | Write a string; `options.encoding` is `'utf-8'` (default) or `'base64'`. |
| `trySave` | `(path, content, options?) → Promise<boolean>` | `save()` that reports failure instead of throwing — resolves whether the write landed. Toasts the failure (throttled to once per 5s per path) unless `options.onError` is given. |
| `read` | `(path) → Promise<string>` | Read file as text. |
| `readJson` | `(path) → Promise<T>` | Read and parse JSON; throws if the file is missing or unparseable. |
| `readJsonOr` | `(path, fallback) → Promise<T>` | `readJson`, but returns `fallback` instead of throwing. |
| `readBinary` | `(path) → Promise<{data, mimeType, encoding}>` | Read raw bytes; `encoding` is `'base64'` for image reads, `'text'` otherwise. |
| `readBlob` | `(path) → Promise<Blob>` | `readBinary`, decoded into a `Blob`. |
| `list` | `(dirPath?) → Promise<YaarAppStorageEntry[]>` | Each entry is `{ path, isDirectory, uri, mimeType? }` — not the raw `storage.list()` shape above. |
| `remove` | `(path) → Promise<void>` | Delete file. |

---

## Configuration Storage

Separate from user storage, configuration files live in `config/` (override with `YAAR_CONFIG`). Configuration is addressable via `yaar://config/{section}` URIs — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

### Settings

**Source:** `packages/server/src/storage/settings.ts`

Stored at `config/settings.json`.

```typescript
interface Settings {
  onboardingCompleted: boolean;
  userName: string;
  language: string;
  provider: 'auto' | 'claude' | 'codex';
  wallpaper: string;
  accentColor: string;
  iconSize: 'small' | 'medium' | 'large';
  theme: 'dark' | 'light';
  allowAllApps: boolean;
}
```

| Function | Description |
|----------|-------------|
| `readSettings()` | Read current settings (merged with defaults) |
| `updateSettings(partial)` | Merge partial updates and persist |
| `getLanguageLabel(code)` | Human-readable label for a language code |
| `LANGUAGE_CODES` | Supported language code list |

Updated via `invoke('yaar://config/settings', { ... })`.

### Permissions

**Source:** `packages/server/src/storage/permissions.ts`

Stored at `config/permissions.json`. Records "allow" / "deny" decisions for MCP tool confirmations.

| Function | Description |
|----------|-------------|
| `checkPermission(toolName, context?)` | Look up a saved decision |
| `savePermission(toolName, decision, context?)` | Persist a decision |
| `clearPermission(toolName, context?)` | Remove a saved decision |
| `clearAllPermissions()` | Remove all saved decisions |

### App Config

Stored at `config/{appId}.json`. Managed via verb tools: `read('yaar://config/app')` (all apps) or `read('yaar://config/app/{appId}')` (one app), `invoke('yaar://config/app/{appId}', { config })` to merge config, `delete('yaar://config/app/{appId}')` to remove.

---

## Limits

| Limit | Value |
|-------|-------|
| Max upload size (REST) | 50 MB |
| Max PDF rasterize pages (`pdfPages` per request) | 20 |
| PDF render scale | 1.5× |
