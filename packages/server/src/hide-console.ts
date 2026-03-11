/**
 * Hide the Windows console window via FFI.
 *
 * Import this module BEFORE any other server code so the console
 * is hidden before log output starts. The CONSOLE PE subsystem is
 * kept so stdout/stderr still function (e.g. for log files).
 */
import { platform } from 'os';

if (platform() === 'win32') {
  try {
    const { dlopen, FFIType } = await import('bun:ffi');
    const kernel32 = dlopen('kernel32.dll', {
      GetConsoleWindow: { returns: FFIType.ptr },
    });
    const user32 = dlopen('user32.dll', {
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
    });
    const hwnd = kernel32.symbols.GetConsoleWindow();
    if (hwnd) user32.symbols.ShowWindow(hwnd, 0); // SW_HIDE
  } catch {
    // FFI not available — console stays visible
  }
}
