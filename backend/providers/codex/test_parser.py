"""Tests for Codex stream parser."""
import pytest
from backend.providers.codex.parser import CodexStreamParser


class TestCodexStreamParser:
    def test_parse_text_message(self):
        message = {"method": "chat/text", "params": {"text": "Hello!"}}
        result = CodexStreamParser.parse_message(message, "", "")

        assert result.response_text == "Hello!"
        assert result.is_complete is False

    def test_accumulates_text(self):
        message = {"method": "chat/text", "params": {"text": " World!"}}
        result = CodexStreamParser.parse_message(message, "Hello", "")

        assert result.response_text == "Hello World!"

    def test_parse_complete(self):
        message = {"method": "chat/complete", "params": {"thread_id": "thread-123"}}
        result = CodexStreamParser.parse_message(message, "Done", "")

        assert result.is_complete is True
        assert result.session_id == "thread-123"

    def test_extract_actions(self):
        text = '''Creating window:
```json
{"type": "window.create", "windowId": "w1", "title": "Test", "bounds": {"x": 0, "y": 0, "w": 400, "h": 300}, "content": {"renderer": "text", "data": ""}}
```
'''
        result = CodexStreamParser.parse_message(
            {"method": "chat/text", "params": {"text": text}},
            "", ""
        )

        assert len(result.actions) == 1
        assert result.actions[0]["type"] == "window.create"
