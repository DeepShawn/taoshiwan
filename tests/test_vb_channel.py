#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""程序推演通道（tsw_vb.js）端到端测试。

启动离线靶场 → 用 Chromium 打开答题页 → 跑 TSWCore.run() → 交卷 → 看服务端判分。
两个场景：
  1) 正常页（接口下发答案）：14 题全中，程序题由 page 通道命中
  2) noleak=1（不下发答案）：只有两道程序题能答，必须由 vb 通道给出 B/B

用法：python3 tests/test_vb_channel.py
"""
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
USCRIPT = os.path.join(ROOT, "51taoshi-auto-answer.user.js")

fails = []


def check(name, cond, detail=""):
    print(("  PASS " if cond else "  FAIL ") + name + ("" if cond else "  <- %r" % (detail,)))
    if not cond:
        fails.append(name)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_port(port, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def run_page(browser, base, query, clear_bank=True):
    page = browser.new_page()
    page.goto(base + "/hw/stdAnswer/gotoAnswerPage.do" + query, wait_until="load")
    page.wait_for_selector(".testCont", timeout=8000)
    if clear_bank:
        page.evaluate("() => { try { localStorage.removeItem('tsw_aa_bank_v1'); } catch (e) {} }")
        page.reload(wait_until="load")
        page.wait_for_selector(".testCont", timeout=8000)
    page.wait_for_timeout(600)
    st = page.evaluate("async () => TSWCore.fillAll({})")
    return page, st


def submit_and_score(page):
    page.evaluate("() => TSWCore.submit()")
    page.wait_for_timeout(1200)
    raw = page.evaluate("() => localStorage.getItem('lastResult')")
    return json.loads(raw) if raw else None


def main():
    with open(USCRIPT, "rb") as f:
        script = f.read().decode("utf-8")

    port = free_port()
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "mock", "lab_server.py"), str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(port):
            print("靶场没起来")
            return 1
        base = "http://127.0.0.1:%d" % port

        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---- 场景 1：答案随接口下发 ----
            page = browser.new_page()
            page.goto(base + "/hw/stdAnswer/gotoAnswerPage.do", wait_until="load")
            page.add_script_tag(content=script)
            page.wait_for_selector(".testCont", timeout=8000)
            page.wait_for_timeout(800)
            st = page.evaluate("async () => TSWCore.fillAll({})")
            print("场景1 统计:", {k: st[k] for k in ("total", "hit", "filled", "missed")})
            check("场景1 识别 14 题", st["total"] == 14, st["total"])
            check("场景1 全部命中", st["hit"] == 14 and st["missed"] == 0, st)
            check("场景1 全部填涂", st["filled"] == 14, st["filled"])
            bank_text = page.evaluate("() => TSWCore.exportBank()")
            res = submit_and_score(page)
            check("场景1 服务端判分满分 70", bool(res) and res["score"] == 70, res and res["score"])
            page.close()

            # ---- 场景 2：接口不下发答案，只能靠推演 ----
            page = browser.new_page()
            page.goto(base + "/hw/stdAnswer/gotoAnswerPage.do?noleak=1", wait_until="load")
            page.add_script_tag(content=script)
            page.wait_for_selector(".testCont", timeout=8000)
            page.evaluate("() => { try { localStorage.removeItem('tsw_aa_bank_v1'); } catch (e) {} }")
            page.reload(wait_until="load")
            page.add_script_tag(content=script)
            page.wait_for_selector(".testCont", timeout=8000)
            page.wait_for_timeout(800)
            st = page.evaluate("async () => TSWCore.fillAll({})")
            srcs = [d.get("src") for d in st["details"] if d.get("ans")]
            print("场景2 统计:", {k: st[k] for k in ("total", "hit", "filled", "missed")}, "src=", srcs)
            check("场景2 识别 14 题", st["total"] == 14, st["total"])
            check("场景2 只答出 2 题（程序题）", st["hit"] == 2, st["hit"])
            check("场景2 命中来源都是 vb", srcs == ["vb", "vb"], srcs)
            check("场景2 程序题答案是 B", [d["ans"] for d in st["details"] if d.get("ans")] == ["B", "B"],
                  [d["ans"] for d in st["details"] if d.get("ans")])
            res = submit_and_score(page)
            check("场景2 服务端判分 10 分（两题各 5 分）", bool(res) and res["score"] == 10,
                  res and res["score"])
            page.close()

            # ---- 场景 3：题库 + 推演混合（保护原有 bank 通道） ----
            page = browser.new_page()
            page.goto(base + "/hw/stdAnswer/gotoAnswerPage.do?noleak=1", wait_until="load")
            page.add_script_tag(content=script)
            page.wait_for_selector(".testCont", timeout=8000)
            page.evaluate("() => { try { localStorage.removeItem('tsw_aa_bank_v1'); } catch (e) {} }")
            page.reload(wait_until="load")
            page.add_script_tag(content=script)
            page.wait_for_selector(".testCont", timeout=8000)
            page.wait_for_timeout(500)
            page.evaluate("(b) => TSWCore.importBank(b, true)", bank_text)
            st = page.evaluate("async () => TSWCore.fillAll({})")
            srcs = [d.get("src") for d in st["details"] if d.get("ans")]
            print("场景3 统计:", {k: st[k] for k in ("total", "hit", "filled", "missed")},
                  "bank=%d vb=%d" % (srcs.count("bank"), srcs.count("vb")))
            check("场景3 题库+推演共答 14 题", st["hit"] == 14 and st["filled"] == 14, st["hit"])
            # 题库优先（场景1 已把 14 题连同程序题一起采集进题库），推演作为兜底
            check("场景3 全部命中且题库优先", srcs.count("bank") == 14, srcs)
            res = submit_and_score(page)
            check("场景3 服务端判分满分 70", bool(res) and res["score"] == 70, res and res["score"])
            page.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print("\n%s" % ("ALL PASS" if not fails else "FAILED: " + ", ".join(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
