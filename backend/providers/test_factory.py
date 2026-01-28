"""Tests for provider factory."""
import pytest
from unittest.mock import patch, AsyncMock

from backend.providers.base import ProviderType
from backend.providers.factory import (
    get_provider,
    check_provider_availability,
    get_available_providers,
    get_first_available_provider,
    clear_provider_cache,
)


@pytest.fixture(autouse=True)
def clear_cache():
    """Clear provider cache before each test."""
    clear_provider_cache()
    yield
    clear_provider_cache()


class TestGetProvider:
    def test_get_claude_provider(self):
        provider = get_provider(ProviderType.CLAUDE)
        assert provider.provider_type == ProviderType.CLAUDE

    def test_get_codex_provider(self):
        provider = get_provider(ProviderType.CODEX)
        assert provider.provider_type == ProviderType.CODEX

    def test_string_lookup(self):
        provider = get_provider("claude")
        assert provider.provider_type == ProviderType.CLAUDE

    def test_case_insensitive(self):
        provider = get_provider("CLAUDE")
        assert provider.provider_type == ProviderType.CLAUDE

    def test_invalid_string_raises(self):
        with pytest.raises(ValueError, match="Unknown provider type"):
            get_provider("invalid")

    def test_caching(self):
        provider1 = get_provider(ProviderType.CLAUDE)
        provider2 = get_provider(ProviderType.CLAUDE)
        assert provider1 is provider2  # Same instance

    def test_different_providers_not_cached_together(self):
        claude = get_provider(ProviderType.CLAUDE)
        codex = get_provider(ProviderType.CODEX)
        assert claude is not codex


class TestCheckProviderAvailability:
    @pytest.mark.asyncio
    async def test_claude_availability(self):
        # Result depends on whether claude CLI is installed
        result = await check_provider_availability(ProviderType.CLAUDE)
        assert isinstance(result, bool)

    @pytest.mark.asyncio
    async def test_invalid_provider_returns_false(self):
        result = await check_provider_availability("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    @patch("backend.providers.claude.provider.get_tool_path")
    async def test_claude_available_when_cli_exists(self, mock_get_tool_path):
        clear_provider_cache()
        mock_get_tool_path.return_value = "/usr/local/bin/claude"
        result = await check_provider_availability(ProviderType.CLAUDE)
        assert result is True

    @pytest.mark.asyncio
    @patch("backend.providers.claude.provider.get_tool_path")
    async def test_claude_unavailable_when_cli_missing(self, mock_get_tool_path):
        clear_provider_cache()
        mock_get_tool_path.return_value = None
        result = await check_provider_availability(ProviderType.CLAUDE)
        assert result is False


class TestGetAvailableProviders:
    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_returns_available_only(self, mock_check):
        async def mock_availability(provider_type):
            return provider_type == ProviderType.CLAUDE

        mock_check.side_effect = mock_availability

        available = await get_available_providers()
        assert ProviderType.CLAUDE in available
        assert ProviderType.CODEX not in available

    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_returns_empty_when_none_available(self, mock_check):
        mock_check.return_value = False
        available = await get_available_providers()
        assert available == []


class TestGetFirstAvailableProvider:
    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_returns_claude_first(self, mock_check):
        async def mock_availability(provider_type):
            return provider_type in (ProviderType.CLAUDE, ProviderType.CODEX)

        mock_check.side_effect = mock_availability

        provider = await get_first_available_provider()
        assert provider is not None
        assert provider.provider_type == ProviderType.CLAUDE

    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_falls_back_to_codex(self, mock_check):
        async def mock_availability(provider_type):
            return provider_type == ProviderType.CODEX

        mock_check.side_effect = mock_availability

        provider = await get_first_available_provider()
        assert provider is not None
        assert provider.provider_type == ProviderType.CODEX

    @pytest.mark.asyncio
    @patch("backend.providers.factory.check_provider_availability")
    async def test_returns_none_when_all_unavailable(self, mock_check):
        mock_check.return_value = False
        provider = await get_first_available_provider()
        assert provider is None


class TestClearProviderCache:
    def test_clears_cache(self):
        provider1 = get_provider(ProviderType.CLAUDE)
        clear_provider_cache()
        provider2 = get_provider(ProviderType.CLAUDE)
        assert provider1 is not provider2  # Different instances
