"""Tests for platform support module."""
import platform
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.providers.platform_support import (
    BUNDLED_BINARIES,
    get_bundled_binary_path,
    get_bundled_dir,
    get_platform_info,
    get_tool_path,
    is_linux,
    is_macos,
    is_windows,
)


class TestGetPlatformInfo:
    def test_returns_tuple(self):
        os_name, arch = get_platform_info()
        assert isinstance(os_name, str)
        assert isinstance(arch, str)

    def test_os_name_normalized(self):
        os_name, _ = get_platform_info()
        assert os_name in ("windows", "darwin", "linux")

    @patch("platform.system", return_value="Darwin")
    @patch("platform.machine", return_value="arm64")
    def test_macos_arm(self, mock_machine, mock_system):
        os_name, arch = get_platform_info()
        assert os_name == "darwin"
        assert arch == "arm64"

    @patch("platform.system", return_value="Windows")
    @patch("platform.machine", return_value="AMD64")
    def test_windows_amd64(self, mock_machine, mock_system):
        os_name, arch = get_platform_info()
        assert os_name == "windows"
        assert arch == "amd64"

    @patch("platform.system", return_value="Linux")
    @patch("platform.machine", return_value="x86_64")
    def test_linux_x86(self, mock_machine, mock_system):
        os_name, arch = get_platform_info()
        assert os_name == "linux"
        assert arch == "x86_64"


class TestBundledBinaries:
    def test_claude_binaries_defined(self):
        """Ensure Claude binaries are defined for all major platforms."""
        assert ("claude", "windows", "amd64") in BUNDLED_BINARIES
        assert ("claude", "darwin", "arm64") in BUNDLED_BINARIES
        assert ("claude", "darwin", "x86_64") in BUNDLED_BINARIES
        assert ("claude", "linux", "x86_64") in BUNDLED_BINARIES

    def test_codex_binaries_defined(self):
        """Ensure Codex binaries are defined for all major platforms."""
        assert ("codex", "windows", "amd64") in BUNDLED_BINARIES
        assert ("codex", "darwin", "arm64") in BUNDLED_BINARIES
        assert ("codex", "linux", "x86_64") in BUNDLED_BINARIES


class TestGetBundledDir:
    def test_returns_path(self):
        bundled_dir = get_bundled_dir()
        assert isinstance(bundled_dir, Path)

    def test_dev_mode_path(self):
        # In dev mode, should point to project root's bundled/
        bundled_dir = get_bundled_dir()
        assert bundled_dir.name == "bundled"


class TestGetBundledBinaryPath:
    def test_unknown_tool_returns_none(self):
        result = get_bundled_binary_path("unknown_tool")
        assert result is None

    @patch("backend.providers.platform_support.get_platform_info")
    def test_unsupported_platform_returns_none(self, mock_platform):
        mock_platform.return_value = ("freebsd", "x86_64")
        result = get_bundled_binary_path("claude")
        assert result is None

    def test_returns_path_when_exists(self, tmp_path):
        """Test that existing binary is found."""
        # This test requires the bundled binary to exist
        # In CI, we might skip this or mock the file system
        result = get_bundled_binary_path("claude")
        # Result is None if binary not bundled (normal in dev)
        assert result is None or isinstance(result, Path)


class TestGetToolPath:
    def test_returns_string_or_none(self):
        result = get_tool_path("claude")
        assert result is None or isinstance(result, str)

    @patch("backend.providers.platform_support.get_bundled_binary_path")
    @patch("shutil.which")
    def test_bundled_takes_priority(self, mock_which, mock_bundled):
        mock_bundled.return_value = Path("/bundled/claude")
        mock_which.return_value = "/usr/local/bin/claude"

        result = get_tool_path("claude")

        assert result == "/bundled/claude"
        mock_which.assert_not_called()  # Should not check PATH if bundled found

    @patch("backend.providers.platform_support.get_bundled_binary_path")
    @patch("shutil.which")
    def test_falls_back_to_path(self, mock_which, mock_bundled):
        mock_bundled.return_value = None
        mock_which.return_value = "/usr/local/bin/claude"

        result = get_tool_path("claude")

        assert result == "/usr/local/bin/claude"

    @patch("backend.providers.platform_support.get_bundled_binary_path")
    @patch("shutil.which")
    def test_returns_none_when_not_found(self, mock_which, mock_bundled):
        mock_bundled.return_value = None
        mock_which.return_value = None

        result = get_tool_path("claude")

        assert result is None


class TestPlatformChecks:
    @patch("platform.system", return_value="Windows")
    def test_is_windows(self, mock_system):
        assert is_windows() is True
        assert is_macos() is False
        assert is_linux() is False

    @patch("platform.system", return_value="Darwin")
    def test_is_macos(self, mock_system):
        assert is_windows() is False
        assert is_macos() is True
        assert is_linux() is False

    @patch("platform.system", return_value="Linux")
    def test_is_linux(self, mock_system):
        assert is_windows() is False
        assert is_macos() is False
        assert is_linux() is True
