#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
淘师湾作业网 · 离线靶场
复刻 infotech.51taoshi.com 的答题页/结果页结构，用于验证 userscript。

路由：
  GET  /hw/stdAnswer/gotoAnswerPage.do      答题页（题目由 AJAX 拉取）
  POST /hw/stdAnswer/queryPaperQuestion.do  题目 JSON（含正确答案——模拟前端泄漏）
  POST /hw/stdAnswer/saveAnswers.do         交卷，服务端判分
  GET  /hw/stdAnswer/gotoMyAnswerShow.do    结果页（显示正确答案，供题库采集）
  GET  /tsw.user.js                         userscript 本体（热加载）

查询参数：
  noleak=1   题目 JSON 不含答案字段（模拟“修补后”的页面，用于验证本地题库
             与程序推演通道：q13/q14 是带 VB 代码的题，只能靠推演算出来）
  click=1    选项用可点击 li 渲染（无 input，验证点击式作答）

启动：
  python lab_server.py 8899
然后浏览器打开 http://127.0.0.1:8899/
"""
import html as _html
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
try:                                     # Python 3.7+
    from http.server import ThreadingHTTPServer
except ImportError:                      # Python 3.6 兼容
    import socketserver

    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True

ROOT = os.path.dirname(os.path.abspath(__file__))
USCRIPT = os.path.join(os.path.dirname(ROOT), "51taoshi-auto-answer.user.js")

# ---------------------------------------------------------------- 题库（12 题）
QUESTIONS = [
    dict(id="q1", type="单选题", stem="在Python中，用于表示“并且”的逻辑运算符是（　）",
         options=[("A", "and"), ("B", "or"), ("C", "not"), ("D", "xor")], answer="A"),
    dict(id="q2", type="单选题", stem="下列存储容量单位中，最大的是（　）",
         options=[("A", "KB"), ("B", "MB"), ("C", "GB"), ("D", "TB")], answer="D"),
    dict(id="q3", type="单选题", stem="HTML中用于插入图片的标签是（　）",
         options=[("A", "<a>"), ("B", "<img>"), ("C", "<p>"), ("D", "<div>")], answer="B"),
    dict(id="q4", type="单选题", stem="在Excel中，求一组数据平均值的函数是（　）",
         options=[("A", "SUM"), ("B", "COUNT"), ("C", "AVERAGE"), ("D", "MAX")], answer="C"),
    dict(id="q5", type="单选题", stem="IPv4地址由多少位二进制数组成（　）",
         options=[("A", "8位"), ("B", "16位"), ("C", "32位"), ("D", "64位")], answer="C"),
    dict(id="q6", type="单选题", stem="下列属于计算机输入设备的是（　）",
         options=[("A", "显示器"), ("B", "打印机"), ("C", "扫描仪"), ("D", "音箱")], answer="C"),
    dict(id="q7", type="多选题", stem="下列属于图像文件格式的有（　）",
         options=[("A", "JPG"), ("B", "PNG"), ("C", "GIF"), ("D", "DOCX")], answer="ABC"),
    dict(id="q8", type="多选题", stem="关于信息安全，下列说法正确的有（　）",
         options=[("A", "定期更换密码"), ("B", "把密码告诉同学"), ("C", "安装杀毒软件"),
                  ("D", "不使用来源不明的U盘")], answer="ACD"),
    dict(id="q9", type="判断题", stem="计算机中1GB等于1024MB。",
         options=[("A", "正确"), ("B", "错误")], answer="A"),
    dict(id="q10", type="判断题", stem="算法必须在有限步骤内结束，这是算法的有穷性。",
         options=[("A", "正确"), ("B", "错误")], answer="A"),
    dict(id="q11", type="填空题", stem="计算机的中央处理器英文缩写是＿＿＿＿。",
         options=[], answer="CPU"),
    dict(id="q12", type="填空题", stem="在网络中，把域名转换为IP地址的服务称为＿＿＿＿。",
         options=[], answer="DNS"),
    # 以下两题模拟“程序阅读题”：题干里带 VB 代码，答案只能靠推演得出
    # （noleak=1 时页面不下发答案，用来验证 tsw_vb.js 的程序推演通道）
    dict(id="q13", type="单选题",
         stem="阅读下面的程序，该程序运行后，文本框 Text1 中显示的内容是（　）"
              "Private Sub Command1_Click() Dim s As Integer s = 0 "
              "For i = 1 To 3 s = s + i Next i Text1.Text = s End Sub",
         options=[("A", "3"), ("B", "6"), ("C", "9"), ("D", "0")], answer="B"),
    dict(id="q14", type="单选题",
         stem="以下程序运行时，在文本框 Text1 中输入 6，输出的结果是（　）"
              "Private Sub Command1_Click() Dim n As Integer n = Val(Text1.Text) "
              "If n Mod 2 = 0 Then Print \"偶数\" Else Print \"奇数\" End If End Sub",
         options=[("A", "6"), ("B", "偶数"), ("C", "奇数"), ("D", "0")], answer="B"),
]

ANSWERS = {q["id"]: q["answer"] for q in QUESTIONS}


def question_payload(with_answer: bool):
    rows = []
    for i, q in enumerate(QUESTIONS, 1):
        row = {
            "field05": q["id"],
            "field01": _html.escape(q["stem"]),
            "questionTypeName": q["type"],
            "field06": 5,
            "options": [
                {"field03": k, "field01": _html.escape(t)} for k, t in q["options"]
            ],
        }
        if with_answer:
            # 老系统把判分所需的标准答案一并下发到浏览器
            row["answer"] = q["answer"]
            row["field04"] = q["answer"]
        rows.append(row)
    return {"total": len(rows), "rows": rows}


PAGE_HEAD = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>做作业 · 淘师湾作业网</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif;background:#f3f5f7;color:#333}
.top{background:#1aa3e8;color:#fff;padding:12px 24px;font-size:15px}
.top b{font-size:16px;margin-right:20px}
.wrap{max-width:900px;margin:16px auto;padding:0 16px 60px}
.course{background:#fff;border:1px solid #e3e7ea;border-radius:4px;padding:14px 18px;margin-bottom:14px}
.course h3{margin:0 0 6px;font-size:16px}
.course p{margin:0;color:#7b8b85;font-size:12px}
.testCont{background:#fff;border:1px solid #e3e7ea;border-radius:4px;padding:18px 20px;margin-bottom:12px}
.testTitle{color:#7b8b85;font-size:12px;border-bottom:1px dashed #e3e7ea;padding-bottom:8px;margin-bottom:12px}
.testTitle div{display:inline-block;margin-right:14px}
.timu h5{margin:0 0 10px;font-size:15px;font-weight:600;line-height:1.8}
.choose-list{list-style:none;margin:0;padding:0}
.choose-list li{margin:6px 0;padding:6px 10px;border:1px solid #eef1f3;border-radius:4px;cursor:pointer}
.choose-list li:hover{background:#f5fbff;border-color:#bfe0f5}
.choose-list li input{margin-right:8px}
.fillbox input{width:100%;max-width:420px;padding:8px 10px;border:1px solid #ccd6dd;border-radius:4px}
.answerCard{background:#fff;border:1px solid #e3e7ea;border-radius:4px;padding:14px 18px;position:sticky;bottom:0}
.answerCard b{display:block;margin-bottom:8px}
.answerCard .nums span{display:inline-block;width:30px;height:30px;line-height:28px;text-align:center;
  border:1px solid #ccd6dd;border-radius:4px;margin:0 6px 6px 0;font-size:12px;color:#666;cursor:pointer}
.answerCard .nums span.done{background:#e8f7ee;border-color:#7cc79a;color:#1f7a45}
.btn{display:inline-block;padding:9px 26px;border-radius:4px;border:0;background:#1aa3e8;color:#fff;
  font-size:14px;cursor:pointer;margin-top:10px}
.btn:hover{background:#148fcb}
.btn.g{background:#2ea44f}
.result{background:#fff;border:1px solid #e3e7ea;border-radius:4px;padding:20px}
.score{font-size:30px;color:#2ea44f;font-weight:700}
.qline{border-bottom:1px dashed #eef1f3;padding:12px 0}
.qline .stem{font-weight:600;margin-bottom:6px}
.qline .my,.qline .right{font-size:13px}
.right{color:#2ea44f}
.wrong{color:#c0392b}
</style>
<!-- 靶场：模拟 Tampermonkey @run-at document-start 注入，必须早于页面脚本 -->
<script src="/tsw.user.js"></script>
</head><body>
<div class="top"><b>淘师湾作业网</b> 我的课程 / 做作业</div>
<div class="wrap">
"""

PAGE_FOOT = """</div>
</body></html>"""

ANSWER_PAGE = PAGE_HEAD + """
<div class="course">
  <h3 id="cw">测试20261104</h3>
  <p>上课时间：2026/11/04(星期三) · 上课班级：2026级1班 · 授课老师：王老师</p>
</div>
<div id="paper">正在加载试卷…</div>
<div class="answerCard">
  <b>答题卡</b>
  <div class="nums" id="cardNums"></div>
  <button class="btn g" onclick="submitPaper()">提交试卷</button>
  <span id="tip" style="color:#7b8b85;font-size:12px;margin-left:12px"></span>
</div>
<script>
var PAPER = null;
function loadPaper(){
  var xhr = new XMLHttpRequest();
  xhr.open('POST','queryPaperQuestion.do',true);
  xhr.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
  xhr.onload = function(){
    if(xhr.status===200){ PAPER = JSON.parse(xhr.responseText); renderPaper(PAPER); }
  };
  xhr.send('paperId=20261104001&courseId=8891&noleak=' + (location.search.indexOf('noleak=1') >= 0 ? 1 : 0));
}
function renderPaper(data){
  var html = '';
  data.rows.forEach(function(q,i){
    html += '<div class="testCont" data-questionid="'+q.field05+'" data-type="'+q.questionTypeName+'">';
    html += '<div class="testTitle"><div>【题型】'+q.questionTypeName+'</div><div>【分值】'+(q.field06||5)+'</div></div>';
    html += '<div class="timu"><h5>'+(i+1)+'. '+q.field01+'</h5>';
    var clickMode = location.search.indexOf('click=1') >= 0;
    if(q.options && q.options.length && clickMode){
      html += '<ul class="choose-list">';
      var multi = q.questionTypeName.indexOf('多选')>=0;
      q.options.forEach(function(o){
        html += '<li class="opt" data-key="'+o.field03+'" data-q="'+q.field05+'" data-multi="'+(multi?1:0)+'">'+
                o.field03+'. '+o.field01+'</li>';
      });
      html += '</ul>';
    } else if(q.options && q.options.length){
      html += '<ul class="choose-list">';
      var inputType = q.questionTypeName.indexOf('多选')>=0 ? 'checkbox' : 'radio';
      q.options.forEach(function(o){
        html += '<li><label><input type="'+inputType+'" name="'+q.field05+'" value="'+o.field03+'">'+
                o.field03+'. '+o.field01+'</label></li>';
      });
      html += '</ul>';
    } else {
      html += '<div class="fillbox"><input type="text" name="'+q.field05+'" placeholder="请填写答案"></div>';
    }
    html += '</div></div>';
  });
  document.getElementById('paper').innerHTML = html;
  var nums='';
  data.rows.forEach(function(q,i){ nums += '<span data-n="'+q.field05+'">'+(i+1)+'</span>'; });
  document.getElementById('cardNums').innerHTML = nums;
  document.querySelectorAll('#cardNums span').forEach(function(s){
    s.onclick = function(){ var t=document.querySelector('[data-questionid="'+s.dataset.n+'"]');
      if(t) t.scrollIntoView({behavior:'smooth',block:'center'}); };
  });
  document.addEventListener('change', markDone);
  document.addEventListener('input', markDone);
  document.addEventListener('click', function(e){
    var li = e.target.closest && e.target.closest('li.opt'); if(!li) return;
    if(li.dataset.multi !== '1'){
      li.parentNode.querySelectorAll('li.opt').forEach(function(x){ x.classList.remove('on'); });
    }
    li.classList.toggle('on');
    markDone({target: li});
  });
}
function markDone(e){
  var box = e.target.closest('[data-questionid]'); if(!box) return;
  var done = false;
  box.querySelectorAll('input').forEach(function(i){
    if(i.type==='radio'||i.type==='checkbox'){ if(i.checked) done=true; }
    else if(i.value.trim()) done=true;
  });
  if(box.querySelector('li.opt.on')) done = true;
  var s = document.querySelector('#cardNums span[data-n="'+box.dataset.questionid+'"]');
  if(s) s.classList.toggle('done', done);
}
function collect(){
  var out = {};
  document.querySelectorAll('[data-questionid]').forEach(function(box){
    var id = box.dataset.questionid, vals=[];
    box.querySelectorAll('input').forEach(function(i){
      if(i.type==='radio'||i.type==='checkbox'){ if(i.checked) vals.push(i.value); }
      else if(i.value.trim()) vals.push(i.value.trim());
    });
    box.querySelectorAll('li.opt.on').forEach(function(li){ vals.push(li.dataset.key); });
    out[id] = vals.join('');
  });
  return out;
}
function submitPaper(){
  var ans = collect();
  var xhr = new XMLHttpRequest();
  xhr.open('POST','saveAnswers.do',true);
  xhr.setRequestHeader('Content-Type','application/json');
  xhr.onload = function(){
    if(xhr.status===200){ localStorage.setItem('lastResult', xhr.responseText); location.href='gotoMyAnswerShow.do'; }
  };
  xhr.send(JSON.stringify({paperId:20261104001, answers: ans}));
}
loadPaper();
</script>
""" + PAGE_FOOT

RESULT_HEAD = PAGE_HEAD + """
<div class="course"><h3>作业结果</h3><p>测试20261104 · 2026级1班</p></div>
<div class="result" id="result">加载中…</div>
<script>
var raw = localStorage.getItem('lastResult');
if(raw){
  var r = JSON.parse(raw);
  var html = '<div class="score">'+r.score+' / '+r.total+' 分</div><p style="color:#7b8b85">得分率 '+
             (Math.round(r.score/r.total*1000)/10)+'%</p>';
  r.detail.forEach(function(d){
    html += '<div class="qline"><div class="stem">'+d.no+'. '+d.stem+'</div>';
    html += '<div class="my">我的答案：<span class="'+(d.ok?'right':'wrong')+'">'+(d.my||'（未作答）')+'</span></div>';
    html += '<div class="right">正确答案：'+d.right+'</div>';
    html += '<div style="color:#7b8b85;font-size:12px">解析：'+d.explain+'</div></div>';
  });
  document.getElementById('result').innerHTML = html;
} else {
  document.getElementById('result').innerHTML = '<p>没有找到本次作业记录。</p>';
}
</script>
""" + PAGE_FOOT


class Handler(BaseHTTPRequestHandler):
    server_version = "TSWLab/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[lab] %s\n" % (fmt % args))

    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == "/hw/stdAnswer/gotoAnswerPage.do":
            return self._send(200, ANSWER_PAGE)
        if u.path == "/hw/stdAnswer/gotoMyAnswerShow.do":
            return self._send(200, RESULT_HEAD)
        if u.path == "/tsw.user.js":
            with open(USCRIPT, "rb") as f:
                return self._send(200, f.read(), "application/javascript; charset=utf-8")
        if u.path in ("/", "/hw/stu/myHomework.do", "/hw/course/mine.do"):
            return self._send(200, PAGE_HEAD + """
<div class="course"><h3>我的课程</h3><p>测试用课程列表</p></div>
<div class="testCont"><ul class="choose-list">
<li><a href="/hw/stdAnswer/gotoAnswerPage.do">测试20261104（含答案下发）</a></li>
<li><a href="/hw/stdAnswer/gotoAnswerPage.do?noleak=1">测试20261104·加固版（不下发答案）</a></li>
<li><a href="/hw/stdAnswer/gotoMyAnswerShow.do">上次作业结果</a></li>
</ul></div>""" + PAGE_FOOT)
        return self._send(404, "<h3>404</h3>")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if u.path == "/hw/stdAnswer/queryPaperQuestion.do":
            form = urllib.parse.parse_qs(body.decode("utf-8", "ignore"))
            noleak = form.get("noleak", ["0"])[0] == "1"
            payload = question_payload(with_answer=not noleak)
            return self._send(200, json.dumps(payload, ensure_ascii=False),
                              "application/json; charset=utf-8")
        if u.path == "/hw/stdAnswer/saveAnswers.do":
            try:
                data = json.loads(body.decode("utf-8", "ignore") or "{}")
            except Exception:
                data = {}
            ans = data.get("answers", {})
            detail, score, total = [], 0, 0
            for i, q in enumerate(QUESTIONS, 1):
                total += 5
                my = str(ans.get(q["id"], "")).strip()
                right = q["answer"]
                ok = my.upper().replace(" ", "") == right.upper()
                if ok:
                    score += 5
                detail.append(dict(no=i, id=q["id"], stem=q["stem"], my=my, right=right,
                                   ok=ok, explain="标准答案：" + right))
            payload = dict(score=score, total=total, detail=detail)
            return self._send(200, json.dumps(payload, ensure_ascii=False),
                              "application/json; charset=utf-8")
        return self._send(404, "<h3>404</h3>")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print("淘师湾离线靶场: http://127.0.0.1:%d/" % port)
    print("  答题页(有答案下发): http://127.0.0.1:%d/hw/stdAnswer/gotoAnswerPage.do" % port)
    print("  答题页(无答案下发): http://127.0.0.1:%d/hw/stdAnswer/gotoAnswerPage.do?noleak=1" % port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
