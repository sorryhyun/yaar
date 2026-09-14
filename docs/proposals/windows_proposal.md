# Proposal: Windows Native Calls via `bun:ffi` — Command-Line Lookup and Folder Picker

**Status:** draft, not implemented. Written on macOS, where none of the Windows code below can
run; every Win32 detail is checked against Wine's headers (`shobjidl.idl`, `winternl.h`,
`objbase.h`, `winerror.h`) but **not executed**. §5 is the checklist to work through on a real
Windows machine before any of this lands.

Two places on Windows start PowerShell to do something one Win32 call can do. Both are slow,
one blocks the whole server while it waits, and the other leaves the user on a tree-style
dialog from 2001. `bun:ffi` already has a working precedent in the tree —
`packages/server/src/hide-console.ts` hides the console window through `kernel32`/`user32` — and
this proposal extends that pattern to exactly those two sites, and no further.

---

## 1. Scope — what changes, and where nothing does

| Site | Windows today | Proposed on Windows | Other platforms |
|------|---------------|---------------------|-----------------|
| `readCommandLine()` in `packages/server/src/lib/browser/pid-file.ts` | `spawnSync` PowerShell + `Get-CimInstance Win32_Process` | `OpenProcess` → `NtQueryInformationProcess` → `CloseHandle`, synchronous | macOS: keep `ps` (**measured 2.2 ms**, runs once before Chrome launch). Linux: `/proc/<pid>/cmdline`, no FFI needed — a separate small change |
| `tryPowerShell()` in `packages/lib/src/pick-directory.ts` | PowerShell + `Add-Type` inline C# + WinForms `FolderBrowserDialog`, results via polled temp files | `IFileOpenDialog` with `FOS_PICKFOLDERS`, run in a Worker | **No change.** macOS keeps `osascript` (`NSOpenPanel` must own the process main thread). Linux keeps zenity/kdialog. **WSL keeps PowerShell** — a Linux process cannot load Windows DLLs |

PowerShell stays in both sites as the **fallback**, reached when the FFI path throws. Neither
change is allowed to make a working Windows install worse.

**Non-goals:** a general Win32 bindings layer; desktop control (input synthesis, tray,
notifications); in-process native libraries such as pdfium or llama.cpp. Those are separate
decisions — long-running native work belongs in a sidecar process, where a crash costs one
process instead of every session.

---

## 2. Why bother

### 2a. The command-line lookup blocks the server

`cleanupStaleChrome()` asks "is this live PID still our Chrome?" by reading the process's command
line and matching `--user-data-dir=`. On Windows the answer comes from:

```ts
Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command',
  `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
```

`spawnSync` holds the event loop for PowerShell's cold start plus a WMI query — commonly
reported in the 1–2 s range, **not measured here** (§5 measures it). The call only happens when
a stale PID file names a live PID, so it is rare, but when it happens nothing else on the server
moves. The FFI path is three syscalls.

It also removes the only reason `cleanupStaleChrome()` interpolates a PID into a command string
(the integer check at `pid-file.ts:117` exists for that).

### 2b. The folder picker is slow, old, and drops slow answers

Reading `tryPowerShell()` top to bottom:

1. **Startup cost.** PowerShell cold start, then `Add-Type` compiling an inline C# class
   (`FocusSteal`) at runtime through the .NET compiler, then loading WinForms — before a dialog
   exists.
2. **The dialog.** `FolderBrowserDialog` under Windows PowerShell 5.1 / .NET Framework is the
   legacy `SHBrowseForFolder` tree view: no address bar, no search, no Quick Access, no pasting a
   path.
3. **The result channel.** The script writes to temp files that the server polls every 300 ms,
   because stdout piping is broken in the compiled exe.
4. **A real bug.** The poll gives up after 60 s and returns `null`, but the dialog stays on
   screen. A user who takes 61 s picks a folder and nothing happens.

`IFileOpenDialog` with `FOS_PICKFOLDERS` is the modern Explorer dialog (address bar, search,
Quick Access, paste-a-path), in-process, with the result coming back as a return value.

---

## 3. Design A — command-line lookup

### Where it lives

`packages/lib/src/win32/process-command-line.ts`, exported as `@yaar/lib/win32`. A Win32 call
has no YAAR knowledge, which is exactly `@yaar/lib`'s admission rule (`packages/lib/CLAUDE.md`).
`pid-file.ts` imports it and falls back to its current PowerShell call on `null`.

### Calls

| Step | Function | DLL | Notes |
|------|----------|-----|-------|
| 1 | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)` | `kernel32` | `0x1000`. Enough for a same-user process; no admin needed |
| 2 | `NtQueryInformationProcess(h, ProcessCommandLineInformation, buf, len, &retLen)` | `ntdll` | Class **60** (`winternl.h`), Windows 8.1+. Returns `STATUS_INFO_LENGTH_MISMATCH` (`0xC0000004`) with `retLen` set when `buf` is too small — call again with that size |
| 3 | `CloseHandle(h)` | `kernel32` | In a `finally` |

The output buffer starts with a `UNICODE_STRING` (x64: `Length` u16 @0 in **bytes**,
`MaximumLength` u16 @2, 4 bytes padding, `Buffer` pointer @8), and `Buffer` points *into the same
allocation*, just after the struct. So the string can be decoded from our own `Uint8Array`
without dereferencing a foreign pointer: `offset = Buffer - ptr(buf)`.

### Sketch

```ts
import { dlopen, FFIType, ptr, read } from 'bun:ffi';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ProcessCommandLineInformation = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;

const kernel32 = dlopen('kernel32.dll', {
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
});
const ntdll = dlopen('ntdll.dll', {
  NtQueryInformationProcess: {
    args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
});

export function readProcessCommandLine(pid: number): string | null {
  const handle = kernel32.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return null;
  try {
    const retLen = new Uint32Array(1);
    let buf = new Uint8Array(4096);
    let status = ntdll.symbols.NtQueryInformationProcess(
      handle, ProcessCommandLineInformation, buf, buf.byteLength, retLen);
    if (status >>> 0 === STATUS_INFO_LENGTH_MISMATCH) {
      buf = new Uint8Array(retLen[0]);
      status = ntdll.symbols.NtQueryInformationProcess(
        handle, ProcessCommandLineInformation, buf, buf.byteLength, retLen);
    }
    if (status !== 0) return null;
    const byteLength = read.u16(ptr(buf), 0);
    const offset = Number(read.u64(ptr(buf), 8) - BigInt(ptr(buf)));
    return new TextDecoder('utf-16le').decode(buf.subarray(offset, offset + byteLength));
  } finally {
    kernel32.symbols.CloseHandle(handle);
  }
}
```

`HANDLE` is typed `u64`, not `ptr`, following Bun's FFI docs for Windows handles
(`hide-console.ts` uses `ptr` for an `HWND` and works — §5 settles which is right for a
`HANDLE`). Lazy-`dlopen` inside the function on first use, as `hide-console.ts` does, so importing
the module on macOS/Linux never touches `bun:ffi`.

### Testing

`packages/server/src/tests/browser-stale-cleanup.test.ts` already covers this end to end on
every platform: it spawns an idler carrying `--user-data-dir=<dir>` and asserts that
`cleanupStaleChrome()` kills it, and that an idler without the flag survives. It needs no changes;
on Windows it exercises the FFI path. CI is Ubuntu-only, so the Windows run is manual (§5).

---

## 4. Design B — folder picker

### Shape

```
POST /api/pick-directory
  └─ pickDirectory()                      packages/lib/src/pick-directory.ts
       └─ win32 && !WSL → tryFileDialog() packages/lib/src/win32/folder-dialog.ts
            └─ new Worker(folder-dialog-worker)
                 CoInitializeEx(STA) → CoCreateInstance(FileOpenDialog)
                 → GetOptions / SetOptions / SetTitle → Show(owner) ── blocks this thread only
                 → GetResult → IShellItem.GetDisplayName → postMessage(path | null)
       └─ on throw → tryPowerShell()      (unchanged, fallback)
```

### Why a Worker is not optional

`IModalWindow::Show` runs its own modal message loop and does not return until the user answers.
On the main thread it would freeze every WebSocket, MCP call and agent turn for as long as the
dialog is open. In a Worker it blocks only that thread.

**Verified on macOS (Bun 1.4.2):** `bun:ffi` `dlopen` works inside a Worker, both under
`bun run` and in a `bun build --compile` binary. The spelling that works in **both** is
`new Worker(new URL('./worker.ts', import.meta.url))`; a bare `new Worker('./worker.ts')` resolves
against the cwd under `bun run` and fails (`ModuleNotFound`). In the compiled binary the worker
must be listed as an **extra entrypoint** (Bun docs, and confirmed): add it to `buildArgs` in
`scripts/build/exe-bundle.js` next to `exe-bundle-entry.ts`.

Open point (§6): `@yaar/lib` exports resolve to `dist/*.js`, and the exe bundles lib source into
the server entry, so `import.meta.url` means a different file in dev, `dist`, and the exe. The
spelling above must be checked in all three.

### COM through FFI

No COM support in `bun:ffi`, so methods are called by vtable slot: the object pointer's first
8 bytes are the vtable pointer, and slot *n* is at vtable offset `n × 8`. Every method takes
`this` as its first argument and returns an `HRESULT` (`i32`).

```ts
import { CFunction, FFIType, read } from 'bun:ffi';

function method(obj: number, slot: number, args: FFIType[]) {
  const fn = read.ptr(read.ptr(obj, 0), slot * 8);
  return CFunction({ ptr: fn, args: [FFIType.ptr, ...args], returns: FFIType.i32 });
}
```

**Slot table.** Order checked against Wine's `shobjidl.idl`. `IModalWindow` declares
`[local] Show` and `[call_as(Show)] RemoteShow`; `call_as` methods do **not** take a vtable slot,
so `Show` is the only slot IModalWindow adds. If this is wrong, every IFileDialog slot is off by
one, and the first call will crash the Worker — this is check #1 in §5.

| Slot | Interface | Method | Used for |
|------|-----------|--------|----------|
| 0 / 1 / 2 | IUnknown | QueryInterface / AddRef / **Release** | release dialog and shell item |
| 3 | IModalWindow | **Show**(HWND owner) | the modal call |
| 9 | IFileDialog | **SetOptions**(DWORD) | add pick-folders flags |
| 10 | IFileDialog | **GetOptions**(DWORD\*) | read defaults first |
| 17 | IFileDialog | **SetTitle**(LPCWSTR) | "Select folder to mount" |
| 20 | IFileDialog | **GetResult**(IShellItem\*\*) | the picked folder |
| 23 | IFileDialog | Close(HRESULT) | not used — see deadline below |
| 5 | IShellItem | **GetDisplayName**(SIGDN, LPWSTR\*) | filesystem path |

(Full IFileDialog order from slot 4: SetFileTypes, SetFileTypeIndex, GetFileTypeIndex, Advise,
Unadvise, SetOptions, GetOptions, SetDefaultFolder, SetFolder, GetFolder, GetCurrentSelection,
SetFileName, GetFileName, SetTitle, SetOkButtonLabel, SetFileNameLabel, GetResult, AddPlace,
SetDefaultExtension, Close, SetClientGuid, ClearClientData, SetFilter.)

**Constants** (all from Wine headers):

| Name | Value |
|------|-------|
| `CLSID_FileOpenDialog` | `{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}` |
| `IID_IFileOpenDialog` | `{D57C7288-D4AD-4768-BE02-9D969532D960}` |
| `COINIT_APARTMENTTHREADED` | `0x2` |
| `CLSCTX_INPROC_SERVER` | `0x1` |
| `FOS_PICKFOLDERS` / `FOS_FORCEFILESYSTEM` / `FOS_PATHMUSTEXIST` | `0x20` / `0x40` / `0x800` |
| `SIGDN_FILESYSPATH` | `0x80058000` |
| Cancelled (`HRESULT_FROM_WIN32(ERROR_CANCELLED)`, 1223) | `0x800704C7` |

A GUID is 16 bytes, little-endian for the first three fields: `Data1` u32, `Data2` u16, `Data3`
u16, then `Data4` as 8 raw bytes in written order. Compare `HRESULT`s as `hr >>> 0` — they are
negative as `i32`.

### Worker sequence

1. `ole32!CoInitializeEx(null, COINIT_APARTMENTTHREADED)` — the dialog needs an STA, and the
   Worker's thread is fresh, so this is ours to own.
2. `ole32!CoCreateInstance(&CLSID_FileOpenDialog, null, CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, &out)`
   → `dialog = read.ptr(out, 0)`.
3. `GetOptions(&opts)` → `SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)`.
4. `SetTitle(utf16z("Select folder to mount"))` — a NUL-terminated UTF-16LE `Uint8Array`.
5. `hr = Show(owner)` (owner: see focus below). `0x800704C7` → post `null`. Other failure → post
   an error, so the main thread falls back to PowerShell.
6. `GetResult(&itemOut)` → `item.GetDisplayName(SIGDN_FILESYSPATH, &pszOut)` → read UTF-16 until
   NUL (`read.u16` loop, or `toArrayBuffer(psz, 0, n)`).
7. `ole32!CoTaskMemFree(psz)`, `item.Release()`, `dialog.Release()`, `CoUninitialize()`, post the
   path.

### Focus: the dialog must not open behind the browser

The server is a background process; Windows' foreground lock lets it create a window but not
bring one to the front. The current script works around this with a hidden 0×0 topmost WinForms
form, `AttachThreadInput` to the foreground thread, `SetForegroundWindow` on the form, then the
form as the dialog's owner. The same trick through FFI, with no window class to register:

1. `CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, "STATIC", …, WS_POPUP, -32000, -32000, 0, 0, …)`
   — a system class, so no `WndProc` and no `JSCallback`.
2. `GetForegroundWindow` → `GetWindowThreadProcessId` → `AttachThreadInput(ours, theirs, TRUE)`
   → `SetForegroundWindow(owner)` → `AttachThreadInput(…, FALSE)`.
3. `Show(owner)`; `DestroyWindow(owner)` afterwards, on the same thread.

This is the part most likely to need adjusting on a real desktop (§5 #5).

### Deadline: no dialog outlives its request

"No time limit" is not available: `Bun.serve` closes an idle connection at
`TRANSPORT_IDLE_TIMEOUT_S` = **255 s** (`packages/server/src/config/deadlines.ts`), and nothing
overrides it for this route. `apiFetch` adds no timeout of its own, so 255 s is the outer bound.
Following that file's rule — an inner deadline must fire before whoever is waiting gives up — the
picker waits `MAX_REQUEST_DEADLINE_MS` (240 s) and then **cancels the dialog**, rather than
returning `null` with the dialog still on screen (today's 60 s bug).

Cancelling from the main thread must not touch the dialog's COM object (its thread is blocked in
`Show`), and `Worker.terminate()` cannot interrupt a native call. Cross-thread *messages* are
safe, though, and the owner window makes the dialog findable without a callback:

- The Worker posts the owner `HWND` to the main thread before calling `Show`.
- On deadline, main thread: `dlg = user32!GetWindow(owner, GW_ENABLEDPOPUP /* 6 */)` →
  `PostMessageW(dlg, WM_COMMAND /* 0x111 */, IDCANCEL /* 2 */, 0)`.
- `Show` returns cancelled, the Worker cleans up normally, and the route answers
  `{ path: null, cancelled: true }`.

240 s is a large improvement on 60 s and fits inside the transport. A pick taking longer than
four minutes cancels visibly, which is honest.

### Fallback matrix

| Failure | Result |
|---------|--------|
| `bun:ffi` import or `dlopen` throws | `tryPowerShell()` |
| Worker fails to start (wrong URL in exe, missing entrypoint) | `tryPowerShell()` |
| `CoCreateInstance` / `SetOptions` / `Show` returns failure other than cancel | `tryPowerShell()` |
| Worker crashes (bad slot → access violation) | Worker `error` event → `tryPowerShell()`. **Check in §5 whether an access violation in a Worker takes down the whole process** — if it does, the fallback does not help, and the slot table must be proven before shipping |
| User cancels | `null`, no fallback (cancel is an answer) |

---

## 5. Windows verification checklist

Run in dev (`make dev`) **and** against the compiled exe (`bun run build:exe`).

1. **Slots.** A standalone script that creates the dialog, calls `GetOptions`, `SetOptions`,
   `SetTitle` and `Release` — no `Show` — and prints each `HRESULT`. All zero means the slot
   table is right. Do this before anything else.
2. **Crash containment.** Deliberately call a wrong slot inside a Worker. Does the main process
   survive? This decides whether §4's fallback matrix is real.
3. **`HANDLE` type.** `OpenProcess` with `returns: FFIType.u64` vs `FFIType.ptr`; confirm the handle
   round-trips into `NtQueryInformationProcess` and `CloseHandle`.
4. **Timing.** Time the current PowerShell `Get-CimInstance` lookup (cold, and warm) and the FFI
   lookup; time from click to dialog-visible for both pickers. Put the numbers in this file.
5. **Focus.** Click the folder button in Chrome, and in the exe's own Chrome window: does the
   dialog open in front, with keyboard focus? Repeat with another app focused in between.
6. **Deadline.** Temporarily set the deadline to 5 s; confirm the dialog closes itself, the Worker
   exits, and the route returns `cancelled`.
7. **Paths.** A folder with non-ASCII characters (한글), a path over 260 chars, a mapped network
   drive, a OneDrive folder. `FOS_FORCEFILESYSTEM` should grey out Libraries and "This PC".
8. **Command-line lookup.** `bun run --filter @yaar/server test` for
   `browser-stale-cleanup.test.ts`; also a Chrome whose `--user-data-dir` contains spaces and
   non-ASCII.
9. **Worker URL in all three builds** — dev, lib `dist`, exe (§6).
10. **WSL** still reaches `tryPowerShell()` and `wslpath` unchanged.

---

## 6. Open questions for the Windows discussion

- **Worker file location.** `new URL('./win32/folder-dialog-worker.ts', import.meta.url)` in lib
  source vs lib `dist` (`.js`) vs the exe bundle, where lib is inlined into the server entry.
  Options: keep the Worker in `packages/server/src/` next to `exe-bundle-entry.ts` and inject the
  URL into `pickDirectory({ workerUrl })` — the same "take it as a parameter" shape `@yaar/lib/pdf`
  uses for `binDir` — or have the exe build pass a define.
- **`hide-console.ts`.** Move it into `@yaar/lib/win32` alongside the new code, so all Win32 FFI
  lives in one place? It needs no server internals.
- **Code signing.** The release exe is signed (`release.yml`). FFI into system DLLs needs nothing
  extra, but confirm SmartScreen/Defender does not flag the new behaviour.
- **Owner window vs `IFileDialogEvents`.** If focus stays unreliable, the next step is an events
  sink (`Advise`, slot 7) implemented with `JSCallback` vtables, which is a large jump in
  complexity. Try the owner window first.
- **Linux `/proc` change.** Independent of Windows and testable in CI; land it separately rather
  than waiting on this proposal.
