#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py —— 把 local/tsw_core.js + local/panel.js 组装成可安装的油猴脚本

用法：
    python build.py                 # 生成 51taoshi-auto-answer.user.js
    python build.py --check         # 只做一致性检查，不写文件

产物在仓库根目录，便于 Tampermonkey 直接从 raw 地址安装。
"""

import argparse
import hashlib
import io
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "tsw_core.js")
PANEL = os.path.join(HERE, "src", "panel.js")
VB = os.path.join(HERE, "tsw_vb.js")
OUT = os.path.join(HERE, "51taoshi-auto-answer.user.js")

VERSION = "1.1.0"
REPO = "DeepShawn/taoshiwan"
RAW_BASE = "https://raw.githubusercontent.com/%s/main" % REPO

HEADER = """\
// ==UserScript==
// @name         淘师湾作业网 · 答案提取与自动答题
// @namespace    https://infotech.51taoshi.com/
// @version      {version}
// @description  面向淘师湾/湖北省信息技术作业网作业页：抓取页面自身下发的试卷数据取出标准答案，建本地题库，并用内置 VB 解释器推演程序阅读题，一键填涂与交卷。
// @author       DeepShawn
// @homepageURL  https://github.com/{repo}
// @supportURL   https://github.com/{repo}/issues
// @downloadURL  {raw}/51taoshi-auto-answer.user.js
// @updateURL    {raw}/51taoshi-auto-answer.user.js
// @match        *://infotech.51taoshi.com/*
// @match        *://www.51taoshi.com/hw/*
// @match        *://*/hw/stdAnswer/*
// @match        *://*/hw/stu/*
// @match        *://*/hw/course/*
// @match        *://localhost:*/*
// @match        *://127.0.0.1:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/* 构建信息：{stamp}
 * 本文件由 build.py 生成，请勿直接编辑。
 * 源码：tsw_vb.js（程序推演） + tsw_core.js（引擎） + src/panel.js（界面）
 */
"""


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def build():
    if not os.path.isfile(CORE):
        raise SystemExit("缺少 %s" % CORE)
    if not os.path.isfile(PANEL):
        raise SystemExit("缺少 %s" % PANEL)

    core = read(CORE)
    panel = read(PANEL)
    vb = read(VB) if os.path.isfile(VB) else ""

    # 极简健全性检查：核心必须定义 TSWCore 且带 version
    if "root.TSWCore = TSWCore" not in core:
        raise SystemExit("tsw_core.js 缺少 TSWCore 导出")
    if "C.version" not in panel and "TSWCore.version" not in panel:
        raise SystemExit("panel.js 没有引用 TSWCore 的版本号")

    header = HEADER.format(
        version=VERSION,
        repo=REPO,
        raw=RAW_BASE,
        stamp=time.strftime("%Y-%m-%d %H:%M:%S"),
    )

    body = header + "\n" + vb + "\n" + core + "\n\n" + panel + "\n"
    return body


def sanity_check(text):
    """粗查括号平衡与常见 3.6 不兼容语法（油猴脚本本身不受 py 版本限制，这里只防手误）。"""
    problems = []
    if text.count("TSWCore") < 5:
        problems.append("TSWCore 引用次数异常")
    if "root.Vb" not in text:
        problems.append("程序推演模块 tsw_vb.js 未打包")
    if "@run-at       document-start" not in text:
        problems.append("缺少 @run-at document-start（抓不到早期请求）")
    if text.count("function (root)") < 2:
        problems.append("两个 IIFE 包装缺失")
    for bad in ("?.", "??"):
        for m in re.finditer(re.escape(bad), text):
            # 允许字符串里出现（这里简单报位置）
            problems.append("出现 %s（老内核 360 会报错）附近: %r" % (bad, text[max(0, m.start() - 30):m.start() + 10]))
            break
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查，不写文件")
    args = ap.parse_args()

    text = build()
    problems = sanity_check(text)

    if problems:
        print("检查未通过：")
        for p in problems:
            print("  - " + p)
        if args.check:
            return 1

    if args.check:
        print("检查通过，%d 字节" % len(text.encode("utf-8")))
        return 0

    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print("已生成 %s" % OUT)
    print("  行数 %d  字节 %d  sha256:%s" % (text.count("\n") + 1, len(text.encode("utf-8")), digest))
    if problems:
        print("  警告：")
        for p in problems:
            print("    - " + p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
