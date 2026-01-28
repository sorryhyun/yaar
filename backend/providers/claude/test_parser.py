"""Tests for Claude stream parser - focusing on action extraction."""
import pytest
from backend.providers.claude.parser import ClaudeStreamParser


class TestActionExtraction:
    """The parser's main job is extracting OS actions from AI responses."""

    def test_extracts_window_create(self):
        text = '''I'll create a window for you:
```json
{"type": "window.create", "windowId": "w1", "title": "Hello", "bounds": {"x": 100, "y": 100, "w": 400, "h": 300}, "content": {"renderer": "markdown", "data": "# Hello"}}
```
'''
        result = ClaudeStreamParser.parse_message(
            {"type": "assistant", "content": text}, "", ""
        )

        assert len(result.actions) == 1
        assert result.actions[0]["type"] == "window.create"
        assert result.actions[0]["windowId"] == "w1"

    def test_extracts_multiple_actions(self):
        text = '''Creating your dashboard:
```json
{"type": "window.create", "windowId": "w1", "title": "Tasks", "bounds": {"x": 50, "y": 50, "w": 300, "h": 400}, "content": {"renderer": "markdown", "data": "# Tasks"}}
```
And a notification:
```json
{"type": "toast.show", "id": "t1", "message": "Dashboard ready!", "variant": "success"}
```
'''
        result = ClaudeStreamParser.parse_message(
            {"type": "assistant", "content": text}, "", ""
        )

        assert len(result.actions) == 2
        assert result.actions[0]["type"] == "window.create"
        assert result.actions[1]["type"] == "toast.show"

    def test_ignores_non_action_json(self):
        text = '''Here's some data:
```json
{"name": "test", "value": 42}
```
'''
        result = ClaudeStreamParser.parse_message(
            {"type": "assistant", "content": text}, "", ""
        )

        assert len(result.actions) == 0

    def test_handles_malformed_json(self):
        text = '''Oops:
```json
{"type": "window.create", broken
```
'''
        result = ClaudeStreamParser.parse_message(
            {"type": "assistant", "content": text}, "", ""
        )

        assert len(result.actions) == 0  # Gracefully skip bad JSON


class TestStreamParsing:
    def test_accumulates_response_text(self):
        result = ClaudeStreamParser.parse_message(
            {"type": "assistant", "content": "Hello "},
            "Previous ",
            ""
        )
        assert result.response_text == "Previous Hello "

    def test_detects_completion(self):
        result = ClaudeStreamParser.parse_message(
            {"type": "result", "session_id": "sess-123"},
            "Final response",
            ""
        )
        assert result.is_complete is True
        assert result.session_id == "sess-123"

    def test_captures_errors(self):
        result = ClaudeStreamParser.parse_message(
            {"type": "error", "error": "Rate limited"},
            "", ""
        )
        assert result.error == "Rate limited"
        assert result.is_complete is True
