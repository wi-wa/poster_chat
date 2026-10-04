#!/usr/bin/env python3
"""Serve the poster site and an existing Annulus API on one public URL.

/power reports whether the inference server is asleep, starting or awake (with
its startup log) and POST /power/wake starts it on a free GPU through
scripts/start_inference.sh, for the chat page's WAKE UP button.
"""

import argparse
import http.client
import json
import os
import re
import secrets
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = {"index.html", "data.html", "app.js", "benchmarks.js", "styles.css", "site.json"}
PUBLIC_DIRS = {"assets", "data", "src/viewer"}
API_PATHS = {"/api", "/api/", "/v1/models", "/v1/chat/completions"}
POWER_PATHS = {"/power", "/power/wake"}
INFERENCE_SESSION = "chat_inference_server"
INFERENCE_LOG = ROOT / ".gradio" / "inference_server.log"
START_INFERENCE = ROOT / "scripts" / "start_inference.sh"
# The three 7B models with their caches take about 66 GB.
WAKE_MIN_FREE_MIB = 72 * 1024
GLOG_LINE = re.compile(r"^[IWEF]\d{4} \d{2}:\d{2}:\d{2}")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
wake_lock = threading.Lock()


def backend_up(port):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", "/healthz")
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def power_state(port):
    if backend_up(port):
        return "awake"
    session = subprocess.run(["tmux", "has-session", "-t", f"={INFERENCE_SESSION}"], capture_output=True)
    return "starting" if session.returncode == 0 else "asleep"


def startup_log(limit=40):
    """The last lines of the inference server's output, without JAX's glog noise."""
    try:
        lines = INFERENCE_LOG.read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return []
    lines = (ANSI_ESCAPE.sub("", line).rstrip() for line in lines)
    return [line for line in lines if line.strip() and not GLOG_LINE.match(line)][-limit:]


def free_gpu():
    """The lowest-numbered GPU with room for the models, or None."""
    query = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=30,
    )
    for line in query.stdout.splitlines():
        index, free_mib = (int(field) for field in line.split(","))
        if free_mib >= WAKE_MIN_FREE_MIB:
            return index
    return None


def power_status(port, error=None):
    return {"state": power_state(port), "log": startup_log(), "error": error}


def wake(port):
    with wake_lock:
        if power_state(port) != "asleep":
            return power_status(port)
        gpu = free_gpu()
        if gpu is None:
            return power_status(port, "Every GPU is busy right now. Please try again later.")
        subprocess.run([str(START_INFERENCE), str(gpu)], check=True, capture_output=True, timeout=60)
        return power_status(port)


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

        def send_power(self, status, code=200):
            body = json.dumps(status).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/power":
                self.send_power(power_status(backend_port))
            elif self.path in API_PATHS:
                self.proxy()
            else:
                super().do_GET()

        def do_POST(self):
            if self.path != "/power/wake":
                self.proxy()
                return
            try:
                self.send_power(wake(backend_port))
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                print(f"wake failed: {error}", flush=True)
                self.send_power(power_status(backend_port, "The inference server could not be started."), 500)

        def do_OPTIONS(self):
            if self.path not in POWER_PATHS:
                self.proxy()
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

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
