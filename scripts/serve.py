#!/usr/bin/env python3
"""Serve the poster site and an existing Annulus API on one public URL."""

import argparse
import http.client
import os
import secrets
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = {"index.html", "data.html", "app.js", "benchmarks.js", "styles.css", "site.json"}
PUBLIC_DIRS = {"assets", "data", "src/viewer"}
API_PATHS = {"/api", "/api/", "/v1/models", "/v1/chat/completions"}


def handler(backend_port):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def send_head(self):
            path = (ROOT / unquote(urlsplit(self.path).path).lstrip("/")).resolve()
            if path.is_dir():
                path = path / "index.html"
            if not path.is_relative_to(ROOT):
                self.send_error(404)
                return None
            relative = path.relative_to(ROOT).as_posix()
            if relative not in PUBLIC_FILES and not any(
                relative.startswith(directory + "/") for directory in PUBLIC_DIRS
            ):
                self.send_error(404)
                return None
            if any(part.startswith(".") for part in path.relative_to(ROOT).parts):
                self.send_error(404)
                return None
            return super().send_head()

        def proxy(self):
            if self.path not in API_PATHS:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if not 0 <= length <= 100_000 or self.headers.get("Transfer-Encoding"):
                self.send_error(413)
                return
            connection = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=300)
            try:
                connection.request(self.command, self.path, self.rfile.read(length),
                                   {"Content-Type": "application/json"})
                response = connection.getresponse()
                body = response.read()
            except (OSError, http.client.HTTPException):
                self.send_error(502, "Inference server unavailable")
                return
            finally:
                connection.close()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {"connection", "transfer-encoding", "content-length", "server", "date"}:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in API_PATHS:
                self.proxy()
            else:
                super().do_GET()

        do_POST = proxy
        do_OPTIONS = proxy

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--backend-port", type=int, default=8400)
    parser.add_argument("--share", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(args.backend_port))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Local: http://127.0.0.1:{args.port}", flush=True)
    try:
        if args.share:
            from gradio.networking import setup_tunnel

            token_path = ROOT / ".gradio" / "share-token"
            token_path.parent.mkdir(exist_ok=True)
            if not token_path.exists():
                descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as token_file:
                    token_file.write(secrets.token_urlsafe(32))
            token = token_path.read_text().strip()
            url = setup_tunnel("127.0.0.1", args.port, token, None, None)
            print(f"Public: {url}", flush=True)
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
