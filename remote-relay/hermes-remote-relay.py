#!/usr/bin/env python3
"""Expose the Hermes Desktop backend on a stable private Tailscale port.

Hermes Desktop intentionally starts ``hermes serve`` on loopback and chooses
an ephemeral port. This small relay keeps that security boundary intact while
forwarding the root token page and the JSON-RPC WebSocket to the live backend
recorded in ``spawn-ledger.json``. It is meant to bind to a Tailscale address,
not to the public network.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web


# Bind to loopback unless told otherwise. Set HERMES_RELAY_HOST to the
# machine's Tailscale address to expose the relay to your tailnet only —
# never to 0.0.0.0, which would publish it on every interface.
HOST = os.environ.get("HERMES_RELAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("HERMES_RELAY_PORT", "8644"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
LEDGER = HERMES_HOME / "spawn-ledger.json"


def _live_backend() -> int:
    try:
        entries: Any = json.loads(LEDGER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        entries = []
    if isinstance(entries, dict):
        entries = list(entries.values())
    candidates = [
        entry for entry in entries if isinstance(entry, dict) and entry.get("purpose") == "serve"
    ]
    candidates.sort(key=lambda entry: float(entry.get("registered_at", 0)), reverse=True)
    for entry in candidates:
        try:
            pid = int(entry.get("pid", 0))
            port = int(entry.get("port", 0))
            if pid <= 0 or not 0 < port < 65536:
                continue
            os.kill(pid, 0)
            return port
        except (OSError, TypeError, ValueError):
            continue
    raise web.HTTPServiceUnavailable(text="Hermes Desktop backend is not running")


def _backend_http_url(request: web.Request, port: int) -> str:
    path = request.rel_url.path or "/"
    query = request.rel_url.query_string
    return f"http://127.0.0.1:{port}{path}{('?' + query) if query else ''}"


async def proxy_http(request: web.Request) -> web.StreamResponse:
    port = _live_backend()
    if request.method == "GET" and request.path == "/api/health":
        return web.json_response({"ok": True, "backend_port": port})
    if request.method not in {"GET", "HEAD"}:
        raise web.HTTPMethodNotAllowed(request.method, ["GET", "HEAD"])
    url = _backend_http_url(request, port)
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "connection", "content-length"}
    }
    headers["Host"] = f"127.0.0.1:{port}"
    session: ClientSession = request.app["http_session"]
    async with session.request(request.method, url, headers=headers, allow_redirects=False) as response:
        body = await response.read()
        passthrough = {
            key: value
            for key, value in response.headers.items()
            if key.lower() not in {"connection", "content-length", "transfer-encoding"}
        }
        return web.Response(status=response.status, headers=passthrough, body=body)


async def proxy_websocket(request: web.Request) -> web.StreamResponse:
    port = _live_backend()
    client_ws = web.WebSocketResponse(heartbeat=30)
    await client_ws.prepare(request)
    query = request.rel_url.query_string
    backend_url = f"ws://127.0.0.1:{port}/api/ws{('?' + query) if query else ''}"
    session: ClientSession = request.app["http_session"]
    try:
        async with session.ws_connect(
            backend_url,
            headers={"Host": f"127.0.0.1:{port}"},
            timeout=ClientTimeout(total=20),
            heartbeat=30,
        ) as backend_ws:

            async def client_to_backend() -> None:
                async for message in client_ws:
                    if message.type == WSMsgType.TEXT:
                        await backend_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await backend_ws.send_bytes(message.data)
                    elif message.type == WSMsgType.PING:
                        await backend_ws.ping(message.data)
                    elif message.type == WSMsgType.PONG:
                        await backend_ws.pong(message.data)
                    elif message.type in {WSMsgType.CLOSE, WSMsgType.ERROR}:
                        break

            async def backend_to_client() -> None:
                async for message in backend_ws:
                    if message.type == WSMsgType.TEXT:
                        await client_ws.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        await client_ws.send_bytes(message.data)
                    elif message.type == WSMsgType.PING:
                        await client_ws.ping(message.data)
                    elif message.type == WSMsgType.PONG:
                        await client_ws.pong(message.data)
                    elif message.type in {WSMsgType.CLOSE, WSMsgType.ERROR}:
                        break

            tasks = {
                asyncio.create_task(client_to_backend()),
                asyncio.create_task(backend_to_client()),
            }
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*done, return_exceptions=True)
    except Exception:
        if not client_ws.closed:
            await client_ws.close(code=1011, message=b"Hermes backend unavailable")
    finally:
        if not client_ws.closed:
            await client_ws.close()
    return client_ws


async def on_startup(app: web.Application) -> None:
    app["http_session"] = ClientSession(timeout=ClientTimeout(total=20))


async def on_cleanup(app: web.Application) -> None:
    await app["http_session"].close()


def create_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/api/ws", proxy_websocket)
    app.router.add_route("*", "/{path:.*}", proxy_http)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host=HOST, port=PORT)
