"""ClaudeOS Backend Entry Point."""
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from backend.api.websocket import websocket_endpoint

app = FastAPI(title="ClaudeOS", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/providers")
async def list_providers():
    """List available AI providers."""
    from backend.providers import get_available_providers
    available = await get_available_providers()
    return {"providers": [p.value for p in available]}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    """WebSocket endpoint for agent communication."""
    await websocket_endpoint(websocket)
