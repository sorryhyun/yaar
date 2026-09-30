/**
 * Two things a Windows parent does for a child that shows UI on its behalf.
 *
 * - `killWithParent(pid)` puts the child in a job object that closes — and kills everything in
 *   it — when this process ends, however it ends. A child blocked in a native modal loop has no
 *   event loop to notice its parent is gone, so this is the only watch that works for it.
 * - `allowForeground(pid)` hands the child this process's right to take the foreground, so a
 *   window it opens can come to the front instead of flashing in the taskbar.
 *
 * Both are best-effort and return false on failure; neither throws on Windows.
 */
import { dlopen, FFIType } from 'bun:ffi';

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** `sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)` on x64; `LimitFlags` is the u32 at 16. */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

function openLibraries() {
  const kernel32 = dlopen('kernel32.dll', {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    SetInformationJobObject: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.bool,
    },
    AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.bool },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  });
  const user32 = dlopen('user32.dll', {
    AllowSetForegroundWindow: { args: [FFIType.u32], returns: FFIType.bool },
  });
  return { kernel32: kernel32.symbols, user32: user32.symbols };
}

let libs: ReturnType<typeof openLibraries> | undefined;
/**
 * One job for the life of this process. Its handle is never closed on purpose: the handle
 * closing at exit is exactly what kills the children.
 */
let job: bigint | number | undefined;

function killOnCloseJob(): bigint | number | null {
  if (job !== undefined) return job || null;
  const { kernel32 } = (libs ??= openLibraries());
  const handle = kernel32.CreateJobObjectW(null, null);
  if (!handle) {
    job = 0;
    return null;
  }
  const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (
    !kernel32.SetInformationJobObject(
      handle,
      JobObjectExtendedLimitInformation,
      info,
      info.byteLength,
    )
  ) {
    kernel32.CloseHandle(handle);
    job = 0;
    return null;
  }
  job = handle;
  return handle;
}

/** Kill `pid` when this process exits. False when the child could not be put in the job. */
export function killWithParent(pid: number): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const handle = killOnCloseJob();
    if (!handle) return false;
    const { kernel32 } = libs!;
    const child = kernel32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
    if (!child) return false;
    try {
      return kernel32.AssignProcessToJobObject(handle, child);
    } finally {
      kernel32.CloseHandle(child);
    }
  } catch {
    return false;
  }
}

/** Let `pid` bring its window to the foreground. */
export function allowForeground(pid: number): boolean {
  if (process.platform !== 'win32') return false;
  try {
    return (libs ??= openLibraries()).user32.AllowSetForegroundWindow(pid);
  } catch {
    return false;
  }
}
