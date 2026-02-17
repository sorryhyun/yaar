# Storage API Reference

The Storage API provides persistent file storage accessible to AI agents via MCP tools and to frontends/apps via REST endpoints. Storage is session-independent — files written in one session are available in all subsequent sessions.

---

## Directory Layout

```
PROJECT_ROOT/
├── storage/                     # Persistent user files (git-ignored)
│   ├── temp/                    # Dropped images (auto WebP conversion)
│   ├── files/                   # Uploaded files
│   └── {app-specific}/          # App data
└── config/                      # Configuration (git-ignored)
    ├── credentials/{appId}.json # App credentials
    ├── permissions.json         # Saved permission decisions
    ├── settings.json            # User settings
    ├── shortcuts.json           # Desktop shortcuts
    └── reload-cache/            # Per-session fingerprint cache
```

Default base: `PROJECT_ROOT/storage`. Override with the `YAAR_STORAGE` environment variable.

---

## MCP Tools

Registered in the `storage` MCP namespace. Full tool names: `mcp__storage__read`, `mcp__storage__write`, `mcp__storage__list`, `mcp__storage__delete`.

**Source:** `packages/server/src/mcp/storage/index.ts`

### `read`

Read a file from storage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path relative to `storage/` |

**Returns (text files):** File content as a UTF-8 string.

**Returns (PDF files):** A summary string (`"PDF with N page(s)"` or `"PDF preview (first 3 of N pages)"`) plus base64 PNG images of up to 3 pages. The tool instructs the agent to display PDFs via an iframe window pointing at `/api/storage/<path>` rather than rendering content as markdown.

**Errors:** Path traversal detected, file not found.

### `write`

Write a file to storage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path relative to `storage/` |
| `content` | `string` | yes | Content to write |

Parent directories are created automatically. Overwrites existing files.

**Returns:** `"Written to {path}"`

### `list`

List files and directories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | no | Directory path relative to `storage/` (defaults to root) |

**Returns:** Formatted list with directory/file emoji prefixes. Directories are sorted first, then alphabetically by name. Returns `"Directory is empty"` for empty or nonexistent directories.

Each entry includes: `path`, `isDirectory`, `size` (bytes), `modifiedAt` (ISO timestamp).

### `delete`

Delete a single file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path relative to `storage/` |

Does not support recursive directory deletion. Fails if the file does not exist.

**Returns:** `"Deleted {path}"`

---

## REST API

**Source:** `packages/server/src/http/routes/files.ts` (storage section)

Base URL: `/api/storage/{filePath}`

All paths are relative to the storage directory. Path traversal is blocked (HTTP 403).

### GET — Serve file

```
GET /api/storage/documents/report.pdf
```

Returns the raw file with `Content-Type` inferred from the extension (see [MIME types](#mime-types) below). Returns `Cache-Control: no-cache`.

**Status codes:** 200 (file content), 404 (not found), 403 (path traversal).

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

**Status codes:** 200, 404 (not found), 403 (path traversal).

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

**Source:** `packages/server/src/storage/types.ts`

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
```

---

## Storage Manager

**Source:** `packages/server/src/storage/storage-manager.ts`

Core functions used by both MCP tools and REST routes:

| Function | Signature | Description |
|----------|-----------|-------------|
| `storageRead` | `(filePath: string) → Promise<StorageReadResult>` | Read file; converts PDFs to images (max 3 pages) |
| `storageWrite` | `(filePath: string, content: string \| Buffer) → Promise<StorageWriteResult>` | Write file; creates parent dirs |
| `storageList` | `(dirPath?: string) → Promise<StorageListResult>` | List directory; returns empty list for missing dirs |
| `storageDelete` | `(filePath: string) → Promise<StorageDeleteResult>` | Delete single file |
| `ensureStorageDir` | `() → Promise<void>` | Create `storage/` if missing |
| `configRead` | `(filePath: string) → Promise<StorageReadResult>` | Read from `config/` directory |
| `configWrite` | `(filePath: string, content: string) → Promise<StorageWriteResult>` | Write to `config/` directory |

### Path Validation

All operations normalize the path and verify it resolves within the storage (or config) directory:

```typescript
function validatePath(filePath: string): string | null {
  const normalizedPath = normalize(join(STORAGE_DIR, filePath));
  const relativePath = relative(STORAGE_DIR, normalizedPath);
  if (relativePath.startsWith('..') || relativePath.includes('..')) {
    return null;  // path traversal blocked
  }
  return normalizedPath;
}
```

Blocked patterns: `../../etc/passwd`, absolute paths, `dir/../../../secret`.

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

Apps running inside iframes can access storage via `window.yaar.storage`:

| Method | Description |
|--------|-------------|
| `list(path)` | List directory contents |
| `read(path, opts?)` | Read file content |
| `save(path, content)` | Write file content |
| `remove(path)` | Delete file |
| `url(path)` | Get the HTTP URL: `/api/storage/{path}` |

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

### App Credentials

Stored at `config/credentials/{appId}.json`. Managed via the `apps_read_config` and `apps_write_config` MCP tools. Old credential locations (`apps/{appId}/credentials.json`, `storage/credentials/{appId}.json`) are auto-migrated on first read.

---

## Limits

| Limit | Value |
|-------|-------|
| Max upload size (REST) | 50 MB |
| Max PDF preview pages | 3 |
| PDF render scale | 1.5× |
