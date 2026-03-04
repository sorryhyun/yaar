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
    └── hooks.json               # Event-driven hooks
```

Default base: `PROJECT_ROOT/storage`. Override with the `YAAR_STORAGE` environment variable.

---

## MCP Tools

File I/O tools are registered in the **`basic`** MCP namespace. All tools accept URI-style paths with `storage://` or `sandbox://` schemes. Only the `storage://` scheme is covered here.

**Source:** `packages/server/src/mcp/basic/`

### `read`

Read a file by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `storage://docs/readme.txt`) |
| `lineNumbers` | `boolean` | no | Prepend line numbers to each line (default: `false`) |

**Returns (text files):** File content, optionally with line numbers. When `lineNumbers=true`, output matches `read` format used by `edit` in line mode.

**Returns (PDF files):** A summary string plus base64 PNG images of up to 3 pages. Includes a hint to display the PDF via an iframe window with `storage://` protocol.

**Returns (image files):** Base64-encoded image content with MIME type.

**Returns (binary files):** A message explaining the file can't be read as text, with a pointer to the REST API.

**Errors:** Path traversal detected, file not found, cannot read a directory.

### `write`

Write a file by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `storage://docs/file.txt`) |
| `content` | `string` | yes | Content to write |

Parent directories are created automatically. Overwrites existing files. Fails on read-only mounts.

**Returns:** `"Written to storage://{path}"`

### `list`

List directory contents by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | Directory URI (e.g. `storage://`, `storage://docs`) |

Returns emoji-prefixed listing (📁 directories, 📄 files). Directories sorted first, then alphabetically. Mounted directories appear as virtual entries under `storage://mounts/`.

**Returns:** Formatted list or `"Directory is empty"`.

### `delete`

Delete a single file by URI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `storage://docs/draft.txt`) |

Does not support recursive directory deletion. Fails on read-only mounts.

**Returns:** `"Deleted storage://{path}"`

### `edit`

Apply an edit to a file by URI. Two modes:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uri` | `string` | yes | File URI (e.g. `storage://docs/readme.txt`) |
| `old_string` | `string` | no | Exact text to find (must be unique). Omit to use line mode. |
| `new_string` | `string` | yes | Replacement text |
| `start_line` | `number` | no | First line to replace (1-based). Requires line mode. |
| `end_line` | `number` | no | Last line to replace (1-based, inclusive). Defaults to `start_line`. |

**String mode** (`old_string` + `new_string`): Finds the exact match and replaces it. The match must be unique in the file.

**Line mode** (`start_line` + `new_string`): Replaces lines `start_line..end_line`. Line numbers are 1-based, matching the output of `read` with `lineNumbers=true`.

Cannot mix both modes.

**Returns:** `"Edited storage://{path}"`

---

## Mount System

Host directories can be mounted at `storage://mounts/{alias}/` via the `system` MCP config tools.

**Source:** `packages/server/src/storage/mounts.ts`, `packages/server/src/mcp/system/config-mounts.ts`

### Mount a directory

```
set_config(section: "mounts", content: { alias, hostPath, readOnly? })
```

| Field | Type | Description |
|-------|------|-------------|
| `alias` | `string` | Mount name. Must match `/^[a-z][a-z0-9-]{0,49}$/`. Reserved: `temp`, `files`, `credentials`, `mounts`. |
| `hostPath` | `string` | Absolute path to an existing directory. Cannot be inside the storage directory. |
| `readOnly` | `boolean` | Optional, defaults to `false`. |

Requires user permission dialog. Config persisted in `config/mounts.json`.

### List mounts

```
get_config(section: "mounts")
```

Returns `{ mounts: MountEntry[] }`.

### Unmount

```
remove_config(section: "mounts", id: "{alias}")
```

### Mount behavior

- Mounted directories appear as `storage://mounts/{alias}/...` in all tools (read, write, list, delete, edit)
- The virtual `mounts/` directory is injected into storage root listings when mounts exist
- Path traversal protection ensures resolved paths stay within the mount
- Read-only mounts reject write, delete, and edit operations

---

## REST API

**Source:** `packages/server/src/http/routes/files.ts`

Base URL: `/api/storage/{filePath}`

All paths are relative to the storage directory. Path traversal is blocked (HTTP 403). Read-only mounts block POST and DELETE (HTTP 403).

### GET — Serve file

```
GET /api/storage/documents/report.pdf
```

Returns the raw file with `Content-Type` inferred from the extension (see [MIME types](#mime-types)). Returns `Cache-Control: no-cache`.

**Status codes:** 200, 404 (not found), 403 (path traversal).

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

**Status codes:** 200, 404 (not found), 403 (path traversal or read-only mount).

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
| `storageRead` | `(filePath: string) → Promise<StorageReadResult>` | Read file; converts PDFs to images (max 3 pages), images to base64, text with line numbers |
| `storageWrite` | `(filePath: string, content: string \| Buffer) → Promise<StorageWriteResult>` | Write file; creates parent dirs; respects read-only mounts |
| `storageList` | `(dirPath?: string) → Promise<StorageListResult>` | List directory; injects virtual `mounts/` entry at root |
| `storageDelete` | `(filePath: string) → Promise<StorageDeleteResult>` | Delete single file; respects read-only mounts |
| `ensureStorageDir` | `() → Promise<void>` | Create `storage/` if missing |
| `resolvePath` | `(filePath: string) → ResolvedPath \| null` | Resolve storage-relative path; checks mounts first, then default storage dir |
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
| PDF (`.pdf`) | Convert first 3 pages to PNG via poppler |
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

**Source:** `packages/shared/src/capture-helper.ts` (`IFRAME_STORAGE_SDK_SCRIPT`)

Apps running inside iframes get `window.yaar.storage` injected automatically:

| Method | Signature | Description |
|--------|-----------|-------------|
| `save` | `(path, data) → Promise<{ok, path}>` | Write file. Accepts `string`, `Blob`, `ArrayBuffer`, `Uint8Array`. |
| `read` | `(path, options?) → Promise<*>` | Read file. `options.as`: `'text'`, `'json'`, `'blob'`, `'arraybuffer'`, or `'auto'` (default, guesses from Content-Type). |
| `list` | `(dirPath?) → Promise<StorageEntry[]>` | List directory contents. |
| `remove` | `(path) → Promise<{ok, path}>` | Delete file. |
| `url` | `(path) → string` | Get the HTTP URL: `/api/storage/{path}`. |

---

## Configuration Storage

Separate from user storage, configuration files live in `config/` (override with `YAAR_CONFIG`).

### Settings

**Source:** `packages/server/src/storage/settings.ts`

Stored at `config/settings.json`.

```typescript
interface Settings {
  onboardingCompleted: boolean;
  language: string;
}
```

| Function | Description |
|----------|-------------|
| `readSettings()` | Read current settings |
| `updateSettings(partial)` | Merge partial updates |

### Permissions

**Source:** `packages/server/src/storage/permissions.ts`

Stored at `config/permissions.json`. Records "allow" / "deny" decisions for MCP tool confirmations.

| Function | Description |
|----------|-------------|
| `checkPermission(toolName, context?)` | Look up a saved decision |
| `savePermission(toolName, decision, context?)` | Persist a decision |

### App Config

Stored at `config/{appId}.json`. Managed via `set_config(section: "app")`, `get_config(section: "app")`, and `remove_config` MCP tools.

---

## Limits

| Limit | Value |
|-------|-------|
| Max upload size (REST) | 50 MB |
| Max PDF preview pages | 3 |
| PDF render scale | 1.5× |
