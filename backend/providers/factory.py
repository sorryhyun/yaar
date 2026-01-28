"""Provider factory - creates and caches provider instances.

The factory provides:
1. Lazy instantiation of providers
2. Caching of provider instances (singleton per type)
3. Availability checking before use
4. Automatic fallback selection
"""
from typing import Union

from .base import AIProvider, ProviderType

# Singleton cache for provider instances
_providers: dict[ProviderType, AIProvider] = {}


def get_provider(provider_type: Union[str, ProviderType]) -> AIProvider:
    """Get or create a cached provider instance.

    Providers are lazily instantiated and cached. Subsequent calls
    with the same type return the cached instance.

    Args:
        provider_type: Provider identifier (string or enum)

    Returns:
        Cached AIProvider instance

    Raises:
        ValueError: If provider type is unknown or invalid
    """
    # Normalize string to enum
    if isinstance(provider_type, str):
        try:
            provider_type = ProviderType(provider_type.lower())
        except ValueError:
            raise ValueError(
                f"Unknown provider type: {provider_type}. "
                f"Valid types: {[p.value for p in ProviderType]}"
            )

    # Return cached instance if available
    if provider_type in _providers:
        return _providers[provider_type]

    # Lazy import and instantiate provider
    provider: AIProvider
    if provider_type == ProviderType.CLAUDE:
        from .claude import ClaudeProvider
        provider = ClaudeProvider()
    elif provider_type == ProviderType.CODEX:
        from .codex import CodexProvider
        provider = CodexProvider()
    else:
        raise ValueError(f"Unhandled provider type: {provider_type}")

    # Cache and return
    _providers[provider_type] = provider
    return provider


async def check_provider_availability(provider_type: Union[str, ProviderType]) -> bool:
    """Check if a provider is available for use.

    This checks that:
    - Required binaries exist (for CLI-based providers)
    - Authentication is valid (where applicable)
    - Any other provider-specific requirements

    Args:
        provider_type: Provider identifier

    Returns:
        True if provider is available and ready, False otherwise
    """
    try:
        provider = get_provider(provider_type)
        return await provider.check_availability()
    except (ValueError, ImportError) as e:
        # Provider not implemented or invalid
        return False
    except Exception:
        # Any other error means provider is not available
        return False


async def get_available_providers() -> list[ProviderType]:
    """Get list of all currently available providers.

    Checks each known provider type and returns those that
    are available for use.

    Returns:
        List of available ProviderType values
    """
    available = []
    for provider_type in ProviderType:
        if await check_provider_availability(provider_type):
            available.append(provider_type)
    return available


async def get_first_available_provider() -> AIProvider | None:
    """Get the first available provider, checking in priority order.

    Priority order: Claude > Codex

    Returns:
        First available AIProvider instance, or None if none available
    """
    priority = [ProviderType.CLAUDE, ProviderType.CODEX]

    for provider_type in priority:
        if await check_provider_availability(provider_type):
            return get_provider(provider_type)

    return None


def clear_provider_cache() -> None:
    """Clear the provider cache.

    Useful for testing or when providers need to be reinitialized.
    """
    _providers.clear()
