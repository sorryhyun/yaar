"""Tests for provider layer."""
import pytest
from unittest.mock import patch, AsyncMock

from backend.providers import (
    get_provider,
    check_provider_availability,
    get_available_providers,
    get_first_available_provider,
    clear_provider_cache,
    ProviderType,
)


@pytest.fixture(autouse=True)
def reset_cache():
    clear_provider_cache()
    yield
    clear_provider_cache()


class TestProviderIntegration:
    def test_get_all_provider_types(self):
        """Verify all provider types can be instantiated."""
        for provider_type in ProviderType:
            provider = get_provider(provider_type)
            assert provider.provider_type == provider_type

    @pytest.mark.asyncio
    async def test_claude_availability_check(self):
        """Test Claude availability check doesn't crash."""
        result = await check_provider_availability(ProviderType.CLAUDE)
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_codex_availability_check(self):
        """Test Codex availability check doesn't crash."""
        result = await check_provider_availability(ProviderType.CODEX)
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    @patch("backend.providers.claude.provider.get_tool_path")
    @patch("backend.providers.codex.provider.get_tool_path")
    async def test_get_available_providers_filters(
        self, mock_codex_path, mock_claude_path
    ):
        """Test that only available providers are returned."""
        clear_provider_cache()
        mock_claude_path.return_value = "/usr/bin/claude"
        mock_codex_path.return_value = None

        # Mock the version check for Claude
        with patch("asyncio.create_subprocess_exec") as mock_subprocess:
            mock_process = AsyncMock()
            mock_process.returncode = 0
            mock_process.communicate = AsyncMock(return_value=(b"claude 1.0", b""))
            mock_subprocess.return_value = mock_process

            available = await get_available_providers()

            # Should include Claude, not Codex
            assert ProviderType.CLAUDE in available
            assert ProviderType.CODEX not in available

    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_get_first_available_priority(self, mock_check):
        """Test that Claude is preferred over Codex."""
        clear_provider_cache()

        async def availability(provider_type):
            return provider_type in (ProviderType.CLAUDE, ProviderType.CODEX)

        mock_check.side_effect = availability

        provider = await get_first_available_provider()
        assert provider is not None
        assert provider.provider_type == ProviderType.CLAUDE
