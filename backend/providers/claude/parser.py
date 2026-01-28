"""Claude Code stream-json parser.

Parses the stream-json output format and extracts OS actions
that the AI emits to control the desktop.
"""
import json
import re
from typing import Any

from ..base import AIStreamParser, ParsedStreamMessage


class ClaudeStreamParser(AIStreamParser):
    """Parser for Claude Code's stream-json format.

    The key job: extract OS Action JSON blocks from the AI's response text.
    These actions tell the frontend what to display.
    """

    # Pattern to find OS Action JSON blocks in response
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
        """Parse a single stream event."""
        event_type = message.get("type", "")
        actions: list[dict[str, Any]] = []
        tool_calls: list[dict[str, Any]] = []
        session_id = message.get("session_id")
        is_complete = False
        error = None

        if event_type == "system":
            session_id = message.get("session_id", session_id)

        elif event_type == "assistant":
            content = message.get("content", "")
            if isinstance(content, str):
                current_response += content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            current_response += block.get("text", "")
                        elif block.get("type") == "tool_use":
                            tool_calls.append(block)

            # Extract OS Actions - this is the key part!
            actions = ClaudeStreamParser._extract_actions(current_response)

        elif event_type == "thinking":
            thinking_content = message.get("content", "")
            if isinstance(thinking_content, str):
                current_thinking += thinking_content

        elif event_type == "tool_use":
            tool_calls.append({
                "id": message.get("id"),
                "name": message.get("name"),
                "input": message.get("input", {}),
            })

        elif event_type == "result":
            is_complete = True
            session_id = message.get("session_id", session_id)

        elif event_type == "error":
            error = message.get("error", "Unknown error")
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
        """Extract OS Action JSON blocks from response text.

        The AI emits actions like:
        ```json
        {"type": "window.create", "windowId": "w1", "title": "Hello", ...}
        ```

        We find and parse these to control the UI.
        """
        actions = []

        for match in ClaudeStreamParser.ACTION_PATTERN.finditer(text):
            try:
                action = json.loads(match.group(1))
                if isinstance(action, dict) and "type" in action:
                    action_type = action.get("type", "")
                    if action_type.startswith(("window.", "notification.", "toast.")):
                        actions.append(action)
            except json.JSONDecodeError:
                continue

        return actions
