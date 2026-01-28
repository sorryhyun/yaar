"""Codex stream parser.

Same pattern as Claude: extract OS actions from the AI's response.
"""
import json
import re
from typing import Any

from ..base import AIStreamParser, ParsedStreamMessage


class CodexStreamParser(AIStreamParser):
    """Parser for Codex app-server notifications."""

    ACTION_PATTERN = re.compile(
        r'```(?:json)?\s*\n(\{[^`]*"type"\s*:\s*"(?:window|notification|toast)[^`]*\})\s*\n```',
        re.MULTILINE | re.DOTALL
    )

    @staticmethod
    def parse_message(
        message: dict[str, Any],
        current_response: str,
        current_thinking: str,
    ) -> ParsedStreamMessage:
        """Parse a Codex notification message."""
        method = message.get("method", "")
        params = message.get("params", {})
        actions: list[dict[str, Any]] = []
        tool_calls: list[dict[str, Any]] = []
        session_id = params.get("thread_id")
        is_complete = False
        error = None

        if method == "chat/text":
            text = params.get("text", "")
            current_response += text
            actions = CodexStreamParser._extract_actions(current_response)

        elif method == "chat/thinking":
            thinking = params.get("text", "")
            current_thinking += thinking

        elif method == "chat/tool_call":
            tool_calls.append({
                "id": params.get("id"),
                "name": params.get("name"),
                "input": params.get("arguments", {}),
            })

        elif method == "chat/complete":
            is_complete = True
            session_id = params.get("thread_id", session_id)

        elif method == "chat/error":
            error = params.get("error", "Unknown error")
            is_complete = True

        return ParsedStreamMessage(
            response_text=current_response,
            thinking_text=current_thinking,
            session_id=session_id,
            actions=actions,
            tool_calls=tool_calls,
            is_complete=is_complete,
            error=error,
        )

    @staticmethod
    def _extract_actions(text: str) -> list[dict[str, Any]]:
        """Extract OS Action JSON blocks from response text."""
        actions = []

        for match in CodexStreamParser.ACTION_PATTERN.finditer(text):
            try:
                action = json.loads(match.group(1))
                if isinstance(action, dict) and "type" in action:
                    action_type = action.get("type", "")
                    if action_type.startswith(("window.", "notification.", "toast.")):
                        actions.append(action)
            except json.JSONDecodeError:
                continue

        return actions
