"""Codex provider implementation."""
import asyncio

from ..base import AIClientOptions, AIProvider, AIStreamParser, ProviderType
from ..platform_support import get_tool_path
from .client import CodexClient, CodexClientOptions
from .parser import CodexStreamParser


class CodexProvider(AIProvider):
    """Codex CLI provider - alternative AI backend using OpenAI's Codex."""

    def __init__(self):
        self._parser = CodexStreamParser()

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.CODEX

    def create_client(self, options: CodexClientOptions) -> CodexClient:
        return CodexClient(options)

    def build_options(self, base_options: AIClientOptions) -> CodexClientOptions:
        return CodexClientOptions(
            system_prompt=base_options.system_prompt,
            model=base_options.model,
            thread_id=base_options.session_id,
            working_dir=base_options.working_dir,
        )

    def get_parser(self) -> AIStreamParser:
        return self._parser

    async def check_availability(self) -> bool:
        """Check if Codex CLI is available and authenticated."""
        codex_path = get_tool_path("codex")
        if not codex_path:
            return False

        try:
            proc = await asyncio.create_subprocess_exec(
                codex_path, "login", "status",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)

            if proc.returncode != 0:
                return False

            output = stdout.decode("utf-8", errors="ignore").lower()
            return "logged in" in output
        except (asyncio.TimeoutError, Exception):
            return False
