# 更新记录

## v1.1.0 — 2026-11-12

### 新增
- **程序推演通道 `vb`**（`tsw_vb.js`）：题干里带 VB 代码的程序阅读题，直接把代码推演执行，
  用输出匹配选项。页面不下发答案、题库里也没有这道题时，仍能算出来。
  - VB6 子集：`Sub/End Sub`、`Dim`、`For…Next`(Step/Exit For)、`Do While/Until…Loop`、
    `While…Wend`、`If/ElseIf/Else`、`Print`、`Text1.Text`/`Val(Text1.Text)`、`&`、`Mod`、`\`、
    `And/Or/Not`、`Mid/Len/Left/Right/UCase/LCase/Trim/Str/Val/Chr/Asc` 等
  - 页面把题干压成一行时自动按 VB 关键字重新断行；不认识的语法直接放弃，不猜答案
  - 题库优先：`bank` 命中时不走推演
- 靶场新增 2 道 VB 程序题（q13/q14）与 `tests/test_vb_channel.py` 三个端到端场景

### 变更
- `tsw_core.js` 版本 1.1.0：`findAnswer()` 在页面/标记/题库都未命中时调用 `tryVb()`
- `build.py` 打包顺序：`tsw_vb.js` → `tsw_core.js` → `src/panel.js`
- Python 版 `read_core()` 同时注入同目录的 `tsw_vb.js`（缺失时自动降级，不影响原有三条通道）

### 验证
- 场景1 接口下发答案：14/14 → 70/70（回归原有 `page` 通道）
- 场景2 `noleak=1`：只答出 2 道程序题，来源均为 `vb`，服务端判分 10/70
- 场景3 题库 + 推演：14/14 → 70/70（题库优先，推演兜底）

## v1.0.0 — 2026-11-04

首个可发布版本。

### 新增
- **油猴脚本** `51taoshi-auto-answer.user.js`
  - 三条取答案通道：页面接口 JSON / 结果页「正确答案」/ 本地题库
  - 支持单选、多选、判断、填空，以及无 `<input>` 的点击式选项
  - Shadow DOM 悬浮面板：扫描、作答、交卷、导出题库、诊断、拖动、折叠
  - `@run-at document-start` 挂钩 XHR/fetch，抓得到页面首包
- **Python 本地脚本** `tsw_answer.py`（Python 3.6+，仅标准库）
  - 自带 WebSocket 客户端与 CDP 驱动，无需 chromedriver、无需 pip
  - 通过 CDP `Network` 域抓接口响应，比油猴钩子更稳
  - 自动发现 Chrome / Edge / 360 安全 / 360 极速（含注册表探测）
  - 子命令：`doctor` / `launch` / `run` / `diag` / `bank`
  - `--reuse` 复用已登录标签页，`--dry-run` 只扫描，`--submit` 交卷
- **共享引擎** `tsw_core.js`：油猴版与 Python 版同一份逻辑，避免两套实现漂移
- `build.py`：从 `local/` 源码组装油猴脚本
- `mock/lab_server.py`：离线靶场，复刻真实站点 URL/DOM/判分接口
- `docs/PRINCIPLE.md`：答案泄漏面证据链

### 验证
- 油猴：`page` 通道 12/12、`result-dom` 采集 12 条、`bank` 通道 12/12，均交卷 60/60
- Python：`run --url` 与 `run --reuse` 均 12/12 → 60/60
- 点击式选项：12/12 → 60/60
- 真实站点 `infotech.51taoshi.com` 注入冒烟：面板正常、无运行时报错

### 已知限制
- 图片题、拖拽题、操作题无文本答案，未覆盖
- 答题页需登录；脚本不处理登录，也不做任何越权访问
- 360 浏览器已运行时新参数会被忽略，需先完全退出
