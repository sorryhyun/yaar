"""JSON-RPC 2.0 transport over subprocess stdio.

The Codex app-server communicates using JSON-RPC messages over stdin/stdout.
"""
import asyncio
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional


@dataclass
class JsonRpcError(Exception):
    """JSON-RPC error response."""
    code: int
    message: str
    data: Optional[Any] = None


class JsonRpcTransport:
    """JSON-RPC 2.0 transport over subprocess stdio."""

    def __init__(
        self,
        command: list[str],
        on_notification: Callable[[dict[str, Any]], Awaitable[None]],
        working_dir: Optional[str] = None,
    ):
        self._command = command
        self._on_notification = on_notification
        self._working_dir = working_dir
        self._process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._write_lock = asyncio.Lock()

    @property
    def is_started(self) -> bool:
        return self._process is not None

    @property
    def is_healthy(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        """Start the subprocess and begin reading responses."""
        if self._process is not None:
            return

        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._working_dir,
        )

        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Read and dispatch messages from stdout."""
        if not self._process or not self._process.stdout:
            return

        try:
            async for line in self._process.stdout:
                line = line.strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue

                await self._handle_message(msg)
        except asyncio.CancelledError:
            pass

    async def _handle_message(self, msg: dict[str, Any]) -> None:
        """Route a message to the appropriate handler."""
        msg_id = msg.get("id")

        if msg_id is not None and msg_id in self._pending:
            # Response to a pending request
            future = self._pending.pop(msg_id)

            if "error" in msg:
                error = msg["error"]
                future.set_exception(JsonRpcError(
                    code=error.get("code", -1),
                    message=error.get("message", "Unknown error"),
                    data=error.get("data"),
                ))
            else:
                future.set_result(msg.get("result", {}))

        elif "method" in msg:
            # Notification (no id field)
            await self._on_notification(msg)

    async def send_request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Send a request and wait for response."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Transport not started")

        self._request_id += 1
        request_id = self._request_id

        request = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params:
            request["params"] = params

        loop = asyncio.get_event_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future

        try:
            async with self._write_lock:
                self._process.stdin.write(json.dumps(request).encode() + b"\n")
                await self._process.stdin.drain()

            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            raise

    async def send_notification(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
    ) -> None:
        """Send a notification (no response expected)."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Transport not started")

        notification = {"jsonrpc": "2.0", "method": method}
        if params:
            notification["params"] = params

        async with self._write_lock:
            self._process.stdin.write(json.dumps(notification).encode() + b"\n")
            await self._process.stdin.drain()

    async def shutdown(self) -> None:
        """Stop the transport and clean up."""
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            self._reader_task = None

        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

        if self._process:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
            self._process = None
