/**
 * The command line of a running Windows process, read in-process through `bun:ffi`.
 *
 * `OpenProcess` → `NtQueryInformationProcess(ProcessCommandLineInformation)` → `CloseHandle`:
 * three syscalls, measured at 0.5–3 ms, against 1–2 s for PowerShell's
 * `Get-CimInstance Win32_Process` (which also blocks the event loop when spawned sync).
 *
 * The output buffer starts with a `UNICODE_STRING` whose `Buffer` points into that same
 * allocation, just after the struct — so the string is decoded from our own bytes, never by
 * dereferencing a foreign pointer.
 */
import { dlopen, FFIType, ptr, read } from 'bun:ffi';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `PROCESSINFOCLASS` value in `winternl.h`; Windows 8.1+. */
const ProcessCommandLineInformation = 60;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;

function openLibraries() {
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
  return { kernel32: kernel32.symbols, ntdll: ntdll.symbols };
}

// Opened on first use, so importing this module off Windows never touches a DLL.
let libs: ReturnType<typeof openLibraries> | undefined;

/**
 * The full command line of `pid`, or null when the process is gone, not ours to query, or
 * the call fails. Throws only off Windows or when the DLLs can't be loaded — callers that
 * have a slower fallback should catch and use it.
 */
export function readProcessCommandLine(pid: number): string | null {
  if (process.platform !== 'win32') throw new Error('readProcessCommandLine is Windows-only');
  libs ??= openLibraries();
  const { kernel32, ntdll } = libs;

  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return null;
  try {
    const retLen = new Uint32Array(1);
    let buf = new Uint8Array(4096);
    let status = ntdll.NtQueryInformationProcess(
      handle,
      ProcessCommandLineInformation,
      buf,
      buf.byteLength,
      retLen,
    );
    if (status >>> 0 === STATUS_INFO_LENGTH_MISMATCH) {
      buf = new Uint8Array(retLen[0]);
      status = ntdll.NtQueryInformationProcess(
        handle,
        ProcessCommandLineInformation,
        buf,
        buf.byteLength,
        retLen,
      );
    }
    if (status !== 0) return null;
    const base = ptr(buf);
    const byteLength = read.u16(base, 0);
    const offset = Number(BigInt(read.u64(base, 8)) - BigInt(base));
    if (offset < 0 || offset + byteLength > buf.byteLength) return null;
    return new TextDecoder('utf-16le').decode(buf.subarray(offset, offset + byteLength));
  } finally {
    kernel32.CloseHandle(handle);
  }
}
