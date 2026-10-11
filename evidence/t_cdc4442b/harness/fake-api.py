#!/usr/bin/env python3
"""Stand-in for cvm-orders (127.0.0.1:8788) for the local Caddy behavioural matrix.

Answers /health 200 JSON (so the healthy-proxy path is provable) and every other path with a
JSON 404 that echoes the path the PROXY forwarded. The echoed path is the evidence that
handle_path /api/* strips the /api prefix before the upstream sees it.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _answer(self):
        if self.path == "/health":
            payload = {"status": "ok", "upstream": "fake-cvm-orders", "method": self.command}
            code = 200
        else:
            payload = {"error": "not found", "method": self.command, "upstream_path": self.path}
            code = 404
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = _answer
    do_POST = _answer
    do_HEAD = _answer

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
