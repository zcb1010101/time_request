# -*- coding: utf-8 -*-
"""
TimeRequest 核心模块
功能：按可配置间隔定时请求目标 URL，完整采集请求包/响应包（状态码、耗时、
请求头、响应头、响应体、重定向链），并持久化到 SQLite。
仅使用 Python 标准库，无第三方依赖。
"""
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from urllib import request as urlrequest
from urllib import error as urlerror
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
BODY_CAP = 512 * 1024          # 响应体采集上限（字节）
MAX_RECORDS = 5000             # 保留的最大记录条数
MIN_INTERVAL, MAX_INTERVAL = 1, 86400


def utcnow_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def iso_to_epoch(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


class _RedirectRecorder(urlrequest.HTTPRedirectHandler):
    """记录重定向链的 HTTPRedirectHandler。"""

    def __init__(self, chain):
        super().__init__()
        self.chain = chain

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({
            "url": req.full_url,
            "status": code,
            "location": headers.get("Location"),
        })
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Monitor:
    """定时请求调度 + 采集 + 存储的单一权威入口。"""

    def __init__(self, db_path=None):
        self.db_path = db_path or DB_PATH
        self._init_db()
        self._seed_default_target()
        self.running = self._get_meta("running", "1") == "1"
        self.interval_s = float(self._get_meta("interval_s", "60"))
        self.next_run_at = time.time() + self.interval_s
        self.last_run_at = self._get_meta("last_run_at") or None
        self._run_lock = threading.Lock()
        self._insert_count = 0
        threading.Thread(target=self._loop, daemon=True).start()

    # ------------------------------------------------------------------ db
    @contextmanager
    def _db(self):
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=5000")
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self._db() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS targets(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                method TEXT NOT NULL DEFAULT 'GET',
                headers TEXT NOT NULL DEFAULT '{}',
                body TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                sort INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS records(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_id INTEGER NOT NULL,
                ts TEXT NOT NULL,
                ok INTEGER NOT NULL DEFAULT 0,
                status_code INTEGER,
                ttfb_ms REAL,
                total_ms REAL,
                error TEXT,
                redirects TEXT NOT NULL DEFAULT '[]',
                req_method TEXT,
                req_url TEXT,
                req_headers TEXT,
                req_body TEXT,
                resp_headers TEXT,
                resp_body TEXT,
                resp_body_len INTEGER DEFAULT 0,
                resp_truncated INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
            CREATE INDEX IF NOT EXISTS idx_records_target ON records(target_id);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
            """)

    def _get_meta(self, key, default=None):
        with self._db() as c:
            row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def _set_meta(self, key, value):
        with self._db() as c:
            c.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, str(value)))

    def _seed_default_target(self):
        with self._db() as c:
            n = c.execute("SELECT COUNT(*) AS n FROM targets").fetchone()["n"]
            if n == 0:
                c.execute(
                    "INSERT INTO targets(name,url,method,headers,body,enabled,sort,created_at) "
                    "VALUES(?,?,?,?,?,1,1,?)",
                    ("百度首页", "https://baidu.com", "GET", "{}", "", utcnow_iso()))

    # -------------------------------------------------------------- targets
    @staticmethod
    def _target_dict(r):
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        return d

    def list_targets(self):
        with self._db() as c:
            rows = c.execute("SELECT * FROM targets ORDER BY sort, id").fetchall()
        return [self._target_dict(r) for r in rows]

    def get_target(self, tid):
        with self._db() as c:
            r = c.execute("SELECT * FROM targets WHERE id=?", (int(tid),)).fetchone()
        return self._target_dict(r) if r else None

    def add_target(self, name, url, method="GET", headers="{}", body="", enabled=True):
        url = self._normalize_url(url)
        with self._db() as c:
            cur = c.execute(
                "INSERT INTO targets(name,url,method,headers,body,enabled,sort,created_at) "
                "VALUES(?,?,?,?,?,?,0,?)",
                (name or url, url, (method or "GET").upper(), headers or "{}",
                 body or "", 1 if enabled else 0, utcnow_iso()))
            tid = cur.lastrowid
        return self.get_target(tid)

    def update_target(self, tid, **kw):
        allowed = {"name", "url", "method", "headers", "body", "enabled", "sort"}
        fields, values = [], []
        for k, v in kw.items():
            if k not in allowed:
                continue
            if k == "url":
                v = self._normalize_url(v)
            if k == "enabled":
                v = 1 if v else 0
            fields.append("%s=?" % k)
            values.append(v)
        if fields:
            values.append(int(tid))
            with self._db() as c:
                c.execute("UPDATE targets SET %s WHERE id=?" % ", ".join(fields), values)
        return self.get_target(tid)

    def delete_target(self, tid):
        with self._db() as c:
            c.execute("DELETE FROM targets WHERE id=?", (int(tid),))

    @staticmethod
    def _normalize_url(url):
        url = (url or "").strip()
        if not url:
            raise ValueError("URL 不能为空")
        if not urlparse(url).scheme:
            url = "http://" + url
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError("URL 仅支持 http/https 协议")
        return url

    # ------------------------------------------------------------- config
    def set_interval(self, seconds):
        seconds = int(max(MIN_INTERVAL, min(MAX_INTERVAL, int(seconds or 60))))
        self._set_meta("interval_s", seconds)
        self.interval_s = float(seconds)
        self.next_run_at = time.time() + self.interval_s
        return self.interval_s

    def set_running(self, running):
        self.running = bool(running)
        self._set_meta("running", "1" if running else "0")
        if self.running and time.time() >= self.next_run_at:
            self.next_run_at = time.time() + self.interval_s

    # ----------------------------------------------------------- scheduler
    def _loop(self):
        while True:
            if self.running and time.time() >= self.next_run_at:
                try:
                    self.run_now()
                except Exception as e:  # noqa: BLE001
                    print("[monitor] 定时执行异常:", e, flush=True)
                self.last_run_at = utcnow_iso()
                self._set_meta("last_run_at", self.last_run_at)
                self.next_run_at = time.time() + self.interval_s
            time.sleep(0.5)

    def run_now(self, target_id=None):
        """立即对全部（或指定）已启用目标执行一次检查，返回记录列表。"""
        with self._run_lock:
            targets = self.list_targets()
            if target_id is not None:
                targets = [t for t in targets if t["id"] == int(target_id)]
            results = []
            for t in targets:
                if not t["enabled"]:
                    continue
                try:
                    rec = self._perform(t)
                except Exception as e:  # noqa: BLE001
                    rec = {"ts": utcnow_iso(), "ok": False, "status_code": None,
                           "ttfb_ms": 0.0, "total_ms": 0.0,
                           "error": "采集内部错误: %s" % e, "redirects": [],
                           "req_method": t["method"], "req_url": t["url"],
                           "req_headers": "{}", "req_body": "",
                           "resp_headers": "{}", "resp_body": "",
                           "resp_body_len": 0, "resp_truncated": False}
                results.append(self._store(t, rec))
            self._maybe_prune()
            return results

    def _store(self, t, rec):
        with self._db() as c:
            cur = c.execute(
                "INSERT INTO records(target_id,ts,ok,status_code,ttfb_ms,total_ms,error,"
                "redirects,req_method,req_url,req_headers,req_body,resp_headers,resp_body,"
                "resp_body_len,resp_truncated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (t["id"], rec["ts"], 1 if rec["ok"] else 0, rec["status_code"],
                 rec["ttfb_ms"], rec["total_ms"], rec.get("error"),
                 json.dumps(rec.get("redirects", []), ensure_ascii=False),
                 rec["req_method"], rec["req_url"], rec["req_headers"], rec["req_body"],
                 rec["resp_headers"], rec["resp_body"], rec["resp_body_len"],
                 1 if rec.get("resp_truncated") else 0))
            rid = cur.lastrowid
        rec["id"] = rid
        rec["target_id"] = t["id"]
        return rec

    def _maybe_prune(self):
        self._insert_count += 1
        if self._insert_count % 50 != 0:
            return
        with self._db() as c:
            c.execute("DELETE FROM records WHERE id NOT IN "
                      "(SELECT id FROM records ORDER BY id DESC LIMIT ?)", (MAX_RECORDS,))

    # ------------------------------------------------------------ perform
    def _perform(self, t):
        ts = utcnow_iso()
        url = t["url"]
        method = (t["method"] or "GET").upper()
        try:
            extra = json.loads(t["headers"] or "{}")
            if not isinstance(extra, dict):
                extra = {}
        except Exception:
            extra = {}
        headers = {"User-Agent": DEFAULT_UA, "Accept": "*/*",
                   "Accept-Language": "zh-CN,zh;q=0.9"}
        headers.update({str(k): str(v) for k, v in extra.items()})
        body_text = t.get("body") or ""
        data = None
        if method not in ("GET", "HEAD") and body_text:
            data = body_text.encode("utf-8")

        req = urlrequest.Request(url, data=data, method=method)
        for k, v in headers.items():
            req.add_header(k, v)

        redirects = []
        opener = urlrequest.build_opener(_RedirectRecorder(redirects))
        t0 = time.time()
        ttfb, status, error = None, None, None
        resp_headers, raw, truncated = [], b"", False
        ok = False
        try:
            resp = opener.open(req, timeout=10)
            ttfb = round((time.time() - t0) * 1000, 1)
            status = resp.getcode() or 0
            resp_headers = [(k, v) for k, v in resp.headers.items()]
            cl = resp.headers.get("Content-Length")
            if cl and cl.isdigit() and int(cl) > BODY_CAP:
                raw = resp.read(BODY_CAP)
                truncated = True
            else:
                raw = resp.read()
            ok = 200 <= status < 400
        except urlerror.HTTPError as e:
            ttfb = round((time.time() - t0) * 1000, 1)
            status = e.code
            resp_headers = [(k, v) for k, v in e.headers.items()]
            try:
                raw = e.read()
            except Exception:
                raw = b""
            ok = 200 <= status < 400
            if not ok:
                error = "HTTP %s %s" % (e.code, e.reason)
        except Exception as e:
            error = str(e) or e.__class__.__name__

        total = round((time.time() - t0) * 1000, 1)
        return {
            "ts": ts, "ok": ok, "status_code": status,
            "ttfb_ms": ttfb, "total_ms": total, "error": error,
            "redirects": redirects,
            "req_method": method, "req_url": req.full_url,
            "req_headers": json.dumps(headers, ensure_ascii=False, indent=2),
            "req_body": body_text if body_text else "",
            "resp_headers": json.dumps(resp_headers, ensure_ascii=False, indent=2),
            "resp_body": raw.decode("utf-8", "replace") if raw else "",
            "resp_body_len": len(raw), "resp_truncated": truncated,
        }

    # ------------------------------------------------------------ queries
    def list_records(self, limit=200, target_id=None, offset=0):
        limit = max(1, min(1000, int(limit)))
        q = ("SELECT r.id, r.target_id, r.ts, r.ok, r.status_code, r.ttfb_ms, r.total_ms, "
             "r.error, r.redirects, r.req_method, r.req_url, "
             "t.name AS target_name FROM records r "
             "LEFT JOIN targets t ON r.target_id = t.id")
        conds, vals = [], []
        if target_id:
            conds.append("r.target_id=?")
            vals.append(int(target_id))
        if conds:
            q += " WHERE " + " AND ".join(conds)
        q += " ORDER BY r.id DESC LIMIT ? OFFSET ?"
        vals += [limit, int(offset)]
        with self._db() as c:
            rows = c.execute(q, vals).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                redirects_n = len(json.loads(d["redirects"] or "[]"))
            except Exception:
                redirects_n = 0
            out.append({
                "id": d["id"], "ts": d["ts"], "target_id": d["target_id"],
                "target_name": d["target_name"] or ("#%s" % d["target_id"]),
                "url": d["req_url"], "method": d["req_method"],
                "ok": bool(d["ok"]), "status_code": d["status_code"],
                "ttfb_ms": d["ttfb_ms"], "total_ms": d["total_ms"],
                "error": d["error"], "redirects_n": redirects_n,
            })
        return out

    def get_record(self, rid):
        with self._db() as c:
            r = c.execute(
                "SELECT r.*, t.name AS target_name FROM records r "
                "LEFT JOIN targets t ON r.target_id = t.id WHERE r.id=?",
                (int(rid),)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["ok"] = bool(d["ok"])
        d["resp_truncated"] = bool(d["resp_truncated"])
        try:
            d["redirects"] = json.loads(d["redirects"] or "[]")
        except Exception:
            d["redirects"] = []
        return d

    def totals(self):
        with self._db() as c:
            row = c.execute(
                "SELECT COUNT(*) AS n, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok, "
                "AVG(total_ms) AS avg, MAX(total_ms) AS mx FROM records").fetchone()
        n = row["n"] or 0
        return {"records": n, "ok": row["ok"] or 0,
                "avg_ms": round(row["avg"] or 0, 1) if n else 0,
                "max_ms": round(row["mx"] or 0, 1) if n else 0}

    def state(self):
        return {
            "running": self.running,
            "interval_s": self.interval_s,
            "next_run_ms": int(self.next_run_at * 1000),
            "last_run_at": self.last_run_at,
            "server_time": utcnow_iso(),
            "targets": self.list_targets(),
            "totals": self.totals(),
        }

    def stats(self, minutes=60, target_id=None):
        minutes = max(5, min(1440, int(minutes)))
        now = time.time()
        since = now - minutes * 60
        since_iso = datetime.fromtimestamp(since, tz=timezone.utc) \
            .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        q = "SELECT target_id, ts, ok, total_ms FROM records WHERE ts >= ?"
        vals = [since_iso]
        if target_id:
            q += " AND target_id=?"
            vals.append(int(target_id))
        with self._db() as c:
            rows = c.execute(q, vals).fetchall()

        buckets = {}
        for r in rows:
            idx = int((iso_to_epoch(r["ts"]) - since) // 60)
            if idx < 0 or idx >= minutes:
                continue
            b = buckets.setdefault((r["target_id"], idx), {"n": 0, "sum": 0.0, "ok": 0})
            b["n"] += 1
            b["sum"] += r["total_ms"] or 0
            b["ok"] += 1 if r["ok"] else 0
        series_map = {}
        for (tid, idx), b in buckets.items():
            series_map.setdefault(tid, [None] * minutes)[idx] = {
                "avg": round(b["sum"] / b["n"], 1), "n": b["n"], "ok": b["ok"]}
        names = {t["id"]: t["name"] for t in self.list_targets()}
        series = [{"target_id": tid, "name": names.get(tid, "#%s" % tid),
                   "points": series_map[tid]} for tid in sorted(series_map)]

        with self._db() as c:
            last = c.execute(
                "SELECT status_code, ok FROM records ORDER BY id DESC LIMIT 200").fetchall()
        dist = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "error": 0}
        for r in last:
            sc = r["status_code"]
            if sc is None:
                dist["error"] += 1
            elif 200 <= sc < 300:
                dist["2xx"] += 1
            elif 300 <= sc < 400:
                dist["3xx"] += 1
            elif 400 <= sc < 500:
                dist["4xx"] += 1
            else:
                dist["5xx"] += 1
        return {"since": since_iso, "minutes": minutes,
                "series": series, "distribution": dist}
