"""Claude Code CLI client implementation.

Manages subprocess lifecycle and communication with the Claude CLI
using stream-json output format.
"""
import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

from ..base import AIClient
from ..platform_support import get_tool_path, is_windows


@dataclass
class ClaudeClientOptions:
    """Claude-specific client configuration."""
    system_prompt: str
    model: str = "claude-opus-4-5-20251101"
    resume: Optional[str] = None  # Session ID to resume
    working_dir: Optional[str] = None


class ClaudeClient(AIClient):
    """Client for Claude Code CLI.

    Spawns the `claude` CLI as a subprocess and communicates via
    stdin/stdout using the stream-json output format.
    """

    def __init__(self, options: ClaudeClientOptions):
        self._options = options
        self._process: Optional[asyncio.subprocess.Process] = None
        self._session_id: Optional[str] = None
        self._connected = False

    async def connect(self) -> None:
        """Spawn the Claude CLI process."""
        if self._connected:
            return

        claude_path = get_tool_path("claude")
        if not claude_path:
            raise RuntimeError(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
            )

        # Build command arguments
        cmd = [claude_path]

        # Session resumption
        if self._options.resume:
            cmd.extend(["--resume", self._options.resume])

        # Model selection
        cmd.extend(["--model", self._options.model])

        # Output format for machine consumption
        cmd.extend(["--output-format", "stream-json"])

        # Non-interactive mode
        cmd.append("--print")

        # System prompt via environment
        env = os.environ.copy()
        if self._options.system_prompt:
            env["CLAUDE_SYSTEM_PROMPT"] = self._options.system_prompt

        # Create subprocess
        if is_windows():
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._options.working_dir,
                env=env,
                creationflags=asyncio.subprocess.CREATE_NO_WINDOW,  # type: ignore
            )
        else:
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._options.working_dir,
                env=env,
            )

        self._connected = True

    async def disconnect(self) -> None:
        """Terminate the Claude CLI process."""
        if self._process:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
            finally:
                self._process = None
                self._connected = False

    async def query(self, message: str) -> None:
        """Send a message to the Claude CLI."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Client not connected. Call connect() first.")

        self._process.stdin.write(message.encode("utf-8") + b"\n")
        await self._process.stdin.drain()

    async def receive_response(self) -> AsyncIterator[dict[str, Any]]:
        """Iterate over JSON events from stdout."""
        if not self._process or not self._process.stdout:
            return

        async for line in self._process.stdout:
            line = line.strip()
            if not line:
                continue

            try:
                event = json.loads(line.decode("utf-8"))

                # Extract session ID from system messages
                if event.get("type") == "system":
                    if "session_id" in event:
                        self._session_id = event["session_id"]

                yield event

                # Check for completion
                if event.get("type") == "result":
                    break

            except json.JSONDecodeError as e:
                yield {"type": "error", "error": f"JSON parse error: {e}"}

    async def interrupt(self) -> None:
        """Send interrupt signal to stop generation."""
        if self._process:
            if is_windows():
                self._process.terminate()
            else:
                self._process.send_signal(2)  # SIGINT

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def is_connected(self) -> bool:
        return self._connected and self._process is not None

    @property
    def options(self) -> ClaudeClientOptions:
        return self._options
