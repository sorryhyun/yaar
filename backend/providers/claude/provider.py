"""Claude Code provider implementation."""
import asyncio

from ..base import AIClientOptions, AIProvider, AIStreamParser, ProviderType
from ..platform_support import get_tool_path
from .client import ClaudeClient, ClaudeClientOptions
from .parser import ClaudeStreamParser


class ClaudeProvider(AIProvider):
    """Claude Code CLI provider - the primary AI backend for ClaudeOS."""

    def __init__(self):
        self._parser = ClaudeStreamParser()

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.CLAUDE

    def create_client(self, options: ClaudeClientOptions) -> ClaudeClient:
        return ClaudeClient(options)

    def build_options(self, base_options: AIClientOptions) -> ClaudeClientOptions:
        return ClaudeClientOptions(
            system_prompt=base_options.system_prompt,
            model=base_options.model,
            resume=base_options.session_id,
            working_dir=base_options.working_dir,
        )

    def get_parser(self) -> AIStreamParser:
        return self._parser

    async def check_availability(self) -> bool:
        """Check if Claude CLI is available."""
        claude_path = get_tool_path("claude")
        if not claude_path:
            return False

        try:
            proc = await asyncio.create_subprocess_exec(
                claude_path, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
            return proc.returncode == 0 and len(stdout) > 0
        except (asyncio.TimeoutError, Exception):
            return False
