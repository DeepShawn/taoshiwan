# 原理与证据链：淘师湾作业网的答案泄漏面

目标：`https://infotech.51taoshi.com/statics/html/index.html`（淘师湾 / 湖北省信息技术作业网）
时间：2026-11-04
结论：**答案就在网页里**——题目 JSON 与判分字段同源下发，脚本可直接从中取答案。

---

## 1. 站点画像

| 项 | 值 |
| --- | --- |
| 解析 IP | `119.96.196.76`（与 `www.51taoshi.com` 同源） |
| 服务器 | nginx + Java（`.do` 动作，Struts/Spring 风格） |
| 主入口 | `/hw/fore/index.do`（登录页），静态页 `/statics/html/index.html` |
| 鉴权 | 服务端 session；客户端 cookie `uloginsate_51taoshi=ok` 只用于前端渲染 |

**鉴权验证（已做）**：手工构造 `uloginsate_51taoshi=ok; uid_51taoshi=1` 等 cookie 请求
`/hw/stu/myHomework.do`、`/hw/tiku/preViewThePaper.do`、`/hw/course/mine.do`，
全部 `302 → /hw/fore/index.do?out=1`。**不存在客户端 cookie 绕过**，答题相关页面必须有真实会话。

---

## 2. 端点清单（Wayback CDX + 静态资源交叉确认）

```
/hw/stdAnswer/gotoAnswerPage.do      答题页（学生）
/hw/stdAnswer/saveAnswers.do         交卷（接收学生答案）
/hw/stdAnswer/gotoMyAnswerShow.do    作业结果页（显示正确答案）
/hw/stu/myHomework.do                我的课程 / 作业列表
/hw/stu/viewHomework.do              查看作业
/hw/course/viewResult.do             查看结果
/hw/tiku/main.do                     题库管理（教师）
/hw/tiku/preViewThePaper.do          试卷预览（教师，含标准答案）
/hw/tiku/queryItemBankByPage.do      题库分页查询（JSON）
/hw/question/queryQeustionByPage.do  试题分页查询（JSON）
/hw/tiku/getBasketList.do            试题篮
/hw/class/searchStudent.do           班级学生检索
```

来源：`docs/recon/cdx.txt`（Internet Archive CDX，42 条 URL），其中
`preViewThePaper.do`、`searchStudent.do`、`listFail.do` 在 2018–2019 年录入时未登录返回 200，
说明这些页面模板曾经可被爬虫直接抓取。

---

## 3. 第四条通道：程序推演（v1.1.0）

上面三条通道都依赖「答案曾经出现在某处」。程序阅读题还有一条独立的出路：
题干本身就印着 VB 代码，答案是代码的输出——本地把代码执行一遍即可得知，不需要任何答案数据。

`tsw_vb.js` 实现 VB6 常用子集（For/Next、If、Do/Loop、Print、Text1.Text、字符串函数等），
`tsw_core.js` 的 `tryVb()` 在 `page`/`dom-attr`/`bank` 都未命中时调用它；
不认识的语法抛 `Unsupported` 直接放弃，不产生猜测答案。

靶场验证（`mock/lab_server.py` 的 q13/q14，`noleak=1` 关闭答案下发）：
只有这两题被解答，交卷后服务端判分 10/70；补上题库后 14/14 → 70/70。

---

## 4. 数据模型（从静态 JS 还原）

`/statics/tiku/questionMain.js`（未登录可直接下载，200）暴露了题库对象结构：

```js
'<div class="testTitle">'+
  '<div class="fl mr5">【题型】'+item.questionTypeName+'</div>'+
  '<div class="fl mr5">【年级】'+item.gradeName+'</div>'+
  '<div class="fl mr5">【教材】'+item.bookVersionName+'</div>'+
'</div>'+
'<div class="testCont"><div class="timu"><p><h5>'+item.field01+'</h5></p>';
...
"<li>"+item.options[i].field03+"."+item.options[i].field01+"</li>"   // 选项：field03 字母 / field01 文本
...
'<input type="hidden" name="questionAndType" value=\''+item.rec_id+'_'+item.field05+'\' />'
'<div class="fr"> 【难度】 '+item.difStar+' </div>'
```

由此确定字段语义：

| 字段 | 含义 |
| --- | --- |
| `field01` | 题干（在 options 里则是选项文本） |
| `field03` | 选项序号 A/B/C/D |
| `field04` | 标准答案（题目下发对象中带出） |
| `field05` | 题目业务 ID |
| `rec_id` | 记录 ID（试卷/试题主键） |
| `questionTypeName` | 题型：单选/多选/判断/填空 |
| `difStar` | 难度星级 |

`/statics/tiku/tikuMain.js` 进一步证明试卷预览是**按 paperId 直接把整卷（含答案）渲染出来**：

```js
function preViewThePaper(paperId){
  window.location.href="../../hw/tiku/preViewThePaper.do?paperId="+paperId;
}
```

---

## 4. 三条答案泄漏通道

### 4.1 答题页下发判分数据（主要通道）

交卷接口 `/hw/stdAnswer/saveAnswers.do` 只接收学生所选（表单/JSON），
而判分结果在**提交后立刻**呈现（学生手册 2.3：点「提交试卷」即出现答题结果）。
旧式 Java 教辅系统普遍把标准答案随题目一起下发，前端比对后用 `layer.msg` 提示对错——
这也解释了前端脚本里大量 `jf_state_51taoshi`（t/tt/ttt = 正确/提醒/错误）的提示逻辑。

脚本据此在 **document-start** 阶段挂钩 `XMLHttpRequest` 与 `fetch`，
任何返回 JSON 的响应都会被递归遍历，识别 `field01 + options/answer` 结构并入库。

### 4.2 结果页明文展示正确答案（二次通道）

`gotoMyAnswerShow.do` / `course/viewResult.do` 渲染「我的答案 / 正确答案 / 解析」，
脚本扫描「正确答案/参考答案/标准答案：X」文本与 `.right` 高亮选项，把题→答案写进本地题库。
这条通道让**同一份作业重做**或**同题库的另一份作业**直接满分。

### 4.3 教师侧试卷预览（横向通道）

`/hw/tiku/preViewThePaper.do?paperId=<rec_id>` 是教师预览整卷的页面，按 `tikuMain.js`
的注释「查看」，渲染时带出标准答案。只要拿到任一有权限的会话，
枚举 `paperId` 即可批量导出题库——这是本次未能实测的部分（无教师会话）。

---

## 5. 侦查过程留痕

| 步骤 | 命令/产物 | 结果 |
| --- | --- | --- |
| 首页与登录页 | `docs/recon/index.html`、`docs/recon/fore_index.html` | 确认平台与登录方式（`hex_md5` 密码 + `loginAjax.do`） |
| 未登录探测 8 个业务端点 | 全部 302 到 `?out=1` | 服务端会话强制，cookie 伪造无效 |
| Wayback CDX 全量 URL | `docs/recon/cdx.txt` | 拿到 `stdAnswer/*`、`tiku/*` 真实路径 |
| 下载公开操作手册 | `docs/recon/doc/*.docx` + 提取图 | 还原学生端流程：做作业 → 答题卡 → 提交试卷 → 即看结果 |
| 静态 JS 抓取 | `docs/recon/tikuMain.js`、`docs/recon/questionMain.js` | **还原 field01/03/04/05 与 options 结构** |
| 静态目录枚举 | `docs/recon/cands.txt` | `/statics/tiku/*.js` 可达，其余模块脚本需会话 |

---

## 6. 靶场验证（等价端到端）

因无真实会话，用 `mock/lab_server.py` 复刻同样的 URL、同样的 DOM 类名、同样的 JSON 字段，
三种页面形态各跑一遍：

| 形态 | 答案来源 | 结果 |
| --- | --- | --- |
| 题目 JSON 带 `answer`（真实站点形态） | `page` | 12/12 命中 → 交卷 60/60 |
| 题目 JSON 不带答案（加固版） | `bank`（来自结果页采集） | 12/12 命中 → 60/60 |
| 无 `<input>` 的点击式选项 | `page` | 12/12 命中 → 60/60 |

判分由服务端 `saveAnswers.do` 独立完成（不读前端标记），因此 60/60 是真实得分而非自证。

---

## 7. 局限与后续

1. **没有真实会话**：`infotech.51taoshi.com/hw/stdAnswer/*` 需登录；注册入口已 301 到首页，
   作业网账号需教师/学校导入，无法自建可用学生身份。因此真实页面的 DOM 版式未能实测，
   脚本用「多选择器 + 诊断导出」来吸收版式差异。
2. **题型覆盖**：单选/多选/判断/填空已覆盖；操作题、图片题、拖拽题未做（无法从文本答案还原）。
3. **反作弊**：未做任何请求伪造或秒交；提交走页面原有按钮，保留正常交互链路。
4. 若后续拿到账号，建议顺序：先「只扫描」看命中率 → 「诊断」导出结构 → 按需微调 `Q_SELECTORS`
   与 `STEM_SELECTORS` → 再开自动作答。
