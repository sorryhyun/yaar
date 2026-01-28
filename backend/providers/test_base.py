"""Tests for provider base interfaces."""
import pytest
from dataclasses import asdict

from backend.providers.base import (
    AIClientOptions,
    ParsedStreamMessage,
    ProviderType,
)


class TestProviderType:
    def test_enum_values(self):
        assert ProviderType.CLAUDE == "claude"
        assert ProviderType.CODEX == "codex"

    def test_from_string(self):
        assert ProviderType("claude") == ProviderType.CLAUDE
        assert ProviderType("codex") == ProviderType.CODEX

    def test_invalid_raises(self):
        with pytest.raises(ValueError):
            ProviderType("invalid")


class TestAIClientOptions:
    def test_required_fields(self):
        options = AIClientOptions(
            system_prompt="You are helpful.",
            model="claude-sonnet-4-20250514",
        )
        assert options.system_prompt == "You are helpful."
        assert options.model == "claude-sonnet-4-20250514"

    def test_defaults(self):
        options = AIClientOptions(
            system_prompt="test",
            model="test-model",
        )
        assert options.session_id is None
        assert options.mcp_tools == {}
        assert options.max_thinking_tokens == 32768
        assert options.working_dir is None

    def test_optional_fields(self):
        options = AIClientOptions(
            system_prompt="test",
            model="test-model",
            session_id="session-123",
            max_thinking_tokens=16384,
            working_dir="/tmp/test",
        )
        assert options.session_id == "session-123"
        assert options.max_thinking_tokens == 16384
        assert options.working_dir == "/tmp/test"


class TestParsedStreamMessage:
    def test_defaults(self):
        msg = ParsedStreamMessage(
            response_text="Hello",
            thinking_text="",
        )
        assert msg.response_text == "Hello"
        assert msg.thinking_text == ""
        assert msg.session_id is None
        assert msg.actions == []
        assert msg.tool_calls == []
        assert msg.is_complete is False
        assert msg.error is None

    def test_with_actions(self):
        actions = [{"type": "window.create", "windowId": "w1"}]
        msg = ParsedStreamMessage(
            response_text="Creating window",
            thinking_text="I should create a window",
            actions=actions,
        )
        assert msg.actions == actions

    def test_serializable(self):
        msg = ParsedStreamMessage(
            response_text="test",
            thinking_text="thinking",
            session_id="sess-1",
            is_complete=True,
        )
        data = asdict(msg)
        assert data["response_text"] == "test"
        assert data["session_id"] == "sess-1"
        assert data["is_complete"] is True
