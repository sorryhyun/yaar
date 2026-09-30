/**
 * The modern Explorer folder picker (`IFileOpenDialog` + `FOS_PICKFOLDERS`), through `bun:ffi`.
 *
 * `showFolderDialog()` blocks its thread in the dialog's modal loop until the user answers, and
 * a mistake here faults the whole process — a Worker cannot contain it (measured: exit 3, no
 * `error` event). So it runs in a **helper process** whose only job is this dialog:
 * `runFolderDialogProcess()` shows it, prints one JSON line, and exits. The caller spawns the
 * helper, kills it to cancel, and falls back to something else when no line comes back
 * (`pick-directory.ts`).
 *
 * COM has no `bun:ffi` support, so methods are called by vtable slot, `this` first. The slot
 * numbers were checked on Windows 11 against a live dialog; see docs/proposals/windows_proposal.md §4.
 */
import { writeSync } from 'node:fs';
import { CFunction, dlopen, FFIType, read, type Pointer } from 'bun:ffi';

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_PATHMUSTEXIST = 0x800;
const SIGDN_FILESYSPATH = 0x80058000;
const HRESULT_CANCELLED = 0x800704c7;

const WS_EX_TOPMOST = 0x8;
const WS_EX_TOOLWINDOW = 0x80;
const WS_POPUP = 0x80000000;
const WS_VISIBLE = 0x10000000;

// IUnknown / IModalWindow / IFileDialog / IShellItem vtable slots.
const RELEASE = 2;
const SHOW = 3;
const SET_OPTIONS = 9;
const GET_OPTIONS = 10;
const SET_TITLE = 17;
const GET_RESULT = 20;
const GET_DISPLAY_NAME = 5;

const CLSID_FileOpenDialog = guid('DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7');
const IID_IFileOpenDialog = guid('D57C7288-D4AD-4768-BE02-9D969532D960');

export type FolderDialogResult = { path: string } | { cancelled: true } | { error: string };

/** A GUID's 16 bytes: Data1 u32, Data2 u16, Data3 u16 little-endian, then Data4 as written. */
function guid(text: string): Uint8Array {
  const hex = text.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return bytes;
}

/** A NUL-terminated UTF-16LE string. */
function wide(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text + '\0', 'utf16le'));
}

/** Read a NUL-terminated UTF-16LE string at a foreign pointer. */
function readWide(p: Pointer): string {
  const units: number[] = [];
  for (let i = 0; ; i += 2) {
    const unit = read.u16(p, i);
    if (unit === 0) break;
    units.push(unit);
  }
  return String.fromCharCode(...units);
}

/** Call COM method `slot` on `obj`; the object pointer is passed as `this`. */
function call(obj: Pointer, slot: number, args: FFIType[], values: unknown[]): number {
  const fn = CFunction({
    ptr: read.ptr(read.ptr(obj, 0) as Pointer, slot * 8) as Pointer,
    args: [FFIType.ptr, ...args],
    returns: FFIType.i32,
  });
  try {
    return (fn as unknown as (...a: unknown[]) => number)(obj, ...values) >>> 0;
  } finally {
    fn.close();
  }
}

function release(obj: Pointer): void {
  const fn = CFunction({
    ptr: read.ptr(read.ptr(obj, 0) as Pointer, RELEASE * 8) as Pointer,
    args: [FFIType.ptr],
    returns: FFIType.u32,
  });
  try {
    fn(obj);
  } finally {
    fn.close();
  }
}

function openLibraries() {
  const ole32 = dlopen('ole32.dll', {
    CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CoUninitialize: { args: [], returns: FFIType.void },
    CoCreateInstance: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
  });
  const user32 = dlopen('user32.dll', {
    CreateWindowExW: {
      args: [
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.i32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.ptr,
    },
    DestroyWindow: { args: [FFIType.ptr], returns: FFIType.bool },
    GetForegroundWindow: { args: [], returns: FFIType.ptr },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.bool], returns: FFIType.bool },
    SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
    BringWindowToTop: { args: [FFIType.ptr], returns: FFIType.bool },
  });
  const kernel32 = dlopen('kernel32.dll', {
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
  });
  return { ole32: ole32.symbols, user32: user32.symbols, kernel32: kernel32.symbols };
}

/**
 * A hidden, topmost owner for the dialog, pulled to the foreground.
 *
 * The helper is a background process, and Windows' foreground lock lets it create a window
 * but not bring one forward — so the dialog would open behind the browser. Attaching to the
 * foreground window's input queue for the moment of `SetForegroundWindow` is the standard way
 * past it; the dialog, owned by this window, then opens in front. A system class ("STATIC")
 * needs no window procedure, so no `JSCallback`.
 */
function createOwner(libs: ReturnType<typeof openLibraries>): Pointer | null {
  const { user32, kernel32 } = libs;
  const owner = user32.CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
    wide('STATIC'),
    wide(''),
    WS_POPUP | WS_VISIBLE,
    -32000,
    -32000,
    0,
    0,
    null,
    null,
    null,
    null,
  );
  if (!owner) return null;
  const foreground = user32.GetForegroundWindow();
  const theirs = foreground ? user32.GetWindowThreadProcessId(foreground, null) : 0;
  const ours = kernel32.GetCurrentThreadId();
  const attached = theirs !== 0 && theirs !== ours && user32.AttachThreadInput(ours, theirs, true);
  user32.SetForegroundWindow(owner);
  user32.BringWindowToTop(owner);
  if (attached) user32.AttachThreadInput(ours, theirs, false);
  return owner as Pointer;
}

/**
 * Show the folder picker and block until the user answers. Windows only; throws elsewhere or
 * when the DLLs can't be loaded. Call it on a thread that does nothing else — see the header.
 */
export function showFolderDialog(title: string): FolderDialogResult {
  if (process.platform !== 'win32') throw new Error('showFolderDialog is Windows-only');
  const libs = openLibraries();
  const { ole32, user32 } = libs;

  const init = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED) >>> 0;
  // S_OK or S_FALSE (already initialized on this thread) both need a matching CoUninitialize.
  if (init > 1) return { error: `CoInitializeEx 0x${init.toString(16)}` };
  let dialog: Pointer | null = null;
  let owner: Pointer | null = null;
  try {
    const out = new BigUint64Array(1);
    let hr =
      ole32.CoCreateInstance(
        CLSID_FileOpenDialog,
        null,
        CLSCTX_INPROC_SERVER,
        IID_IFileOpenDialog,
        out,
      ) >>> 0;
    if (hr !== 0 || !out[0]) return { error: `CoCreateInstance 0x${hr.toString(16)}` };
    dialog = Number(out[0]) as Pointer;

    const options = new Uint32Array(1);
    hr = call(dialog, GET_OPTIONS, [FFIType.ptr], [options]);
    if (hr !== 0) return { error: `GetOptions 0x${hr.toString(16)}` };
    const wanted = options[0] | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
    hr = call(dialog, SET_OPTIONS, [FFIType.u32], [wanted]);
    if (hr !== 0) return { error: `SetOptions 0x${hr.toString(16)}` };
    call(dialog, SET_TITLE, [FFIType.ptr], [wide(title)]);

    owner = createOwner(libs);
    hr = call(dialog, SHOW, [FFIType.ptr], [owner]);
    if (hr === HRESULT_CANCELLED) return { cancelled: true };
    if (hr !== 0) return { error: `Show 0x${hr.toString(16)}` };

    const itemOut = new BigUint64Array(1);
    hr = call(dialog, GET_RESULT, [FFIType.ptr], [itemOut]);
    if (hr !== 0 || !itemOut[0]) return { error: `GetResult 0x${hr.toString(16)}` };
    const item = Number(itemOut[0]) as Pointer;
    try {
      const nameOut = new BigUint64Array(1);
      hr = call(item, GET_DISPLAY_NAME, [FFIType.u32, FFIType.ptr], [SIGDN_FILESYSPATH, nameOut]);
      if (hr !== 0 || !nameOut[0]) return { error: `GetDisplayName 0x${hr.toString(16)}` };
      const name = Number(nameOut[0]) as Pointer;
      try {
        return { path: readWide(name) };
      } finally {
        ole32.CoTaskMemFree(name);
      }
    } finally {
      release(item);
    }
  } finally {
    if (dialog) release(dialog);
    if (owner) user32.DestroyWindow(owner);
    ole32.CoUninitialize();
  }
}

export const FOLDER_DIALOG_TITLE = 'Select folder to mount';

/**
 * The helper process body: show the dialog, write the result as one JSON line to stdout, exit.
 * `writeSync` rather than `process.stdout.write`, so the line is out before `process.exit`.
 */
export function runFolderDialogProcess(): never {
  let result: FolderDialogResult;
  try {
    result = showFolderDialog(FOLDER_DIALOG_TITLE);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  writeSync(1, JSON.stringify(result) + '\n');
  process.exit(0);
}
