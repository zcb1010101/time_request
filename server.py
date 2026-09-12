# -*- coding: utf-8 -*-
"""
TimeRequest 服务入口
启动命令：python server.py [--port 8765] [--no-open]
启动后访问 http://127.0.0.1:8765 即可打开可视化界面。
"""
import argparse
import json
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 显式将脚本所在目录加入模块搜索路径，
# 兼容 PYTHONSAFEPATH / python -P 等不自动加入脚本目录的环境
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from monitor import Monitor

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class App:
    def __init__(self, port):
        self.port = port
        self.monitor = Monitor()


app = None  # type: App | None


class Handler(BaseHTTPRequestHandler):
    server_version = "TimeRequest/1.0"

    # ------------------------------------------------------------- helpers
    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path):
        rel = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        fp = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            self._json({"error": "not found"}, 404)
            return
        with open(fp, "rb") as f:
            data = f.read()
        ext = os.path.splitext(fp)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _q(self, q, key, cast=int, default=None):
        if not q.get(key):
            return default
        try:
            return cast(q[key][0])
        except Exception:
            return default

    # --------------------------------------------------------------- routes
    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        m = app.monitor
        try:
            if p in ("/", "/index.html", "/style.css", "/app.js", "/favicon.ico"):
                self._static(p)
            elif p == "/api/state":
                self._json(m.state())
            elif p == "/api/records":
                self._json({"records": m.list_records(
                    limit=self._q(q, "limit", int, 200),
                    target_id=self._q(q, "target_id", int, None))})
            elif p.startswith("/api/records/"):
                rid = p.rsplit("/", 1)[-1]
                rec = m.get_record(rid)
                self._json(rec if rec else {"error": "record not found"},
                           200 if rec else 404)
            elif p == "/api/stats":
                self._json(m.stats(
                    minutes=self._q(q, "minutes", int, 60),
                    target_id=self._q(q, "target_id", int, None)))
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        m = app.monitor
        try:
            if p == "/api/targets":
                b = self._body()
                t = m.add_target(b.get("name", ""), b.get("url", ""),
                                 b.get("method", "GET"), b.get("headers", "{}"),
                                 b.get("body", ""), b.get("enabled", True))
                self._json(t, 201)
            elif p == "/api/run":
                b = self._body()
                results = m.run_now(target_id=b.get("target_id"))
                self._json({"count": len(results), "results": [
                    {"id": r["id"], "ok": r["ok"], "status_code": r["status_code"],
                     "total_ms": r["total_ms"], "error": r.get("error")}
                    for r in results]})
            else:
                self._json({"error": "not found"}, 404)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_PUT(self):
        u = urlparse(self.path)
        p = u.path
        m = app.monitor
        try:
            if p == "/api/config":
                b = self._body()
                if "interval_s" in b:
                    m.set_interval(b["interval_s"])
                if "running" in b:
                    m.set_running(bool(b["running"]))
                self._json(m.state())
            elif p.startswith("/api/targets/"):
                tid = int(p.rsplit("/", 1)[-1])
                t = m.update_target(tid, **self._body())
                self._json(t if t else {"error": "not found"}, 200 if t else 404)
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_DELETE(self):
        u = urlparse(self.path)
        p = u.path
        m = app.monitor
        try:
            if p.startswith("/api/targets/"):
                tid = int(p.rsplit("/", 1)[-1])
                m.delete_target(tid)
                self._json({"ok": True})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def log_message(self, fmt, *args):  # 精简访问日志
        print("[%s] %s %s" % (self.log_date_time_string(),
                              getattr(self, "command", ""), self.path), flush=True)


def main():
    ap = argparse.ArgumentParser(description="TimeRequest 定时请求监测")
    ap.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    ap.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    args = ap.parse_args()

    global app
    app = App(args.port)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)

    print("=" * 58, flush=True)
    print(" TimeRequest 已启动", flush=True)
    print(" 界面地址 : http://127.0.0.1:%d" % args.port, flush=True)
    print(" 数据文件 : %s" % os.path.join(BASE_DIR, "data.db"), flush=True)
    print(" 默认目标 : https://baidu.com", flush=True)
    print(" 检查间隔 : %s 秒（可在界面调整）" % int(app.monitor.interval_s), flush=True)
    print(" 停止服务 : 按 Ctrl+C", flush=True)
    print("=" * 58, flush=True)

    if not args.no_open:
        threading.Timer(1.0, lambda: webbrowser.open(
            "http://127.0.0.1:%d" % args.port)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止", flush=True)
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
