#!/usr/bin/env python3
"""Tiny dev server with correct MIME types for .js/.mjs/.wasm (needed for ES modules).

Usage: python3 serve.py [port]   (default port 8000)
"""
import http.server
import mimetypes
import socketserver
import sys

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **getattr(http.server.SimpleHTTPRequestHandler, "extensions_map", {}),
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with socketserver.TCPServer(("", port), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f"Serving at http://localhost:{port}")
        httpd.serve_forever()
