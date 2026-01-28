"""WebSocket handler for agent communication."""
import json
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from backend.providers import (
    get_provider,
    get_first_available_provider,
    check_provider_availability,
    AIClientOptions,
    ProviderType,
)


class AgentSession:
    """Manages a single WebSocket session with an AI provider."""

    def __init__(self, websocket: WebSocket):
        self.ws = websocket
        self.provider = None
        self.client = None
        self._running = False

    async def initialize(self) -> bool:
        """Initialize with the first available provider."""
        self.provider = await get_first_available_provider()

        if not self.provider:
            await self.send_event({
                "type": "ERROR",
                "error": "No AI provider available. Install Claude CLI or Codex.",
            })
            return False

        # Build options and create client
        base_options = AIClientOptions(
            system_prompt=self._build_system_prompt(),
            model=self._get_default_model(),
        )
        options = self.provider.build_options(base_options)
        self.client = self.provider.create_client(options)

        try:
            await self.client.connect()
            await self.send_event({
                "type": "CONNECTION_STATUS",
                "status": "connected",
                "provider": self.provider.provider_type.value,
                "sessionId": self.client.session_id,
            })
            return True
        except Exception as e:
            await self.send_event({
                "type": "ERROR",
                "error": f"Failed to connect to provider: {e}",
            })
            return False

    async def handle_message(self, content: str) -> None:
        """Process a user message through the AI provider."""
        if not self.client:
            return

        self._running = True

        try:
            await self.client.query(content)

            parser = self.provider.get_parser()
            response_text = ""
            thinking_text = ""

            async for message in self.client.receive_response():
                if not self._running:
                    break

                parsed = parser.parse_message(message, response_text, thinking_text)
                response_text = parsed.response_text
                thinking_text = parsed.thinking_text

                # Send thinking updates
                if parsed.thinking_text != thinking_text:
                    await self.send_event({
                        "type": "AGENT_THINKING",
                        "content": thinking_text,
                    })

                # Send actions to frontend
                if parsed.actions:
                    await self.send_event({
                        "type": "ACTIONS",
                        "actions": parsed.actions,
                    })

                # Send response chunks
                await self.send_event({
                    "type": "AGENT_RESPONSE",
                    "content": response_text,
                    "isComplete": parsed.is_complete,
                })

                # Handle errors
                if parsed.error:
                    await self.send_event({
                        "type": "ERROR",
                        "error": parsed.error,
                    })
                    break

                # Update session ID
                if parsed.session_id:
                    await self.send_event({
                        "type": "CONNECTION_STATUS",
                        "status": "connected",
                        "provider": self.provider.provider_type.value,
                        "sessionId": parsed.session_id,
                    })

        except Exception as e:
            await self.send_event({
                "type": "ERROR",
                "error": str(e),
            })
        finally:
            self._running = False

    async def interrupt(self) -> None:
        """Interrupt the current operation."""
        self._running = False
        if self.client:
            await self.client.interrupt()

    async def set_provider(self, provider_type: str) -> None:
        """Switch to a different provider."""
        if not await check_provider_availability(provider_type):
            await self.send_event({
                "type": "ERROR",
                "error": f"Provider {provider_type} is not available.",
            })
            return

        # Disconnect current client
        if self.client:
            await self.client.disconnect()

        # Connect to new provider
        self.provider = get_provider(provider_type)
        base_options = AIClientOptions(
            system_prompt=self._build_system_prompt(),
            model=self._get_default_model(),
        )
        options = self.provider.build_options(base_options)
        self.client = self.provider.create_client(options)
        await self.client.connect()

        await self.send_event({
            "type": "CONNECTION_STATUS",
            "status": "connected",
            "provider": self.provider.provider_type.value,
            "sessionId": self.client.session_id,
        })

    async def send_event(self, event: dict[str, Any]) -> None:
        """Send an event to the client."""
        await self.ws.send_json(event)

    async def cleanup(self) -> None:
        """Clean up resources."""
        if self.client:
            await self.client.disconnect()

    def _build_system_prompt(self) -> str:
        """Build the system prompt for the agent."""
        return """You are a desktop agent controlling a web-based OS interface called ClaudeOS.

You control the UI by emitting OS actions as JSON code blocks. Available actions:

## Window Actions
- window.create: Create a new window
  ```json
  {"type": "window.create", "windowId": "unique-id", "title": "Window Title", "bounds": {"x": 100, "y": 100, "w": 400, "h": 300}, "content": {"renderer": "markdown", "data": "# Content"}}
  ```

- window.close: Close a window
  ```json
  {"type": "window.close", "windowId": "window-id"}
  ```

- window.focus: Bring window to front
  ```json
  {"type": "window.focus", "windowId": "window-id"}
  ```

- window.setContent: Update window content
  ```json
  {"type": "window.setContent", "windowId": "window-id", "content": {"renderer": "markdown", "data": "New content"}}
  ```

## Content Renderers
- markdown: Render markdown text
- table: Render tabular data {"headers": [...], "rows": [[...]]}
- html: Render HTML (trusted content only)
- text: Plain text

## Toast/Notification Actions
- toast.show: Show temporary message
  ```json
  {"type": "toast.show", "id": "toast-id", "message": "Hello!", "variant": "success"}
  ```
  Variants: info, success, warning, error

## Guidelines
1. Create windows to display information, results, or interactive content
2. Use appropriate renderers for the content type
3. Keep window IDs consistent for updates
4. Use toasts for quick feedback, notifications for persistent info
5. Be helpful and create a pleasant desktop experience
"""

    def _get_default_model(self) -> str:
        """Get the default model for the current provider."""
        if self.provider and self.provider.provider_type == ProviderType.CODEX:
            return "gpt-4.1"
        return "claude-sonnet-4-20250514"


async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint handler."""
    await websocket.accept()

    session = AgentSession(websocket)

    try:
        # Initialize provider
        if not await session.initialize():
            await websocket.close(1011, "No provider available")
            return

        # Main message loop
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            if message["type"] == "USER_MESSAGE":
                await session.handle_message(message["content"])

            elif message["type"] == "INTERRUPT":
                await session.interrupt()

            elif message["type"] == "SET_PROVIDER":
                await session.set_provider(message["provider"])

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        await session.cleanup()
