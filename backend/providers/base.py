"""AI Provider abstraction layer - base interfaces."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional


class ProviderType(str, Enum):
    """Supported AI provider types."""
    CLAUDE = "claude"
    CODEX = "codex"


@dataclass
class AIClientOptions:
    """Provider-agnostic client configuration.

    This is the common configuration that gets translated
    into provider-specific options by each provider.
    """
    system_prompt: str
    model: str
    session_id: Optional[str] = None
    mcp_tools: Dict[str, Any] = field(default_factory=dict)
    max_thinking_tokens: int = 32768
    working_dir: Optional[str] = None


@dataclass
class ParsedStreamMessage:
    """Unified parser output from any provider's stream.

    Each provider's parser converts its native format into this
    common structure for the orchestrator to consume.
    """
    response_text: str
    thinking_text: str
    session_id: Optional[str] = None
    actions: List[Dict[str, Any]] = field(default_factory=list)  # OS Actions DSL
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    is_complete: bool = False
    error: Optional[str] = None


class AIStreamParser(ABC):
    """Abstract parser for provider-specific stream formats.

    Each provider implements this to convert its native streaming
    format into ParsedStreamMessage instances.
    """

    @staticmethod
    @abstractmethod
    def parse_message(
        message: Any,
        current_response: str,
        current_thinking: str,
    ) -> ParsedStreamMessage:
        """Parse a single message from the provider's stream.

        Args:
            message: Raw message from provider (format varies by provider)
            current_response: Accumulated response text so far
            current_thinking: Accumulated thinking text so far

        Returns:
            ParsedStreamMessage with updated state
        """
        ...


class AIClient(ABC):
    """Abstract client for interacting with an AI provider.

    Manages the connection lifecycle and message exchange
    with a specific provider instance.
    """

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the provider.

        For subprocess-based providers (Claude, Codex), this spawns
        the process. For API-based providers, this may be a no-op.
        """
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        """Clean up connection and release resources.

        Terminates subprocesses, closes sockets, etc.
        """
        ...

    @abstractmethod
    async def query(self, message: str) -> None:
        """Send a user message to the provider.

        Args:
            message: User's input message
        """
        ...

    @abstractmethod
    def receive_response(self) -> AsyncIterator[Any]:
        """Iterate over response messages from the provider.

        Yields:
            Raw messages in provider's native format
        """
        ...

    @abstractmethod
    async def interrupt(self) -> None:
        """Interrupt the current generation.

        Sends appropriate signal to stop the provider's output.
        """
        ...

    @property
    @abstractmethod
    def session_id(self) -> Optional[str]:
        """Get the current session/conversation ID.

        Returns:
            Session ID if established, None otherwise
        """
        ...


class AIProvider(ABC):
    """Abstract factory for creating AI clients.

    Each provider type (Claude, Codex, Custom) implements this
    to provide its specific client and parser implementations.
    """

    @property
    @abstractmethod
    def provider_type(self) -> ProviderType:
        """Get this provider's type identifier."""
        ...

    @abstractmethod
    def create_client(self, options: Any) -> AIClient:
        """Create a new client instance.

        Args:
            options: Provider-specific options (e.g., ClaudeClientOptions)

        Returns:
            Configured AIClient instance
        """
        ...

    @abstractmethod
    def build_options(self, base_options: AIClientOptions) -> Any:
        """Convert generic options to provider-specific options.

        Args:
            base_options: Provider-agnostic AIClientOptions

        Returns:
            Provider-specific options object
        """
        ...

    @abstractmethod
    def get_parser(self) -> AIStreamParser:
        """Get the stream parser for this provider.

        Returns:
            Parser instance for converting native format to ParsedStreamMessage
        """
        ...

    @abstractmethod
    async def check_availability(self) -> bool:
        """Check if this provider is available for use.

        Verifies that required binaries exist, authentication is valid, etc.

        Returns:
            True if provider can be used, False otherwise
        """
        ...
