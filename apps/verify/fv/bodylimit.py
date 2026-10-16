"""
Request body size limit (ASGI middleware). FastAPI parses a JSON body before any dependency runs, so a size check has to
sit in front of the app: every request except POST /api/media (which checks its own, larger Content-Length) may carry at
most `max_bytes`. A declared Content-Length above the limit is refused before anything is read; a body without one
(chunked) is counted while it streams in. Over the limit → 413 {"detail": "request_too_large"}.
"""
from __future__ import annotations

import json

UNLIMITED_PATHS = ("/api/media",)


class BodyTooLarge(Exception):
    pass


class BodySizeLimit:
    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, int(max_bytes)

    async def _refuse(self, send) -> None:
        body = json.dumps({"detail": "request_too_large"}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") in UNLIMITED_PATHS:
            await self.app(scope, receive, send)
            return
        declared = next((v for k, v in scope.get("headers") or [] if k == b"content-length"), None)
        if declared is not None:
            try:
                too_large = int(declared) > self.max_bytes
            except ValueError:
                too_large = True
            if too_large:
                await self._refuse(send)
                return
        seen = 0
        state = {"exceeded": False, "started": False, "replaced": False}

        async def counting_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body") or b"")
                if seen > self.max_bytes:
                    state["exceeded"] = True
                    raise BodyTooLarge()
            return msg

        async def guarded_send(msg):
            # the framework may turn the aborted body read into its own error response: answer 413 instead
            if state["exceeded"] and not state["started"]:
                if not state["replaced"]:
                    state["replaced"] = True
                    await self._refuse(send)
                return
            if msg["type"] == "http.response.start":
                state["started"] = True
            await send(msg)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except BodyTooLarge:
            if not state["started"] and not state["replaced"]:
                await self._refuse(send)
