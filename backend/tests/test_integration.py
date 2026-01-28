"""Integration tests for ClaudeOS backend."""
import pytest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app


class TestHealthEndpoint:
    def test_health_returns_ok(self):
        client = TestClient(app)
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestProvidersEndpoint:
    def test_list_providers(self):
        client = TestClient(app)
        response = client.get("/api/providers")
        assert response.status_code == 200
        data = response.json()
        assert "providers" in data
        assert isinstance(data["providers"], list)


class TestWebSocket:
    def test_websocket_connects(self):
        client = TestClient(app)

        with patch("backend.api.websocket.get_first_available_provider") as mock_provider:
            # Mock provider setup
            mock_provider.return_value = None  # No provider available

            with client.websocket_connect("/ws") as websocket:
                # Should receive error about no provider
                data = websocket.receive_json()
                assert data["type"] == "ERROR"
