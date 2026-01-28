"""Codex CLI client implementation."""
import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Optional

from ..base import AIClient
from ..platform_support import get_tool_path
from .transport import JsonRpcTransport


@dataclass
class CodexClientOptions:
    """Codex-specific client configuration."""
    system_prompt: str
    model: str = "gpt-5.2"
    thread_id: Optional[str] = None
    working_dir: Optional[str] = None
    approval_policy: str = "auto-edit"
    sandbox: str = "on"


class CodexClient(AIClient):
    """Client for Codex CLI app-server."""

    def __init__(self, options: CodexClientOptions):
        self._options = options
        self._transport: Optional[JsonRpcTransport] = None
        self._session_id: Optional[str] = None
        self._response_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._connected = False

    async def _handle_notification(self, msg: dict[str, Any]) -> None:
        """Handle incoming notifications from the server."""
        await self._response_queue.put(msg)

    async def connect(self) -> None:
        """Start the Codex app-server."""
        if self._connected:
            return

        codex_path = get_tool_path("codex")
        if not codex_path:
            raise RuntimeError("Codex CLI not found. Install from OpenAI.")

        cmd = [
            codex_path,
            "app-server",
            "--model", self._options.model,
            "--approval-policy", self._options.approval_policy,
            "--sandbox", self._options.sandbox,
        ]

        self._transport = JsonRpcTransport(
            command=cmd,
            on_notification=self._handle_notification,
            working_dir=self._options.working_dir,
        )

        await self._transport.start()
        self._connected = True

        if self._options.thread_id:
            try:
                await self._transport.send_request(
                    "session/resume",
                    {"thread_id": self._options.thread_id},
                )
            except Exception:
                pass  # Continue without resumption

    async def disconnect(self) -> None:
        """Stop the Codex app-server."""
        if self._transport:
            await self._transport.shutdown()
            self._transport = None
        self._connected = False

    async def query(self, message: str) -> None:
        """Send a message to the Codex server."""
        if not self._transport or not self._transport.is_healthy:
            raise RuntimeError("Client not connected")

        await self._transport.send_notification(
            "chat/message",
            {
                "content": message,
                "system_prompt": self._options.system_prompt,
            },
        )

    async def receive_response(self) -> AsyncIterator[dict[str, Any]]:
        """Iterate over response notifications."""
        while True:
            try:
                msg = await asyncio.wait_for(
                    self._response_queue.get(),
                    timeout=60.0,
                )

                if "params" in msg:
                    params = msg["params"]
                    if "thread_id" in params:
                        self._session_id = params["thread_id"]

                yield msg

                method = msg.get("method", "")
                if method in ("chat/complete", "chat/error"):
                    break

            except asyncio.TimeoutError:
                yield {"method": "chat/error", "params": {"error": "Response timeout"}}
                break

    async def interrupt(self) -> None:
        """Cancel the current operation."""
        if self._transport and self._transport.is_healthy:
            try:
                await self._transport.send_notification("chat/cancel", {})
            except Exception:
                pass

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def is_connected(self) -> bool:
        return self._connected and self._transport is not None

    @property
    def options(self) -> CodexClientOptions:
        return self._options
