#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tsw_answer.py —— 淘师湾作业网 本地自动答题脚本（Python 3.6+，仅标准库）

原理
----
用 Chrome DevTools Protocol（CDP）接管一个已开启远程调试端口的 Chrome / Edge / 360 浏览器：
  1. 打开作业答题页（需你已登录，脚本不碰账号密码）
  2. 打开 Network 域，抓取页面自己请求回来的试卷 JSON（标准答案就在里面）
  3. 把 tsw_core.js 注入页面，在页面上下文里解析题目、匹配答案、填涂
  4. 可选：点「提交试卷」
  5. 把采到的答案并入本地题库 bank.json，下次同题库的作业直接命中

对浏览器的要求
--------------
任何 Chromium 内核浏览器 + 启动参数 --remote-debugging-port=9222 即可：
  Chrome / Edge / 360 安全浏览器 / 360 极速浏览器 / 2345 浏览器 等。
不需要 chromedriver，不需要 pip install（本脚本自带 WebSocket 客户端）。

常用命令
--------
  python tsw_answer.py doctor                     # 体检：找浏览器、查端口
  python tsw_answer.py launch --browser 360       # 启动浏览器并开调试端口
  python tsw_answer.py run --url "<答题页URL>"     # 抓答案并作答
  python tsw_answer.py run --reuse --submit       # 在已打开的答题页上作答并交卷
  python tsw_answer.py bank --stats               # 看题库
"""

import argparse
import base64
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

VERSION = "1.0.0"
DEFAULT_PORT = 9222
HERE = os.path.dirname(os.path.abspath(__file__))


# ============================================================
# 输出
# ============================================================
def _init_stdout():
    """Windows 控制台把 cp936 换成 utf-8，避免中文乱码/报错。"""
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            return
    except Exception:
        pass
    try:
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass


def out(msg=""):
    sys.stdout.write(str(msg) + "\n")
    sys.stdout.flush()


def warn(msg):
    out("[!] " + str(msg))


def die(msg, code=1):
    out("[x] " + str(msg))
    sys.exit(code)


# ============================================================
# 最小 WebSocket 客户端（RFC 6455 子集）
# 只做 CDP 需要的事：握手、发文本帧、收文本帧、应答 ping、处理分片
# ============================================================
class WSError(Exception):
    pass


class WebSocket(object):
    def __init__(self, url, timeout=30.0):
        m = re.match(r"^ws://([^/:]+)(?::(\d+))?(/.*)?$", url)
        if not m:
            raise WSError("不支持的 WebSocket 地址: %s" % url)
        host = m.group(1)
        port = int(m.group(2) or 80)
        path = m.group(3) or "/"

        self.sock = socket.create_connection((host, port), timeout)
        self.sock.settimeout(timeout)
        self._buf = b""

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        # 注意：不发 Origin 头。Chrome 111+ 会校验 Origin，缺失则视为本地客户端放行。
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ) % (path, host, port, key)
        self.sock.sendall(req.encode("ascii"))

        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("握手阶段连接被关闭")
            head += chunk
            if len(head) > 65536:
                raise WSError("握手响应过大")
        header, _, rest = head.partition(b"\r\n\r\n")
        self._buf = rest
        status = header.split(b"\r\n")[0]
        if b"101" not in status:
            raise WSError("握手失败: %r" % status.decode("latin-1"))

    def _read_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WSError("连接已关闭")
            self._buf += chunk
        data, self._buf = self._buf[:n], self._buf[n:]
        return data

    def _read_frame(self):
        b = self._read_exact(2)
        fin = b[0] & 0x80
        opcode = b[0] & 0x0F
        masked = b[1] & 0x80
        length = b[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length) if length else b""
        if mask:
            payload = bytes(bytearray(payload[i] ^ mask[i % 4] for i in range(len(payload))))
        return fin, opcode, payload

    def _send_frame(self, opcode, payload):
        header = bytearray()
        header.append(0x80 | opcode)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        mask = os.urandom(4)
        header += mask
        body = bytearray(payload)
        for i in range(len(body)):
            body[i] ^= mask[i % 4]
        self.sock.sendall(bytes(header) + bytes(body))

    def send_text(self, text):
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self):
        chunks = []
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:          # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:          # pong
                continue
            if opcode == 0x8:          # close
                raise WSError("对端关闭连接")
            if opcode in (0x0, 0x1, 0x2):
                chunks.append(payload)
                if fin:
                    return b"".join(chunks).decode("utf-8", "replace")

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ============================================================
# CDP 客户端
# ============================================================
class CDPError(Exception):
    pass


class CDP(object):
    def __init__(self, ws_url, timeout=30.0):
        self.ws = WebSocket(ws_url, timeout)
        self.timeout = timeout
        self._id = 0
        self.events = []

    def _next_id(self):
        self._id += 1
        return self._id

    def _recv(self, timeout):
        self.ws.sock.settimeout(max(0.05, timeout))
        return json.loads(self.ws.recv_text())

    def send(self, method, params=None):
        mid = self._next_id()
        self.ws.sock.settimeout(self.timeout)
        self.ws.send_text(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def call(self, method, params=None, timeout=None):
        mid = self.send(method, params)
        deadline = time.time() + (timeout if timeout else self.timeout)
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise CDPError("等待 %s 响应超时" % method)
            try:
                msg = self._recv(left)
            except socket.timeout:
                raise CDPError("等待 %s 响应超时" % method)
            if msg.get("id") == mid:
                if "error" in msg:
                    raise CDPError("%s 失败: %s" % (method, json.dumps(msg["error"], ensure_ascii=False)))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)

    def pump(self, seconds):
        """在 seconds 内收集事件（不阻塞等待应答）。"""
        deadline = time.time() + seconds
        while True:
            left = deadline - time.time()
            if left <= 0:
                return
            try:
                msg = self._recv(min(left, 0.3))
            except socket.timeout:
                continue
            except WSError:
                return
            if "method" in msg:
                self.events.append(msg)

    def wait_event(self, method, timeout=30.0):
        """等待某个事件。期间收到的其它事件保留在 self.events 里，不丢弃。"""
        deadline = time.time() + timeout
        while True:
            for i in range(len(self.events)):
                if self.events[i].get("method") == method:
                    return self.events.pop(i)
            if time.time() > deadline:
                return None
            self.pump(0.2)

    def take_events(self):
        """取走当前所有累积事件（保留顺序）。"""
        ev = self.events
        self.events = []
        return ev

    def drain(self):
        return self.take_events()

    def close(self):
        self.ws.close()


# ============================================================
# HTTP 辅助（读 /json 列表）
# ============================================================
def http_json(url, method="GET", timeout=5.0):
    req = urllib.request.Request(url, method=method)
    req.add_header("Host", url.split("//", 1)[1].split("/")[0])
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def list_targets(port, host="127.0.0.1", timeout=5.0):
    return http_json("http://%s:%d/json/list" % (host, port), timeout=timeout)


def find_page(port, host="127.0.0.1", url_hint=None):
    targets = list_targets(port, host)
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        return None
    if url_hint:
        for t in pages:
            if url_hint.split("?")[0] in (t.get("url") or ""):
                return t
    return pages[0]


def port_alive(port, host="127.0.0.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        s.close()


# ============================================================
# 浏览器发现与启动
# ============================================================
def _win_registry_paths():
    """从注册表补充查找 Chrome / Edge / 360 的安装路径。"""
    paths = []
    try:
        import winreg
    except Exception:
        return paths
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
    ]
    for hive, sub in keys:
        try:
            with winreg.OpenKey(hive, sub) as k:
                val, _ = winreg.QueryValueEx(k, "")
                if val and os.path.isfile(val):
                    paths.append(val)
        except Exception:
            continue
    return paths


def candidate_browsers():
    """返回 [(名称, 可执行文件路径)]，按优先级排序。"""
    system = platform.system()
    found = []

    def add(name, path):
        if not path:
            return
        path = os.path.expandvars(path)
        if os.path.isfile(path):
            found.append((name, path))

    if system == "Windows":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        roaming = os.environ.get("APPDATA", "")

        for p in _win_registry_paths():
            add("Chrome(注册表)", p)

        add("Chrome", os.path.join(pf, r"Google\Chrome\Application\chrome.exe"))
        add("Chrome", os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"))
        add("Chrome", os.path.join(local, r"Google\Chrome\Application\chrome.exe"))
        add("Edge", os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"))
        add("Edge", os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe"))
        # 360 安全浏览器
        add("360安全浏览器", os.path.join(roaming, r"360se6\Application\360se.exe"))
        add("360安全浏览器", os.path.join(pf86, r"360\360se6\Application\360se.exe"))
        add("360安全浏览器", os.path.join(pf, r"360\360se6\Application\360se.exe"))
        # 360 极速浏览器
        add("360极速浏览器", os.path.join(local, r"360Chrome\Chrome\Application\360chrome.exe"))
        add("360极速浏览器", os.path.join(pf86, r"360Chrome\Chrome\Application\360chrome.exe"))
        add("360极速浏览器X", os.path.join(local, r"360ChromeX\Chrome\Application\360ChromeX.exe"))
        add("360极速浏览器X", os.path.join(pf86, r"360ChromeX\Chrome\Application\360ChromeX.exe"))

    elif system == "Darwin":
        add("Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        add("Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
        add("360极速浏览器", "/Applications/360Chrome.app/Contents/MacOS/360Chrome")

    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                     "microsoft-edge", "microsoft-edge-stable"):
            add(name, shutil.which(name))

    # 去重
    uniq, seen = [], set()
    for name, path in found:
        key = os.path.normcase(path)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((name, path))
    return uniq


def pick_browser(prefer="auto"):
    cands = candidate_browsers()
    if not cands:
        return None
    if prefer and prefer != "auto":
        kw = prefer.lower()
        for name, path in cands:
            if kw in name.lower() or kw in os.path.basename(path).lower():
                return (name, path)
        warn("没找到匹配 '%s' 的浏览器，回退自动选择" % prefer)
    return cands[0]


def default_profile_dir(name):
    tag = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower() or "browser"
    base = os.environ.get("TEMP") or os.environ.get("TMPDIR") or "/tmp"
    return os.path.join(base, "tsw-profile-" + tag)


def launch_browser(browser=None, port=DEFAULT_PORT, url="about:blank",
                   profile=None, headless=False, extra_args=None, wait=6.0):
    picked = pick_browser(browser or "auto")
    if not picked:
        die("没找到 Chromium 内核浏览器。请手动指定：--browser \"C:\\...\\chrome.exe\"")
    name, exe = picked
    profile = profile or default_profile_dir(name)

    args = [
        exe,
        "--remote-debugging-port=%d" % port,
        "--user-data-dir=%s" % profile,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
    ]
    if headless:
        args.append("--headless=new")
    if extra_args:
        args.extend(extra_args)
    args.append(url)

    out("启动 %s" % name)
    out("  %s" % exe)
    out("  调试端口 127.0.0.1:%d  独立profile=%s" % (port, profile))
    creationflags = 0
    popen_kw = {}
    if platform.system() == "Windows":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        # POSIX：让浏览器脱离本进程会话，脚本退出后浏览器继续存活
        popen_kw["start_new_session"] = True
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=creationflags, **popen_kw)
    except OSError as exc:
        die("启动失败: %s" % exc)

    deadline = time.time() + wait
    while time.time() < deadline:
        if port_alive(port):
            try:
                ver = http_json("http://127.0.0.1:%d/json/version" % port)
                out("已连接: %s" % ver.get("Browser", "?"))
                return {"name": name, "exe": exe, "port": port, "profile": profile}
            except Exception:
                pass
        time.sleep(0.3)
    warn("端口 %d 未在 %.0f 秒内就绪。若是 360/Chrome 已经在运行，请先完全退出它再试。" % (port, wait))
    return None


# ============================================================
# 核心脚本加载
# ============================================================
def locate_core(explicit=None):
    if explicit:
        if os.path.isfile(explicit):
            return explicit
        die("找不到核心脚本: %s" % explicit)
    for cand in (os.path.join(HERE, "tsw_core.js"),
                 os.path.join(HERE, "local", "tsw_core.js"),
                 os.path.join(os.getcwd(), "tsw_core.js")):
        if os.path.isfile(cand):
            return cand
    die("找不到 tsw_core.js，请把它与本脚本放在同一目录，或用 --core 指定路径。")


def read_core(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ============================================================
# 页面操作
# ============================================================
class Page(object):
    def __init__(self, port, url_hint=None, host="127.0.0.1"):
        if not port_alive(port, host):
            die("端口 %d 没有响应。先运行: python %s launch --port %d" % (port, os.path.basename(__file__), port))
        target = find_page(port, host, url_hint)
        if not target:
            die("没有可用的页面标签页。请先打开浏览器窗口。")
        ws_url = target.get("webSocketDebuggerUrl")
        if not ws_url:
            die("该标签页不支持调试（可能被浏览器策略禁用）。")
        self.target = target
        self.cdp = CDP(ws_url.replace("localhost", "127.0.0.1"), timeout=30.0)
        self.cdp.call("Page.enable")
        self.cdp.call("Runtime.enable")

    # ---------- 基础 ----------
    def eval(self, expr, await_promise=False, timeout=30.0):
        res = self.cdp.call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": bool(await_promise),
            "userGesture": True,
        }, timeout=timeout)
        if res.get("exceptionDetails"):
            d = res["exceptionDetails"]
            msg = d.get("text", "JS 异常")
            ex = d.get("exception") or {}
            if ex.get("description"):
                msg = ex["description"]
            raise CDPError("页面执行出错: %s" % str(msg).splitlines()[0])
        return (res.get("result") or {}).get("value")

    def inject(self, source):
        self.eval(source)
        return self.eval("(window.TSWCore && window.TSWCore.version) || null")

    def navigate(self, url, timeout=45.0):
        out("打开 %s" % url)
        self.cdp.events = []          # 清掉旧页面的残留事件
        self.cdp.call("Page.navigate", {"url": url}, timeout=timeout)
        if self.cdp.wait_event("Page.loadEventFired", timeout) is not None:
            return True
        warn("等待页面加载事件超时，继续尝试")
        return False

    # ---------- 抓包 ----------
    def enable_network(self):
        """必须在导航之前开启，否则会错过页面首包的 XHR/fetch。"""
        self.cdp.call("Network.enable", {
            "maxTotalBufferSize": 200 * 1024 * 1024,
            "maxResourceBufferSize": 40 * 1024 * 1024,
        })

    def capture(self, min_seconds=2.0, idle=1.2, max_seconds=30.0, keep=None):
        """抓取网络响应体。返回 [(url, text)]。调用前请先 enable_network()。"""
        meta = {}
        bodies = []
        start = last = time.time()
        while True:
            now = time.time()
            if now - start > max_seconds:
                break
            if now - start > min_seconds and now - last > idle:
                break
            self.cdp.pump(0.25)
            for ev in self.cdp.take_events():
                method = ev.get("method")
                if method == "Network.responseReceived":
                    p = ev.get("params") or {}
                    resp = p.get("response") or {}
                    rid = p.get("requestId")
                    meta[rid] = {
                        "url": resp.get("url") or "",
                        "mime": (resp.get("mimeType") or "").lower(),
                        "status": resp.get("status"),
                    }
                    last = time.time()
                elif method == "Network.loadingFinished":
                    rid = (ev.get("params") or {}).get("requestId")
                    info = meta.get(rid)
                    if not info:
                        continue
                    if info["status"] and int(info["status"]) >= 300:
                        continue
                    if keep and not keep(info):
                        continue
                    if info["mime"] and not re.search(r"json|javascript|html|text", info["mime"]):
                        continue
                    try:
                        res = self.cdp.call("Network.getResponseBody", {"requestId": rid}, timeout=8.0)
                    except CDPError:
                        continue
                    body = res.get("body") or ""
                    if res.get("base64Encoded"):
                        try:
                            body = base64.b64decode(body).decode("utf-8", "replace")
                        except Exception:
                            continue
                    if body:
                        bodies.append((info["url"], body))
                        last = time.time()
        return bodies


# ============================================================
# 题库文件
# ============================================================
def load_bank_file(path):
    if not path or not os.path.isfile(path):
        return {"v": 1, "ts": "", "items": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        warn("题库文件读取失败（按空库处理）: %s" % exc)
        return {"v": 1, "ts": "", "items": {}}
    if isinstance(data, dict) and "items" in data:
        return data
    if isinstance(data, dict):
        return {"v": 1, "ts": "", "items": data}
    return {"v": 1, "ts": "", "items": {}}


def save_bank_file(path, items):
    if not path:
        return
    d = os.path.dirname(os.path.abspath(path))
    if d and not os.path.isdir(d):
        os.makedirs(d)
    payload = {"v": 1, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "items": items}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)


def merge_items(base, extra):
    merged = dict(base or {})
    merged.update(extra or {})
    return merged


# ============================================================
# 渲染
# ============================================================
SRC_LABEL = {"page": "页面数据", "net": "网络JSON", "bank": "题库", "dom-attr": "页面标记",
             "result-dom": "结果页", "inline": "内联脚本"}


def print_details(details, limit=200):
    out("")
    out("  %-4s %-8s %-6s %-8s %s" % ("#", "题型", "答案", "来源", "题干"))
    out("  " + "-" * 78)
    shown = 0
    for d in details:
        if shown >= limit:
            out("  ... 其余 %d 条省略" % (len(details) - shown))
            break
        shown += 1
        src = SRC_LABEL.get(d.get("src") or "", d.get("src") or "-")
        if d.get("sim") and d["sim"] < 1:
            src += "(%.2f)" % d["sim"]
        stem = d.get("stem") or ""
        out("  %-4s %-8s %-6s %-8s %s" % (
            d.get("idx", ""), d.get("type", "") or "-", d.get("ans", "") or "—",
            src, stem[:44]))


def print_summary(st, bank_size, extra=None):
    out("")
    out("  题目 %d   命中 %d   已填 %d   缺答案 %d   题库 %d 条" % (
        st.get("total", 0), st.get("hit", 0), st.get("filled", 0), st.get("missed", 0), bank_size))
    if extra:
        out("  " + extra)


# ============================================================
# 子命令
# ============================================================
def cmd_doctor(args):
    out("tsw_answer %s" % VERSION)
    out("Python %s  %s" % (platform.python_version(), platform.platform()))
    out("")
    out("浏览器:")
    cands = candidate_browsers()
    if not cands:
        warn("未找到 Chromium 内核浏览器（Chrome / Edge / 360）。")
    for name, path in cands:
        out("  - %-16s %s" % (name, path))
    out("")
    out("核心脚本:")
    try:
        core = locate_core(args.core)
        out("  - %s (%d 字节)" % (core, os.path.getsize(core)))
    except SystemExit:
        pass
    out("")
    out("调试端口 %d:" % args.port)
    if port_alive(args.port):
        try:
            ver = http_json("http://127.0.0.1:%d/json/version" % args.port)
            out("  - 在线: %s" % ver.get("Browser"))
            pages = [t for t in list_targets(args.port) if t.get("type") == "page"]
            out("  - 标签页 %d 个" % len(pages))
            for p in pages[:5]:
                out("      * %s" % (p.get("url") or "")[:96])
        except Exception as exc:
            warn("端口有响应但读取失败: %s" % exc)
    else:
        out("  - 未监听。用 `python %s launch` 启动。" % os.path.basename(__file__))
    out("")
    out("题库文件: %s" % args.bank)
    bank = load_bank_file(args.bank)
    out("  - %d 条" % len(bank.get("items") or {}))


def cmd_launch(args):
    r = launch_browser(browser=args.browser, port=args.port, url=args.url,
                       profile=args.profile, headless=args.headless,
                       extra_args=args.arg, wait=args.wait)
    if not r:
        return 2
    out("")
    out("接下来：")
    out("  1) 在这个浏览器里登录淘师湾，进入作业答题页")
    out("  2) 运行：python %s run --reuse --submit" % os.path.basename(__file__))
    return 0


def cmd_run(args):
    core_path = locate_core(args.core)
    core_src = read_core(core_path)

    page = Page(args.port, url_hint=args.url if args.reuse else None)
    out("已附着标签页: %s" % (page.target.get("url") or ""))
    out("核心脚本: %s (v%s)" % (core_path, VERSION))

    # 让核心在下次导航的 document-start 就位，并先开 Network 再导航
    page.cdp.call("Page.addScriptToEvaluateOnNewDocument", {"source": core_src})
    page.enable_network()

    if args.url and not args.reuse:
        page.navigate(args.url)
        bodies = page.capture(min_seconds=args.min_wait, idle=args.idle,
                              max_seconds=args.max_wait)
        out("抓取响应 %d 条" % len(bodies))
    else:
        out("复用当前页面，重新加载以抓取接口请求")
        page.cdp.call("Page.reload", {"ignoreCache": False})
        time.sleep(0.4)
        bodies = page.capture(min_seconds=args.min_wait, idle=args.idle,
                              max_seconds=args.max_wait)

    # 核心可能因页面刷新而重载，重新确认
    ver = page.eval("(window.TSWCore && window.TSWCore.version) || null")
    if not ver:
        page.inject(core_src)
        ver = page.eval("(window.TSWCore && window.TSWCore.version) || null")
    if not ver:
        die("核心脚本注入失败。检查 tsw_core.js 是否完整。")
    out("核心就绪 v%s" % ver)

    # 1) 先灌入抓到的响应
    if bodies:
        payload = json.dumps([b for _, b in bodies], ensure_ascii=False)
        try:
            page.eval("TSWCore.ingestTexts(%s)" % payload, timeout=60.0)
        except CDPError as exc:
            warn("灌入响应失败: %s" % exc)
        out("已解析响应，页面数据候选 %d 条" % (page.eval("TSWCore.candidates().length") or 0))

    # 2) 本地题库预热
    bank = load_bank_file(args.bank)
    items = bank.get("items") or {}
    if items:
        try:
            page.eval("TSWCore.importBank(%s, true)" % json.dumps(
                json.dumps({"items": items}, ensure_ascii=False), ensure_ascii=False))
            out("本地题库预热 %d 条" % len(items))
        except CDPError as exc:
            warn("题库预热失败: %s" % exc)

    # 3) 页面内联数据（结果页/解析页会在这里命中）
    page.eval("TSWCore.harvestInline()")

    # 4) 填涂
    dry = "true" if args.dry_run else "false"
    st = page.eval("TSWCore.fillAll({dryRun:%s})" % dry, await_promise=True, timeout=120.0)
    if not st:
        die("fillAll 没有返回结果")
    print_details(st.get("details") or [])
    print_summary(st, page.eval("TSWCore.bankSize()") or 0)

    # 5) 回写题库
    try:
        exported = json.loads(page.eval("TSWCore.exportBank()") or "{}")
        page_items = exported.get("items") or {}
    except Exception:
        page_items = {}
    merged = merge_items(items, page_items)
    if args.bank:
        save_bank_file(args.bank, merged)
        out("题库已保存：%s（%d 条，本次新增 %d）" % (
            args.bank, len(merged), max(0, len(merged) - len(items))))

    # 6) 交卷
    if args.submit and not args.dry_run:
        if st.get("missed", 0) > 0 and not args.force:
            warn("还有 %d 道题没答案，未交卷。确认要交用 --force" % st.get("missed"))
        else:
            if args.yes or confirm("确认交卷？"):
                page.eval("(TSWCore.submit(), true)")
                out("已触发交卷，请在浏览器里确认弹层/结果")
            else:
                out("已取消交卷")
    elif not args.submit:
        out("未交卷（需要时加 --submit --yes）")

    if args.json:
        st["bankSize"] = len(merged)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=2)
        out("结果已写入 %s" % args.json)

    page.cdp.close()
    return 0


def confirm(prompt):
    try:
        ans = input("%s [y/N] " % prompt)
    except EOFError:
        return False
    return ans.strip().lower() in ("y", "yes")


def cmd_bank(args):
    bank = load_bank_file(args.bank)
    items = bank.get("items") or {}
    if args.action == "stats":
        out("题库：%s" % args.bank)
        out("  条目 %d" % len(items))
        by_src = {}
        for k, v in items.items():
            s = (v or {}).get("src") or "?"
            by_src[s] = by_src.get(s, 0) + 1
        for s in sorted(by_src):
            out("    %-12s %d" % (SRC_LABEL.get(s, s), by_src[s]))
        for i, (k, v) in enumerate(sorted(items.items(), key=lambda kv: -(kv[1] or {}).get("t", 0))[:5]):
            out("    [%d] %s => %s" % (i + 1, (v.get("stem") or "")[:40], v.get("ans")))
    elif args.action == "export":
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(bank, f, ensure_ascii=False, indent=2, sort_keys=True)
        out("已导出 %d 条到 %s" % (len(items), args.out))
    elif args.action == "merge":
        if not args.other:
            die("merge 需要 --other <另一个题库文件>")
        other = load_bank_file(args.other)
        merged = merge_items(items, other.get("items") or {})
        save_bank_file(args.bank, merged)
        out("合并完成：%d -> %d" % (len(items), len(merged)))
    elif args.action == "import":
        if not args.other:
            die("import 需要 --other <JSON 文件>")
        other = load_bank_file(args.other)
        merged = merge_items(items, other.get("items") or {})
        save_bank_file(args.bank, merged)
        out("导入完成：%d -> %d" % (len(items), len(merged)))
    return 0


def cmd_diag(args):
    core_src = read_core(locate_core(args.core))
    page = Page(args.port, url_hint=args.url)
    out("附着: %s" % (page.target.get("url") or ""))
    if not page.eval("(window.TSWCore && window.TSWCore.version) || null"):
        page.inject(core_src)
    data = page.eval("TSWCore.diagnose()")
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        out("诊断已写入 %s（识别 %d 题）" % (args.out, len((data or {}).get("questions") or [])))
    else:
        out(text)
    page.cdp.close()
    return 0


# ============================================================
# CLI
# ============================================================
def build_parser():
    # 公共参数：既能写在子命令前（全局），也能写在子命令后
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, default=argparse.SUPPRESS, help="调试端口")
    common.add_argument("--core", default=argparse.SUPPRESS, help="tsw_core.js 路径")
    common.add_argument("--bank", default=argparse.SUPPRESS, help="题库文件路径")

    p = argparse.ArgumentParser(
        prog="tsw_answer.py",
        description="淘师湾作业网 本地自动答题（Python 3.6+，仅标准库，CDP 驱动 Chrome/360）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python tsw_answer.py doctor
  python tsw_answer.py launch --browser 360 --port 9222
  python tsw_answer.py run --reuse --submit
  python tsw_answer.py run --url "https://infotech.51taoshi.com/hw/stdAnswer/gotoAnswerPage.do?paperId=xxx"
""")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="调试端口，默认 %d" % DEFAULT_PORT)
    p.add_argument("--core", help="tsw_core.js 路径（默认与本脚本同目录）")
    p.add_argument("--bank", default=os.path.join(HERE, "bank.json"), help="题库文件路径")
    sub = p.add_subparsers(dest="cmd")

    d = sub.add_parser("doctor", help="环境体检", parents=[common])
    d.set_defaults(func=cmd_doctor)

    l = sub.add_parser("launch", help="启动浏览器并开启调试端口", parents=[common])
    l.add_argument("--browser", default="auto", help="auto / chrome / edge / 360 / 可执行文件路径")
    l.add_argument("--url", default="about:blank", help="启动时打开的地址")
    l.add_argument("--profile", help="user-data-dir（默认临时目录，不动你的日常配置）")
    l.add_argument("--headless", action="store_true", help="无头模式（首次登录不建议）")
    l.add_argument("--arg", action="append", help="额外浏览器参数，可重复")
    l.add_argument("--wait", type=float, default=6.0, help="等待端口就绪的秒数")
    l.set_defaults(func=cmd_launch)

    r = sub.add_parser("run", help="抓答案并作答", parents=[common])
    r.add_argument("--url", help="答题页地址；不填则配合 --reuse")
    r.add_argument("--reuse", action="store_true", help="复用浏览器当前标签页（先在界面里打开答题页）")
    r.add_argument("--submit", action="store_true", help="作答后点击交卷")
    r.add_argument("--yes", action="store_true", help="交卷不再二次确认")
    r.add_argument("--force", action="store_true", help="有题没答案也强行交卷")
    r.add_argument("--dry-run", action="store_true", help="只扫描不填涂")
    r.add_argument("--min-wait", type=float, default=2.0, help="抓包最少等待秒数")
    r.add_argument("--idle", type=float, default=1.2, help="网络空闲判定秒数")
    r.add_argument("--max-wait", type=float, default=30.0, help="抓包最长等待秒数")
    r.add_argument("--json", help="把结果写入 JSON 文件")
    r.set_defaults(func=cmd_run)

    b = sub.add_parser("bank", help="题库维护", parents=[common])
    b.add_argument("action", choices=["stats", "export", "import", "merge"])
    b.add_argument("--out", default="bank-export.json")
    b.add_argument("--other", help="导入/合并的来源文件")
    b.set_defaults(func=cmd_bank)

    g = sub.add_parser("diag", help="导出页面结构诊断", parents=[common])
    g.add_argument("--url", help="仅做 url 匹配用")
    g.add_argument("--out", help="写入文件，不填则打印")
    g.set_defaults(func=cmd_diag)

    return p


def main(argv=None):
    _init_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return args.func(args) or 0
    except CDPError as exc:
        die("CDP 错误: %s" % exc, 3)
    except WSError as exc:
        die("WebSocket 错误: %s" % exc, 3)
    except urllib.error.URLError as exc:
        die("无法连接浏览器调试端口: %s" % exc, 3)
    except KeyboardInterrupt:
        out("")
        out("已中断")
        return 130


if __name__ == "__main__":
    sys.exit(main())
