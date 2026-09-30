# Proposal: Windows Native Calls via `bun:ffi` — Command-Line Lookup and Folder Picker

**Status:** both designs **implemented** on Windows. Design A: `@yaar/lib/win32`'s
`readProcessCommandLine`, wired into `pid-file.ts`. Design B, redesigned after the first Windows
run showed a Worker cannot contain a native crash (§5 #2): the dialog runs in a helper process
(§4) — `win32/folder-dialog.ts`, spawned by the server's `features/pick-directory.ts`, tied to it
by a job object. Written on macOS against Wine's headers; the §5 results below are from Windows 11
(build 26200), Bun 1.4.2. The rest of §5 needs a person clicking.

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
| `tryPowerShell()` in `packages/lib/src/pick-directory.ts` | PowerShell + `Add-Type` inline C# + WinForms `FolderBrowserDialog`, results via polled temp files | `IFileOpenDialog` with `FOS_PICKFOLDERS`, run in a helper process (the exe re-spawned, like `--window`) | **No change.** macOS keeps `osascript` (`NSOpenPanel` must own the process main thread). Linux keeps zenity/kdialog. **WSL keeps PowerShell** — a Linux process cannot load Windows DLLs |

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

`spawnSync` holds the event loop for PowerShell's cold start plus a WMI query — **measured
1.7 s cold, 1.0 s warm**, against **0.5–2.7 ms** for the FFI path (§5 #4). The call only happens when
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

`HANDLE` is typed `u64`, following Bun's FFI docs for Windows handles; `ptr` was verified to
work too (§5 #3). The DLLs are `dlopen`ed on first call, so importing the module on macOS/Linux
never loads one; off Windows the function throws and `pid-file.ts` keeps its PowerShell/`ps` path.
As shipped, the decoded offset is also bounds-checked against the buffer before slicing.

### Testing

`packages/server/src/tests/browser-stale-cleanup.test.ts` already covers this end to end on
every platform: it spawns an idler carrying `--user-data-dir=<dir>` and asserts that
`cleanupStaleChrome()` kills it, and that an idler without the flag survives. It needs no changes;
on Windows it exercises the FFI path (13/13 pass, 1.9 s). `packages/lib/src/tests/win32-process-command-line.test.ts`
covers the function itself — spaces, Hangul, a >4 KiB command line (the retry path), a missing
PID — and asserts it throws off Windows. CI is Ubuntu-only, so the Windows run is manual (§5).

---

## 4. Design B — folder picker

### Shape

```
POST /api/pick-directory
  └─ pickDirectory({ helperArgv })         packages/lib/src/pick-directory.ts
       └─ win32 && !WSL && helperArgv → tryFileDialog(helperArgv)
            └─ Bun.spawn([...helperArgv])  a child process, stdout piped
                 child: runFolderDialog()  packages/lib/src/win32/folder-dialog.ts
                   CoInitializeEx(STA) → CoCreateInstance(FileOpenDialog)
                   → GetOptions / SetOptions / SetTitle → Show(owner) ── blocks the child only
                   → GetResult → IShellItem.GetDisplayName → one JSON line on stdout, exit
       └─ child exits without a result line → tryPowerShell()   (unchanged, fallback)
```

### Why a separate process, not a Worker

`IModalWindow::Show` runs its own modal message loop and does not return until the user answers,
so it cannot run on the server's main thread. The draft put it in a Worker. **§5 check #2 rules
that out:** a bad native call inside a Worker (tested with a call through address `0xAA8`) takes
down the whole Bun process — exit code 3, no `error` event, main thread gone. A slot mistake, a
crash in a third-party shell extension loaded into the dialog (cloud-drive overlays, archivers and
context-menu handlers all load into `IFileOpenDialog`), or a fault in COM would kill every session.

A child process contains all of that, and removes three other problems at once:

- **No Worker URL question.** The draft's open point about what `import.meta.url` means in lib
  source, lib `dist` and the exe bundle disappears. The exe already re-spawns itself for the
  desktop window (`yaar --window`, routed in `exe-bundle-entry.ts` before any server module
  loads, spawned by `desktop-window/launch.ts`); the picker is one more flag on the same switch.
  In dev, the argv is `[process.execPath, <helper script>]`.
- **Deadline = kill.** `proc.kill()` (`TerminateProcess`) ends a thread blocked in `Show`, and the
  dialog's windows die with their process. No cross-thread `GetWindow`/`PostMessageW` dance.
- **Result channel = stdout.** `launch.ts` already reads its child's stdout inside the compiled
  exe (`waitForLine`), so the "stdout piping is broken in the exe" note that forced the
  PowerShell script onto polled temp files is about *that* child, not child processes in general.
  One JSON line — `{"path": "..."}` / `{"cancelled": true}` / `{"error": "..."}` — then exit.

Cost: one process spawn per pick (a Bun cold start, far below PowerShell + `Add-Type`). Picks are
rare and user-initiated; that is the right trade.

`@yaar/lib` keeps its rule: `pickDirectory` takes `helperArgv` as a parameter (the `binDir` shape
`@yaar/lib/pdf` uses), and the server — which knows whether it is the exe — builds it. With no
`helperArgv`, Windows goes straight to `tryPowerShell()` as today.

### COM through FFI

No COM support in `bun:ffi`, so methods are called by vtable slot: the object pointer's first
8 bytes are the vtable pointer, and slot *n* is at vtable offset `n × 8`. Every method takes
`this` as its first argument — **pass it explicitly**; the first Windows run forgot, `GetOptions`
returned `E_INVALIDARG`, and the next call segfaulted — and returns an `HRESULT` (`i32`).

```ts
import { CFunction, FFIType, read } from 'bun:ffi';

function method(obj: number, slot: number, args: FFIType[]) {
  const fn = read.ptr(read.ptr(obj, 0), slot * 8);
  return CFunction({ ptr: fn, args: [FFIType.ptr, ...args], returns: FFIType.i32 });
}
// method(dialog, 10, [FFIType.ptr])(dialog, optsOut)
```

**Slot table — verified on Windows (§5 #1).** `CoCreateInstance`, `GetOptions` (default
`0x1808`), `SetOptions` (re-read `0x1868`, pick-folders set) and `SetTitle` all return `S_OK`;
`GetResult` before `Show` returns `E_UNEXPECTED` (`0x8000FFFF`) — the right answer from the right
method; `Release` returns refcount 0. `Show` (3) and `GetDisplayName` (5) are not yet exercised.

| Slot | Interface | Method | Used for |
|------|-----------|--------|----------|
| 0 / 1 / 2 | IUnknown | QueryInterface / AddRef / **Release** | release dialog and shell item |
| 3 | IModalWindow | **Show**(HWND owner) | the modal call |
| 9 | IFileDialog | **SetOptions**(DWORD) | add pick-folders flags |
| 10 | IFileDialog | **GetOptions**(DWORD\*) | read defaults first |
| 17 | IFileDialog | **SetTitle**(LPCWSTR) | "Select folder to mount" |
| 20 | IFileDialog | **GetResult**(IShellItem\*\*) | the picked folder |
| 5 | IShellItem | **GetDisplayName**(SIGDN, LPWSTR\*) | filesystem path |

(Full IFileDialog order from slot 4: SetFileTypes, SetFileTypeIndex, GetFileTypeIndex, Advise,
Unadvise, SetOptions, GetOptions, SetDefaultFolder, SetFolder, GetFolder, GetCurrentSelection,
SetFileName, GetFileName, SetTitle, SetOkButtonLabel, SetFileNameLabel, GetResult, AddPlace,
SetDefaultExtension, Close, SetClientGuid, ClearClientData, SetFilter.)

**Constants** (from Wine headers; the CLSID/IID pair confirmed by `CoCreateInstance`):

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

### Helper sequence

1. `ole32!CoInitializeEx(null, COINIT_APARTMENTTHREADED)` — the helper's main thread, ours to own.
2. `ole32!CoCreateInstance(&CLSID_FileOpenDialog, null, CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, &out)`
   → `dialog = out[0]`.
3. `GetOptions(&opts)` → `SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)`.
4. `SetTitle(utf16z("Select folder to mount"))` — a NUL-terminated UTF-16LE `Uint8Array`.
5. `hr = Show(owner)` (owner: see focus below). `0x800704C7` → print `{"cancelled":true}`. Other
   failure → print `{"error":...}`, so the parent falls back to PowerShell.
6. `GetResult(&itemOut)` → `item.GetDisplayName(SIGDN_FILESYSPATH, &pszOut)` → read UTF-16 until
   NUL (`read.u16` loop, or `toArrayBuffer(psz, 0, n)`).
7. `ole32!CoTaskMemFree(psz)`, `item.Release()`, `dialog.Release()`, `CoUninitialize()`, print
   `{"path":...}`, exit 0.

Like the window process, the helper takes `--parent <pid>` and exits if the parent goes away, so
a server crash never strands a dialog.

### Focus: the dialog must not open behind the browser

The helper is a background process; Windows' foreground lock lets it create a window but not
bring one to the front. The current script works around this with a hidden 0×0 topmost WinForms
form, `AttachThreadInput` to the foreground thread, `SetForegroundWindow` on the form, then the
form as the dialog's owner. The same trick through FFI, with no window class to register:

1. `CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, "STATIC", …, WS_POPUP, -32000, -32000, 0, 0, …)`
   — a system class, so no `WndProc` and no `JSCallback`.
2. `GetForegroundWindow` → `GetWindowThreadProcessId` → `AttachThreadInput(ours, theirs, TRUE)`
   → `SetForegroundWindow(owner)` → `AttachThreadInput(…, FALSE)`.
3. `Show(owner)`; `DestroyWindow(owner)` afterwards.

As built, both are applied: the parent also calls `user32!AllowSetForegroundWindow(child.pid)`
right after the spawn, handing the helper whatever foreground right the server holds. This
is the part most likely to need adjusting on a real desktop — and the dev machine runs the server
**elevated**, which changes foreground and UIPI rules against a lower-integrity browser window.

### Deadline: no dialog outlives its request

"No time limit" is not available: `Bun.serve` closes an idle connection at
`TRANSPORT_IDLE_TIMEOUT_S` = **255 s** (`packages/server/src/config/deadlines.ts`), and nothing
overrides it for this route. `apiFetch` adds no timeout of its own, so 255 s is the outer bound.
Following that file's rule — an inner deadline must fire before whoever is waiting gives up — the
picker waits `MAX_REQUEST_DEADLINE_MS` (240 s) and then **kills the helper**, which takes the
dialog with it, rather than returning `null` with the dialog still on screen (today's 60 s bug).
The route answers `{ path: null, cancelled: true }`.

### Fallback matrix

| Failure | Result |
|---------|--------|
| No `helperArgv` passed, or the spawn fails | `tryPowerShell()` |
| Helper crashes (bad slot, shell-extension fault) — exits without a result line | `tryPowerShell()`; **only the helper dies** |
| `CoCreateInstance` / `SetOptions` / `Show` fails other than cancel → `{"error"}` | `tryPowerShell()` |
| Deadline | helper killed, `null`, no fallback (a second dialog after four minutes is worse) |
| User cancels | `null`, no fallback (cancel is an answer) |

---

## 5. Windows verification checklist

Run in dev (`make dev`) **and** against the compiled exe (`bun run build:exe`). Results so far:
Windows 11 Home 10.0.26200, Bun 1.4.2, dev only.

1. ✅ **Slots.** Create the dialog, call `GetOptions`, `SetOptions`, `SetTitle`, `GetResult`,
   `Release` — no `Show` — and print each `HRESULT`. All as expected; see §4's slot table.
2. ✅ **Crash containment — answered: a Worker does not contain it.** A native fault in a Worker
   kills the process (exit 3, no `error` event). This is why §4 uses a helper process. Re-run the
   same test against the helper: the server must survive and fall back.
3. ✅ **`HANDLE` type.** `u64` and `ptr` both round-trip through `NtQueryInformationProcess` and
   `CloseHandle`. Shipped as `u64`.
4. ◐ **Timing.** Command-line lookup: PowerShell `Get-CimInstance` **1.7 s cold, 1.0 s warm**;
   FFI **0.5–2.7 ms**. Still to do: click to dialog-visible for both pickers.
5. ◐ **Focus.** Scripted run, another app in front: the dialog (`#32770`, our title, the
   helper's PID) **was the foreground window** 2 s after the spawn. Still to do: click the folder
   button in Chrome and in the exe's own window, and check keyboard focus; elevated and not.
6. ✅ **Deadline.** With a 4 s deadline the helper was killed at 4.0 s, the dialog went with it,
   and `pickDirectory` answered `null`. Also: **parent force-killed** with the dialog open → the
   helper died with it (kill-on-close job object). `pick-directory-helper.test.ts` covers the
   result protocol with fake helpers on every platform.
7. ☐ **Paths.** A folder with non-ASCII characters (한글), a path over 260 chars, a mapped network
   drive, a OneDrive folder. `FOS_FORCEFILESYSTEM` should grey out Libraries and "This PC".
8. ✅ **Command-line lookup.** `browser-stale-cleanup.test.ts` 13/13; the new
   `win32-process-command-line.test.ts` covers spaces, Hangul and a >4 KiB command line.
9. ✅ **Helper argv in both builds** — dev (`[bun, folder-dialog-helper.ts]`) and the compiled
   exe (`[yaar.exe, --pick-directory]`): both opened the dialog in the foreground and were killed
   cleanly at the deadline, no stray process left.
10. ☐ **WSL** still reaches `tryPowerShell()` and `wslpath` unchanged.

---

## 6. Open questions for the Windows discussion

- **`hide-console.ts`.** Move it into `@yaar/lib/win32` alongside the new code, so all Win32 FFI
  lives in one place? It needs no server internals.
- **Code signing.** The release exe is signed (`release.yml`). FFI into system DLLs needs nothing
  extra, but confirm SmartScreen/Defender does not flag the exe re-spawning itself to show a dialog.
- **Owner window vs `IFileDialogEvents`.** If focus stays unreliable, the next step is an events
  sink (`Advise`, slot 7) implemented with `JSCallback` vtables, which is a large jump in
  complexity. Try `AllowSetForegroundWindow`, then the owner window, first.
- **Linux `/proc` change.** Independent of Windows and testable in CI; land it separately rather
  than waiting on this proposal.
- **Pre-existing Windows test failures.** `packages/lib/src/tests/paths.test.ts` has 4 tests that
  assert POSIX separators and fail on Windows — unrelated to this proposal, noticed while running it.
