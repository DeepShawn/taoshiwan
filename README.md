# 淘师湾作业网 · 自动答题（Tampermonkey 油猴脚本 + Python 本地脚本）

针对 **淘师湾 / 湖北省信息技术作业网**（`infotech.51taoshi.com`）的作业答题页：
把页面自己下发到浏览器的试卷数据里的**标准答案**取出来，建立本地题库，然后一键填涂、可选交卷。

两种用法，任选其一：

| 方式 | 适合谁 | 需要什么 |
| --- | --- | --- |
| **A. 油猴脚本** | 只想在自己浏览器里用 | Tampermonkey 扩展 |
| **B. Python 本地脚本** | 想命令行一把梭 / 批量 / 有 360 浏览器 | Python 3.6+，**不用 pip install** |

---

## 目录

- [为什么能出答案](#为什么能出答案)
- [方式 A：Tampermonkey 油猴脚本](#方式-atmpermonkey-油猴脚本)
- [方式 B：Python 本地脚本](#方式-bpython-本地脚本)
- [题库（bank.json）](#题库bankjson)
- [常见问题](#常见问题)
- [验证结果](#验证结果)
- [本地靶场](#本地靶场)

---

## 为什么能出答案

老式 Java 教辅系统把**整份试卷连同判分字段**一起下发给浏览器，答案和题干在同一个 JSON 对象里：

```json
{
  "field05": "题目ID",
  "field01": "题干",
  "questionTypeName": "单选题",
  "options": [ { "field03": "A", "field01": "选项内容" } ],
  "answer": "A",
  "field04": "A"
}
```

字段含义由站内静态脚本 `/statics/tiku/questionMain.js`（无需登录即可下载）直接暴露：
`field01` 题干/选项文本、`field03` 选项字母、`field04` 标准答案、`field05` 题号。

于是有四条互相独立的取答案通道，任意一条命中即可作答（题库优先，推演兜底）：

| 通道 | 拿什么 | 在哪生效 |
| --- | --- | --- |
| `page` | 页面接口返回的试卷 JSON | 答题页 |
| `result-dom` | 结果页「正确答案：X」/ 高亮正确项 | 作业结果、解析页 |
| `bank` | 本地题库（题干指纹 + 模糊匹配） | 无答案下发的加固页、同题库的另一份作业 |
| `vb` | 题干里的 VB 代码**直接推演跑一遍**，用输出匹配选项 | 程序阅读题；页面不下发答案时仍能算出来 |

脚本**只读当前页面已经拿到的数据**，不爆破账号、不改服务端、不猜测他人答案。
详细证据链见 [`docs/PRINCIPLE.md`](docs/PRINCIPLE.md)。

---

## 方式 A：Tampermonkey 油猴脚本

### A1. 安装

1. 给浏览器装 **Tampermonkey**（油猴）扩展：
   - Chrome / Edge：应用商店搜 “Tampermonkey”
   - **360 浏览器**：先在扩展中心装 “Tampermonkey”，或把 Chrome 商店里的油猴装进 360（360 极速浏览器可直接装 Chrome 扩展）
2. 点这个链接直接安装脚本（油猴会自动弹出安装页，点「安装」）：

   **<https://raw.githubusercontent.com/DeepShawn/taoshiwan/main/51taoshi-auto-answer.user.js>**

   或者：打开油猴面板 → 添加新脚本 → 把仓库根目录 `51taoshi-auto-answer.user.js` 的内容整段粘进去 → `Ctrl+S` 保存。
3. 打开任意淘师湾页面，**右下角出现绿色悬浮面板**就说明装好了。

### A2. 用起来

1. 先正常登录淘师湾，进入 **我的课程 → 做作业**，打开答题页。
2. 页面加载完后，脚本会自动识别题目并填涂，每题左上角出现标签：

   ```
   答案 A · 页面数据        ← 从页面接口里直接取到的
   答案 A · 题库            ← 从本地题库匹配到的
   ```

3. 面板上的按钮：

   | 按钮 | 作用 |
   | --- | --- |
   | **扫描并作答** | 识别题目 → 找答案 → 填涂 |
   | **只扫描** | 只统计命中率，不动页面（上考场前先点这个） |
   | **交卷** | 找「提交试卷」按钮并自动确认弹层 |
   | **导出题库** | 下载 `tsw-answer-bank-日期.json` |
   | **诊断** | 导出版式诊断 JSON（版式变了改选择器用） |
   | 自动作答 / 自动交卷 | 勾选后自动执行；自动交卷有 4 秒倒计时 |
   | 清空题库 | 清掉这个站点的本地题库 |

4. 面板可拖动，点 `—` 折叠。

### A3. 建议的正确用法

先点 **只扫描** 看「命中 / 题目」：

- 全中 → 点 **扫描并作答** → 人工看一眼 → 点 **交卷**
- 有缺 → 说明这次页面没带答案（或题型不支持），先去做一遍/看一遍**作业结果页**，
  结果页里的「正确答案」会被自动收进题库，下次直接命中

### A4. 面板不出现？

- 确认油猴里这条脚本是 **启用** 状态
- 确认当前域名在 `@match` 里（默认覆盖 `infotech.51taoshi.com`、`www.51taoshi.com/hw/*`、`*/hw/stdAnswer/*`、`*/hw/stu/*`、`*/hw/course/*`）
  若你们学校部署在别的域名，在脚本头部加一行 `// @match *://你们域名/*`
- 360 浏览器偶发不注入：把脚本 `@run-at` 已经是 `document-start`，仍不行就在油猴设置里关闭「实验性功能」里的沙箱试试

---

## 方式 B：Python 本地脚本

纯标准库（自带 WebSocket + CDP 实现），**不需要 `pip install`**，不需要 chromedriver。
支持任何 Chromium 内核浏览器：**Chrome / Edge / 360 安全浏览器 / 360 极速浏览器 / 2345** 等。

```
tsw_answer.py      # 主程序（Python 3.6+）
tsw_core.js        # 页面里跑的引擎，必须和 tsw_answer.py 放同一目录
```

### B1. 准备

```bash
# 只需要 Python 3.6 或更高版本
python --version

# 把两个文件放同一个目录，比如 D:\tsw\
#   D:\tsw\tsw_answer.py
#   D:\tsw\tsw_core.js
```

### B2. 体检

```bash
python tsw_answer.py doctor
```

会打印：Python 版本、找到的浏览器、`tsw_core.js` 位置、调试端口状态、题库条数。

### B3. 启动浏览器（带调试端口）

```bash
python tsw_answer.py launch --browser 360
```

- `--browser` 可选 `auto`（默认，自动挑）/ `chrome` / `edge` / `360`，也可以直接给 exe 路径：
  `--browser "C:\Program Files (x86)\360\360se6\Application\360se.exe"`
- 会用**独立的临时配置目录**（`%TEMP%\tsw-profile-*`），不碰你日常的浏览器配置和登录状态
- 端口默认 `9222`，可用 `--port 9333` 换一个

> **重要**：如果那个浏览器**已经在运行**，新参数会被忽略（浏览器单实例机制）。
> 请先把目标浏览器**完全退出**（任务管理器里确认没有残留进程）再执行 `launch`。

启动后在这个浏览器窗口里**手动登录**淘师湾，进入作业答题页。脚本不碰你的账号密码。

### B4. 抓答案并作答

**推荐方式：在界面里打开答题页后 `--reuse`**

```bash
python tsw_answer.py run --reuse
```

输出示例：

```
已附着标签页: https://infotech.51taoshi.com/hw/stdAnswer/gotoAnswerPage.do?paperId=...
抓取响应 3 条
核心就绪 v1.0.0
已解析响应，页面数据候选 12 条
本地题库预热 12 条

  #    题型       答案     来源       题干
  ------------------------------------------------------------------------------
  1    single   A      页面数据     在Python中，用于表示“并且”的逻辑运算符是（ ）
  2    single   D      页面数据     下列存储容量单位中，最大的是（ ）
  ...
  12   fill     DNS    页面数据     在网络中，把域名转换为IP地址的服务称为＿＿＿＿。

  题目 12   命中 12   已填 12   缺答案 0   题库 12 条
题库已保存：bank.json（12 条，本次新增 12）
未交卷（需要时加 --submit --yes）
```

**也可以直接给地址**（脚本自己导航过去并抓包）：

```bash
python tsw_answer.py run --url "https://infotech.51taoshi.com/hw/stdAnswer/gotoAnswerPage.do?paperId=xxxxx"
```

**交卷**（默认不交，交卷不可撤销）：

```bash
python tsw_answer.py run --reuse --submit --yes     # --yes 跳过二次确认
python tsw_answer.py run --reuse --submit           # 会问你 y/N
```

有题没答案时脚本会拒绝交卷，确实要交加 `--force`。

### B5. 参数速查

| 参数 | 说明 |
| --- | --- |
| `--port 9222` | 调试端口（全局，写在子命令前后都行） |
| `--bank bank.json` | 题库文件路径 |
| `--core tsw_core.js` | 引擎路径（默认同目录自动找） |
| `run --url <URL>` | 打开该地址并抓包作答 |
| `run --reuse` | 复用浏览器当前标签页 |
| `run --dry-run` | 只扫描不填涂 |
| `run --submit --yes` | 作答后交卷 |
| `run --force` | 有缺答案也交卷 |
| `run --json out.json` | 结果写入文件 |
| `run --min-wait 2 --idle 1.2 --max-wait 30` | 抓包等待策略（网络慢就调大） |
| `diag --out diag.json` | 导出版式诊断 |
| `bank stats / export / import / merge` | 题库维护 |

### B6. 子命令一览

```bash
python tsw_answer.py doctor                  # 环境体检
python tsw_answer.py launch [--browser 360]  # 启动浏览器
python tsw_answer.py run --reuse [--submit]  # 抓答案 + 作答
python tsw_answer.py diag --out diag.json    # 导出版式诊断
python tsw_answer.py bank stats              # 看题库
python tsw_answer.py bank export --out a.json
python tsw_answer.py bank merge --other b.json
```

---

## 题库（bank.json）

两条通道共用同一套题库：油猴版存在**浏览器 localStorage**，Python 版存在**磁盘 bank.json**。
两边格式相同，可以互相导入。

```bash
python tsw_answer.py bank stats        # 条目数、来源分布、最近 5 条
python tsw_answer.py bank export --out a.json
python tsw_answer.py bank merge --other b.json
```

油猴版 ↔ Python 版互通：

1. 油猴面板点 **导出题库** → 得到 `tsw-answer-bank-日期.json`
2. `python tsw_answer.py bank import --other tsw-answer-bank-日期.json`

原理：题干归一化（去题号、空白、标点、全半角）后取 FNV-1a 指纹做主键，
匹配不上时用二元组相似度兜底（阈值 0.82），所以同一道题排版微调也能命中。

---

## 常见问题

**Q：脚本能帮我"黑"进去拿到答案吗？**
不能，也不需要。答案本来就在页面下发给浏览器的数据里。脚本只读它，不发额外请求。

**Q：需要登录吗？**
需要。答题页 `/hw/stdAnswer/*` 未登录会 302 回首页，而且伪造 cookie 无效（服务端会话校验）。
所以脚本的定位是「登录之后帮你把页面已有的答案用起来」。

**Q：360 浏览器没反应？**
1. 先完全退出 360（含托盘图标），再 `launch`
2. 若还是不行，用油猴方式（方式 A），360 极速浏览器可直接装 Chrome 扩展

**Q：命中率不满 100？**
- 先看「来源」列：如果是 `题库`，说明页面这次没下发答案，用的是历史答案，注意核对
- 图片题、拖拽题、操作题没有文本答案，脚本天然覆盖不了
- 版式变了：`python tsw_answer.py diag --out diag.json`（或油猴面板点「诊断」），
  把 `diag.json` 里的 `questions[].controls / options` 发出来，改 `tsw_core.js` 里的
  `Q_SELECTORS`、`STEM_SELECTORS` 即可

**Q：会不会把成绩搞坏？**
交卷默认关闭，必须显式 `--submit`；有缺答案时还会再拦一次。自动交卷带 4 秒倒计时。
建议永远先 `--dry-run` / 「只扫描」确认命中率。

---

## 程序推演通道（v1.1.0）

「程序阅读题」的题干直接印着代码，答案是代码跑出来的结果。`tsw_vb.js` 是一个 VB6 子集解释器，
把这行代码真的执行一遍，再把输出（`Print` 的内容、`Text1.Text` 的赋值）和四个选项比对：

```text
阅读下面的程序，该程序运行后，文本框 Text1 中显示的内容是（　）
Private Sub Command1_Click() Dim s As Integer s = 0
For i = 1 To 3 s = s + i Next i Text1.Text = s End Sub
    A. 3   B. 6   C. 9   D. 0        → 推演 trace=6 → 选 B
```

- 支持：`Sub/End Sub`、`Dim`、`For…Next`（含 `Step`、`Exit For`）、`Do While/Until…Loop`、
  `While…Wend`、`If/ElseIf/Else`、`Print`、`Text1.Text`（含 `Val(Text1.Text)`、题干里「输入 "abc"」的预设值）、
  `&` 连接、`Mod`、`\` 整除、`And/Or/Not`、`Mid/Len/Left/Right/UCase/LCase/Trim/Str/Val/Chr/Asc` 等常用函数
- 页面取到题干时空白被压成一行，模块会按 VB 关键字重新断行（`Private Sub` / `Dim` / `For` / `Next` / `If` / `Print` …）
- 不认识的语法直接放弃（返回「无答案」），**绝不猜**：只认解释器真跑出来的输出
- 题库里已有这道题时依旧走 `bank`，推演只在没有答案时兜底

## 验证结果

服务端独立判分（`saveAnswers.do` 判分，不读前端标记），靶场复刻真实站点的 URL 与 DOM 类名：

| 路径 | 形态 | 答案来源 | 结果 |
| --- | --- | --- | --- |
| 油猴 | 接口带 `answer` | `page` | 12/12 → **60/60** |
| 油猴 | 交卷后看结果页 | `result-dom` | 采集 12 条入库 |
| 油猴 | 清空题库后再做 | `bank` | 12/12 → **60/60** |
| Python `run --url` | 接口带 `answer` | `page` | 12/12 → **60/60** |
| Python `run --reuse` | 接口不带答案 | `bank` | 12/12 → **60/60** |
| 油猴 + Python | 无 `<input>` 点击式选项 | `page` | 12/12 → **60/60** |
| 油猴 v1.1.0 | 靶场新增 2 道 VB 程序题，`noleak=1`（不下发答案） | `vb` | 2/2 → **10/70**（只有程序题可算） |
| 油猴 v1.1.0 | 题库 + 推演混合，`noleak=1` | `bank`+`vb` | 14/14 → **70/70** |
| Python v1.1.0 | `run --url` 打 `noleak=1` 页面 | `vb` | 第 13、14 题命中 B/B |

真实站点冒烟：在 `infotech.51taoshi.com` 注入油猴脚本，面板正常、零运行时报错。

---

## 本地靶场

没有真实账号也能验证整套流程：

```bash
cd mock
python lab_server.py 8899
```

| 地址 | 说明 |
| --- | --- |
| `http://127.0.0.1:8899/hw/stdAnswer/gotoAnswerPage.do` | 接口**带**答案（真实站点形态） |
| `http://127.0.0.1:8899/hw/stdAnswer/gotoAnswerPage.do?noleak=1` | 接口**不带**答案（验证题库） |
| `http://127.0.0.1:8899/hw/stdAnswer/gotoAnswerPage.do?click=1` | 无 input 的点击式选项 |
| `http://127.0.0.1:8899/hw/stdAnswer/gotoMyAnswerShow.do` | 作业结果页（显示正确答案） |

靶场路由与真实站点同名：`queryPaperQuestion.do` 拉题、`saveAnswers.do` 判分、`gotoMyAnswerShow.do` 看结果。

---

## 目录结构

```
.
├── 51taoshi-auto-answer.user.js   # ★ 油猴脚本（由 build.py 生成）
├── tsw_answer.py                  # ★ Python 3.6 本地脚本
├── tsw_core.js                    # 引擎（两个入口共用）
├── build.py                       # 组装油猴脚本
├── src/panel.js                   # 面板 UI 源码（被 build.py 拼进去）
├── mock/lab_server.py             # 离线靶场
├── docs/PRINCIPLE.md              # 原理与证据链
└── bank.json                      # 题库（运行时生成）
```

改了 `tsw_core.js` 或 `src/panel.js` 后重新生成油猴脚本：

```bash
python build.py           # 生成 51taoshi-auto-answer.user.js
python build.py --check   # 只检查
```

---

## 免责声明

仅供**个人学习与技术研究**。脚本读取的是你本就有权访问的页面数据，不做越权访问。
请在遵守学校规定的前提下使用；因使用本工具产生的任何后果由使用者自行承担。
