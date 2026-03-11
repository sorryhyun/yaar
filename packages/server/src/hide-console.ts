/**
 * Hide the Windows console window via FFI.
 *
 * Call hideConsole() after the browser window has opened so the user
 * sees the app window instead of a bare console.
 */
import { platform } from 'os';

export async function hideConsole(): Promise<void> {
  if (platform() !== 'win32') return;

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
