"""Cross-platform binary detection and path resolution.

This module enables ClaudeOS to work on Windows by bundling
platform-specific binaries rather than relying on npm global installs.

Priority order:
1. Bundled binaries (in ./bundled or PyInstaller _MEIPASS)
2. PATH lookup (for dev environments with global installs)
"""
import platform
import shutil
import sys
from pathlib import Path
from typing import Optional

# Mapping: (tool, os, arch) -> binary filename
BUNDLED_BINARIES: dict[tuple[str, str, str], str] = {
    # Claude Code CLI binaries
    ("claude", "windows", "amd64"): "claude-x86_64-pc-windows-msvc.exe",
    ("claude", "windows", "x86_64"): "claude-x86_64-pc-windows-msvc.exe",
    ("claude", "darwin", "arm64"): "claude-aarch64-apple-darwin",
    ("claude", "darwin", "aarch64"): "claude-aarch64-apple-darwin",
    ("claude", "darwin", "x86_64"): "claude-x86_64-apple-darwin",
    ("claude", "linux", "x86_64"): "claude-x86_64-unknown-linux-gnu",
    ("claude", "linux", "amd64"): "claude-x86_64-unknown-linux-gnu",
    ("claude", "linux", "aarch64"): "claude-aarch64-unknown-linux-gnu",
    ("claude", "linux", "arm64"): "claude-aarch64-unknown-linux-gnu",
    # Codex CLI binaries
    ("codex", "windows", "amd64"): "codex-x86_64-pc-windows-msvc.exe",
    ("codex", "windows", "x86_64"): "codex-x86_64-pc-windows-msvc.exe",
    ("codex", "darwin", "arm64"): "codex-aarch64-apple-darwin",
    ("codex", "darwin", "aarch64"): "codex-aarch64-apple-darwin",
    ("codex", "darwin", "x86_64"): "codex-x86_64-apple-darwin",
    ("codex", "linux", "x86_64"): "codex-x86_64-unknown-linux-gnu",
    ("codex", "linux", "amd64"): "codex-x86_64-unknown-linux-gnu",
    ("codex", "linux", "aarch64"): "codex-aarch64-unknown-linux-gnu",
    ("codex", "linux", "arm64"): "codex-aarch64-unknown-linux-gnu",
}


def get_platform_info() -> tuple[str, str]:
    """Get normalized (os_name, architecture) for current platform.

    Returns:
        Tuple of (os_name, arch) where:
        - os_name: 'windows', 'darwin', or 'linux'
        - arch: 'x86_64', 'amd64', 'arm64', or 'aarch64'
    """
    os_name = platform.system().lower()
    machine = platform.machine().lower()

    # Normalize architecture names
    arch_map = {
        "x86_64": "x86_64",
        "amd64": "amd64",
        "arm64": "arm64",
        "aarch64": "aarch64",
        "x64": "x86_64",  # Windows sometimes reports this
    }
    arch = arch_map.get(machine, machine)

    return (os_name, arch)


def get_bundled_dir() -> Path:
    """Get the bundled binaries directory.

    Handles both development mode and PyInstaller frozen mode.

    Returns:
        Path to bundled/ directory
    """
    if getattr(sys, "frozen", False):
        # Running as PyInstaller bundle
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass) / "bundled"
        return Path(sys.executable).parent / "bundled"
    else:
        # Development mode - relative to this file
        return Path(__file__).parent.parent.parent / "bundled"


def get_bundled_binary_path(tool: str) -> Optional[Path]:
    """Get path to bundled binary for a tool.

    Args:
        tool: Tool name ('claude' or 'codex')

    Returns:
        Path to binary if found, None otherwise
    """
    os_name, arch = get_platform_info()
    binary_name = BUNDLED_BINARIES.get((tool, os_name, arch))

    if not binary_name:
        return None

    # Search locations in order of priority
    search_paths: list[Path] = []

    if getattr(sys, "frozen", False):
        # PyInstaller bundle: check multiple locations
        exe_dir = Path(sys.executable).parent
        search_paths.extend([
            exe_dir / binary_name,
            exe_dir / "bundled" / binary_name,
        ])
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            meipass_path = Path(meipass)
            search_paths.extend([
                meipass_path / binary_name,
                meipass_path / "bundled" / binary_name,
            ])
    else:
        # Development mode
        bundled_dir = get_bundled_dir()
        search_paths.append(bundled_dir / binary_name)

    for path in search_paths:
        if path.exists() and path.is_file():
            return path

    return None


def get_tool_path(tool: str) -> Optional[str]:
    """Get the full path to a tool binary.

    Checks bundled binaries first (enables Windows support),
    then falls back to PATH lookup.

    Args:
        tool: Tool name ('claude' or 'codex')

    Returns:
        Full path to binary if found, None otherwise
    """
    # Priority 1: Bundled binary
    bundled = get_bundled_binary_path(tool)
    if bundled:
        return str(bundled)

    # Priority 2: PATH lookup
    return shutil.which(tool)


def is_windows() -> bool:
    """Check if running on Windows."""
    return platform.system().lower() == "windows"


def is_macos() -> bool:
    """Check if running on macOS."""
    return platform.system().lower() == "darwin"


def is_linux() -> bool:
    """Check if running on Linux."""
    return platform.system().lower() == "linux"
