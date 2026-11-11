// ==UserScript==
// @name         淘师湾作业网 · 答案提取与自动答题
// @namespace    https://infotech.51taoshi.com/
// @version      1.1.0
// @description  面向淘师湾/湖北省信息技术作业网作业页：抓取页面自身下发的试卷数据取出标准答案，建本地题库，并用内置 VB 解释器推演程序阅读题，一键填涂与交卷。
// @author       DeepShawn
// @homepageURL  https://github.com/DeepShawn/taoshiwan
// @supportURL   https://github.com/DeepShawn/taoshiwan/issues
// @downloadURL  https://raw.githubusercontent.com/DeepShawn/taoshiwan/main/51taoshi-auto-answer.user.js
// @updateURL    https://raw.githubusercontent.com/DeepShawn/taoshiwan/main/51taoshi-auto-answer.user.js
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

/* 构建信息：2026-11-12 00:13:35
 * 本文件由 build.py 生成，请勿直接编辑。
 * 源码：tsw_vb.js（程序推演） + tsw_core.js（引擎） + src/panel.js（界面）
 */

/* tsw_vb.js —— VB6 子集解释器（程序推演通道）
 * 被 tsw_core.js 的 tryVb() 调用：题目里带 VB 代码时直接算出输出，再匹配选项。
 * 由 build.py 打包进油猴脚本；tsw_answer.py 注入页面时与本文件一起注入。
 *
 * 语法覆盖：Sub/End Sub、Dim、For…Next（含 Step、Exit For）、Do…Loop（前/后置条件）、
 * While…Wend、If/ElseIf/Else/End If（含单行）、Print、赋值、Text1.Text 输出，
 * 运算符：& 连接、+ - * / \ Mod ^、比较、And/Or/Not、常用内建函数。
 * 任何不认识的语句都抛 Unsupported，由上层退回其它解法。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Vb = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function Unsupported(msg) { var e = new Error(msg); e.name = 'Unsupported'; return e; }

  var MAX_STEPS = 400000;

  // ---------- 词法 ----------
  var OPS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '\\', '^', '&', ',', ';', '(', ')', ':', '.'];
  var KW = {};

  function tokenize(line) {
    var toks = [], i = 0, n = line.length;
    while (i < n) {
      var c = line[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '"') {                       // VB 字符串："" 转义
        var s = '', j = i + 1;
        while (j < n) {
          if (line[j] === '"') {
            if (line[j + 1] === '"') { s += '"'; j += 2; continue; }
            break;
          }
          s += line[j++];
        }
        toks.push({ k: 'str', v: s }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] || ''))) {
        var m = /^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(line.slice(i));
        toks.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
      }
      if (/[A-Za-z_\u4e00-\u9fff]/.test(c)) {
        var id = /^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*/.exec(line.slice(i))[0];
        toks.push({ k: 'id', v: id }); i += id.length; continue;
      }
      var op = null;
      for (var k = 0; k < OPS.length; k++) if (line.startsWith(OPS[k], i)) { op = OPS[k]; break; }
      if (!op) throw Unsupported('无法识别字符: ' + c + ' @ ' + line);
      toks.push({ k: 'op', v: op }); i += op.length;
    }
    return toks;
  }

  function low(t) { return t && t.k === 'id' ? t.v.toLowerCase() : null; }
  function isOp(t, v) { return t && t.k === 'op' && t.v === v; }

  // ---------- 表达式 ----------
  function Parser(toks) { this.t = toks; this.i = 0; }
  Parser.prototype.peek = function () { return this.t[this.i]; };
  Parser.prototype.eat = function () { return this.t[this.i++]; };
  Parser.prototype.expect = function (v) {
    var t = this.eat();
    if (!isOp(t, v)) throw Unsupported('期望 ' + v + '，实际 ' + (t ? t.v : 'EOF'));
  };
  Parser.prototype.atEnd = function () { return this.i >= this.t.length; };

  Parser.prototype.parseExpr = function () { return this.parseOr(); };
  Parser.prototype.parseOr = function () {
    var l = this.parseAnd();
    while (low(this.peek()) === 'or') { this.eat(); l = ['bin', 'or', l, this.parseAnd()]; }
    return l;
  };
  Parser.prototype.parseAnd = function () {
    var l = this.parseNot();
    while (low(this.peek()) === 'and') { this.eat(); l = ['bin', 'and', l, this.parseNot()]; }
    return l;
  };
  Parser.prototype.parseNot = function () {
    if (low(this.peek()) === 'not') { this.eat(); return ['un', 'not', this.parseNot()]; }
    return this.parseCmp();
  };
  Parser.prototype.parseCmp = function () {
    var l = this.parseConcat();
    for (;;) {
      var t = this.peek();
      if (!t || t.k !== 'op' || ['=', '<>', '<', '>', '<=', '>='].indexOf(t.v) < 0) break;
      this.eat();
      l = ['bin', t.v, l, this.parseConcat()];
    }
    return l;
  };
  Parser.prototype.parseConcat = function () {
    var l = this.parseAdd();
    while (isOp(this.peek(), '&')) { this.eat(); l = ['bin', '&', l, this.parseAdd()]; }
    return l;
  };
  Parser.prototype.parseAdd = function () {
    var l = this.parseMul();
    for (;;) {
      var t = this.peek();
      if (!t || t.k !== 'op' || (t.v !== '+' && t.v !== '-')) break;
      this.eat(); l = ['bin', t.v, l, this.parseMul()];
    }
    return l;
  };
  Parser.prototype.parseMul = function () {
    var l = this.parseIntDiv();
    for (;;) {
      var t = this.peek();
      if (!t || t.k !== 'op' || (t.v !== '*' && t.v !== '/')) break;
      this.eat(); l = ['bin', t.v, l, this.parseIntDiv()];
    }
    return l;
  };
  Parser.prototype.parseIntDiv = function () {
    var l = this.parseMod();
    while (isOp(this.peek(), '\\')) { this.eat(); l = ['bin', '\\', l, this.parseMod()]; }
    return l;
  };
  Parser.prototype.parseMod = function () {
    var l = this.parsePow();
    while (low(this.peek()) === 'mod') { this.eat(); l = ['bin', 'mod', l, this.parsePow()]; }
    return l;
  };
  Parser.prototype.parsePow = function () {
    var l = this.parseUnary();
    while (isOp(this.peek(), '^')) { this.eat(); l = ['bin', '^', l, this.parseUnary()]; }
    return l;
  };
  Parser.prototype.parseUnary = function () {
    if (isOp(this.peek(), '-')) { this.eat(); return ['un', '-', this.parseUnary()]; }
    if (isOp(this.peek(), '+')) { this.eat(); return this.parseUnary(); }
    return this.parsePrimary();
  };
  Parser.prototype.parsePrimary = function () {
    var t = this.eat();
    if (!t) throw Unsupported('表达式不完整');
    if (t.k === 'num') return ['num', t.v];
    if (t.k === 'str') return ['str', t.v];
    if (isOp(t, '(')) { var e = this.parseExpr(); this.expect(')'); return e; }
    if (t.k === 'id') {
      var name = t.v;
      if (isOp(this.peek(), '(')) {                    // 函数调用
        this.eat();
        var args = [];
        if (!isOp(this.peek(), ')')) {
          args.push(this.parseExpr());
          while (isOp(this.peek(), ',')) { this.eat(); args.push(this.parseExpr()); }
        }
        this.expect(')');
        return ['call', name, args];
      }
      if (isOp(this.peek(), '.') || (this.peek() && this.peek().k === 'id' && false)) {
        // 成员：Text1.Text / a.b
        var parts = [name];
        while (this.peek() && (this.peek().k === 'id' ? false : false)) break;
        // 处理 a.b.c：句点后可能紧跟标识符
        while (this.peek() && this.peek().k === 'id' && false) break;
        return ['var', parts.join('.')];
      }
      return ['var', name];
    }
    throw Unsupported('无法解析: ' + t.v);
  };

  // 处理 对象.属性（Text1.Text）：tokenize 后是 id '.' id
  function fixDots(toks) {
    var out = [], i = 0;
    while (i < toks.length) {
      if (toks[i].k === 'id' && i + 2 < toks.length && toks[i + 1].k === 'op' && toks[i + 1].v === '.' && toks[i + 2].k === 'id') {
        var name = toks[i].v + '.' + toks[i + 2].v; i += 3;
        while (i + 1 < toks.length && toks[i].k === 'op' && toks[i].v === '.' && toks[i + 1].k === 'id') {
          name += '.' + toks[i + 1].v; i += 2;
        }
        out.push({ k: 'id', v: name }); continue;
      }
      out.push(toks[i]); i++;
    }
    return out;
  }

  function parseExprSrc(src) {
    var p = new Parser(fixDots(tokenize(src)));
    var e = p.parseExpr();
    return e;
  }

  // ---------- 语句（按行） ----------
  function splitLines(code) {
    var lines = String(code).replace(/\r/g, '').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s || s.startsWith("'") || /^rem\b/i.test(s)) continue;
      out.push(s);
    }
    return out;
  }

  function stripComment(s) { return s; }   // 行首注释已过滤；行内 ' 视为字符串外注释
  function stripInlineComment(s) {
    var inStr = false;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '"') inStr = !inStr;
      else if (!inStr && s[i] === "'") return s.slice(0, i);
    }
    return s;
  }

  // Block parser: returns [nodes, nextIndex]
  function parseBlock(lines, i, stops) {
    var nodes = [];
    while (i < lines.length) {
      var line = stripInlineComment(lines[i]).trim();
      if (!line) { i++; continue; }
      var kw = (line.match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
      if (stops.indexOf(kw) >= 0) return [nodes, i];
      var r = parseStmt(lines, i);
      nodes.push(r[0]); i = r[1];
    }
    return [nodes, i];
  }

  function parseStmt(lines, i) {
    var raw = stripInlineComment(lines[i]).trim();
    var kw = (raw.match(/^[A-Za-z]+/) || [''])[0].toLowerCase();

    if (kw === 'dim' || kw === 'static' || kw === 'const') {
      var body = raw.replace(/^(dim|static|const)\s+/i, '');
      var names = [];
      body.split(',').forEach(function (part) {
        var nm = part.trim().split(/\s+as\s+/i)[0].trim().replace(/\(.*\)$/, '');
        if (nm) names.push(nm.replace(/^\$/, ''));
      });
      return [['dim', names], i + 1];
    }

    if (kw === 'print') {
      var rest = raw.replace(/^print\s*/i, '');
      var args = [], seps = [];
      // 按顶层 ; / , 切分
      var depth = 0, cur = '', inStr = false;
      for (var p = 0; p < rest.length; p++) {
        var ch = rest[p];
        if (ch === '"') inStr = !inStr;
        if (!inStr && ch === '(') depth++;
        if (!inStr && ch === ')') depth--;
        if (!inStr && depth === 0 && (ch === ';' || ch === ',')) {
          args.push(cur.trim()); seps.push(ch); cur = '';
        } else cur += ch;
      }
      if (cur.trim()) args.push(cur.trim());
      return [['print', args, seps], i + 1];
    }

    if (kw === 'for') {
      var m = /^for\s+([A-Za-z_][\w]*)\s*=\s*(.+?)\s+to\s+(.+?)(?:\s+step\s+(.+))?$/i.exec(raw);
      if (!m) throw Unsupported('无法解析 For: ' + raw);
      var body = [], j = i + 1;
      var r = parseBlock(lines, j, ['next']);
      body = r[0]; j = r[1];
      if (j < lines.length && /^next\b/i.test(lines[j].trim())) j++;
      return [['for', m[1], parseExprSrc(m[2]), parseExprSrc(m[3]), m[4] ? parseExprSrc(m[4]) : null, body], j];
    }

    if (kw === 'do') {
      var head = raw.replace(/^do\s*/i, '').trim();
      var preKind = null, preCond = null;
      var hm = /^(while|until)\s+(.+)$/i.exec(head);
      if (hm) { preKind = hm[1].toLowerCase(); preCond = parseExprSrc(hm[2]); }
      var r2 = parseBlock(lines, i + 1, ['loop']);
      var body2 = r2[0], j2 = r2[1];
      var postKind = null, postCond = null;
      if (j2 < lines.length) {
        var lp = lines[j2].trim().replace(/^loop\s*/i, '').trim();
        var lm = /^(while|until)\s+(.+)$/i.exec(lp);
        if (lm) { postKind = lm[1].toLowerCase(); postCond = parseExprSrc(lm[2]); }
        j2++;
      }
      return [['do', preKind, preCond, postKind, postCond, body2], j2];
    }

    if (kw === 'while') {
      var cond = parseExprSrc(raw.replace(/^while\s+/i, ''));
      var r3 = parseBlock(lines, i + 1, ['wend']);
      var j3 = r3[1];
      if (j3 < lines.length) j3++;
      return [['while', cond, r3[0]], j3];
    }

    if (kw === 'if') {
      return parseIf(lines, i, raw);
    }

    if (kw === 'exit') {
      var what = (raw.split(/\s+/)[1] || '').toLowerCase();
      return [['exit', what], i + 1];
    }

    if (kw === 'end' && /^end\s+sub$/i.test(raw)) return [['noop'], i];

    // 赋值：a = expr / a.b = expr
    var am = /^([A-Za-z_\u4e00-\u9fff][\w.\[\]]*)\s*=\s*(.+)$/.exec(raw);
    if (am) {
      return [['assign', am[1], parseExprSrc(am[2])], i + 1];
    }
    // 过程调用语句：Command1_Click / Call foo
    if (/^[A-Za-z_][\w.]*$/.test(raw) || /^call\s+/i.test(raw)) return [['noop'], i + 1];
    throw Unsupported('不支持的语句: ' + raw);
  }

  function parseIf(lines, i, raw) {
    var rest = raw.replace(/^if\s+/i, '');
    var tm = /^(.*?)\s+then\s*(.*)$/i.exec(rest);
    if (!tm) throw Unsupported('无法解析 If: ' + raw);
    var cond = parseExprSrc(tm[1]);
    var tail = tm[2].trim();
    if (tail) {                                    // 单行 If x Then stmt
      var sub = parseStmt([tail], 0);
      return [['if', [[cond, [sub[0]]]], []], i + 1];
    }
    var branches = [], elseBody = [];
    var r = parseBlock(lines, i + 1, ['elseif', 'else', 'end']);
    branches.push([cond, r[0]]);
    var j = r[1];
    for (;;) {
      if (j >= lines.length) break;
      var line = lines[j].trim();
      var lk = (line.match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
      if (lk === 'elseif') {
        var cr = /^elseif\s+(.*?)\s+then\s*$/i.exec(line);
        if (!cr) throw Unsupported('无法解析 ElseIf: ' + line);
        var rr = parseBlock(lines, j + 1, ['elseif', 'else', 'end']);
        branches.push([parseExprSrc(cr[1]), rr[0]]);
        j = rr[1]; continue;
      }
      if (lk === 'else') {
        var re = parseBlock(lines, j + 1, ['end']);
        elseBody = re[0]; j = re[1]; continue;
      }
      if (lk === 'end') { j++; break; }
      j++;
    }
    return [['if', branches, elseBody], j];
  }

  // ---------- 求值 ----------
  function Interp() {
    this.vars = {};
    this.printed = [];
    this.steps = 0;
    this.exitFor = false;
    this.exitDo = false;
  }
  Interp.prototype.truth = function (v) {
    if (v === true) return true;
    if (v === false) return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    return Boolean(v);
  };
  Interp.prototype.num = function (v) {
    if (typeof v === 'number') return v;
    if (v === true) return -1;
    if (v === false) return 0;
    var s = String(v).trim();
    if (!s) return 0;
    var n = parseFloat(s);
    if (isNaN(n)) throw Unsupported('不能转成数字: ' + v);
    return n;
  };
  Interp.prototype.str = function (v) {
    if (typeof v === 'string') return v;
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (Number.isInteger(v)) return String(v);
    return String(v);
  };

  Interp.prototype.ev = function (node) {
    switch (node[0]) {
      case 'num': return node[1];
      case 'str': return node[1];
      case 'var': return this.getVar(node[1]);
      case 'un':
        if (node[1] === '-') return -this.num(this.ev(node[2]));
        if (node[1] === 'not') return this.truth(this.ev(node[2])) ? 0 : -1;
        throw Unsupported('未知一元运算');
      case 'bin': return this.binop(node[1], node[2], node[3]);
      case 'call': return this.callFn(node[1], node[2]);
      default: throw Unsupported('未知表达式节点 ' + node[0]);
    }
  };

  Interp.prototype.getVar = function (name) {
    var key = name.toLowerCase();
    if (key in this.vars) return this.vars[key];
    if (key === 'true') return true;
    if (key === 'false') return false;
    if (key === 'text1' || key === 'text1.text' || key === 'text1.text.value') return this.vars['text1.text'] || '';
    return 0;
  };

  Interp.prototype.binop = function (op, a, b) {
    var x, y;
    switch (op) {
      case '&': return this.str(this.ev(a)) + this.str(this.ev(b));
      case '+':
        x = this.ev(a); y = this.ev(b);
        if (typeof x === 'string' || typeof y === 'string') return this.str(x) + this.str(y);
        return this.num(x) + this.num(y);
      case '-': return this.num(this.ev(a)) - this.num(this.ev(b));
      case '*': return this.num(this.ev(a)) * this.num(this.ev(b));
      case '/': return this.num(this.ev(a)) / this.num(this.ev(b));
      case '\\': return Math.trunc(this.num(this.ev(a)) / this.num(this.ev(b)));
      case 'mod':
        x = Math.trunc(this.num(this.ev(a))); y = Math.trunc(this.num(this.ev(b)));
        return x % y;
      case '^': return Math.pow(this.num(this.ev(a)), this.num(this.ev(b)));
      case '=': return this.cmp(this.ev(a), this.ev(b), function (c) { return c === 0; });
      case '<>': return this.cmp(this.ev(a), this.ev(b), function (c) { return c !== 0; });
      case '<': return this.cmp(this.ev(a), this.ev(b), function (c) { return c < 0; });
      case '>': return this.cmp(this.ev(a), this.ev(b), function (c) { return c > 0; });
      case '<=': return this.cmp(this.ev(a), this.ev(b), function (c) { return c <= 0; });
      case '>=': return this.cmp(this.ev(a), this.ev(b), function (c) { return c >= 0; });
      case 'and':
        return (this.truth(this.ev(a)) && this.truth(this.ev(b))) ? -1 : 0;
      case 'or':
        return (this.truth(this.ev(a)) || this.truth(this.ev(b))) ? -1 : 0;
      default: throw Unsupported('未知运算符 ' + op);
    }
  };

  Interp.prototype.cmp = function (a, b, f) {
    if (typeof a === 'string' || typeof b === 'string') {
      var s1 = this.str(a), s2 = this.str(b);
      if (s1 === s2) return f(0);
      return f(s1 < s2 ? -1 : 1);
    }
    var n1 = this.num(a), n2 = this.num(b);
    return f(n1 === n2 ? 0 : (n1 < n2 ? -1 : 1));
  };

  Interp.prototype.callFn = function (name, args) {
    var k = name.toLowerCase(), self = this;
    var A = function (i) { return self.ev(args[i]); };
    switch (k) {
      case 'mid': {
        var s = this.str(A(0)), st = Math.trunc(this.num(A(1)));
        var len = args.length > 2 ? Math.trunc(this.num(A(2))) : s.length;
        return s.substr(Math.max(0, st - 1), len);
      }
      case 'len': return this.str(A(0)).length;
      case 'left': return this.str(A(0)).slice(0, Math.trunc(this.num(A(1))));
      case 'right': {
        var n = Math.trunc(this.num(A(1)));
        var t = this.str(A(0));
        return n <= 0 ? '' : t.slice(Math.max(0, t.length - n));
      }
      case 'ucase': return this.str(A(0)).toUpperCase();
      case 'lcase': return this.str(A(0)).toLowerCase();
      case 'trim': return this.str(A(0)).replace(/^\s+|\s+$/g, '');
      case 'ltrim': return this.str(A(0)).replace(/^\s+/, '');
      case 'rtrim': return this.str(A(0)).replace(/\s+$/, '');
      case 'str': {
        var v = this.num(A(0));
        return (v >= 0 ? ' ' : '') + this.str(v);
      }
      case 'val': {
        var m = /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/.exec(this.str(A(0)).trim());
        return m ? parseFloat(m[0]) : 0;
      }
      case 'cint': return Math.round(this.num(A(0)));           // VB 用银行家舍入；题目里几乎不触发 .5
      case 'int': return Math.floor(this.num(A(0)));
      case 'fix': return Math.trunc(this.num(A(0)));
      case 'abs': return Math.abs(this.num(A(0)));
      case 'sqr': return Math.sqrt(this.num(A(0)));
      case 'asc': return this.str(A(0)).charCodeAt(0) || 0;
      case 'chr': return String.fromCharCode(Math.trunc(this.num(A(0))));
      case 'rnd': return 0.5;
      case 'space': return new Array(Math.max(0, Math.trunc(this.num(A(0)))) + 1).join(' ');
      case 'string': {
        var cnt = Math.max(0, Math.trunc(this.num(A(0))));
        var ch = this.str(A(1));
        return new Array(cnt + 1).join(ch.slice(0, 1) || ch);
      }
      case 'instr': {
        var st2 = args.length > 2 ? Math.trunc(this.num(A(2))) : 0;
        return this.str(A(0)).indexOf(this.str(A(1)), Math.max(0, st2 - 1)) + 1;
      }
      case 'ucase$': return this.callFn('ucase', args);
      default: throw Unsupported('不支持函数 ' + name);
    }
  };

  Interp.prototype.setVar = function (name, value) {
    this.vars[name.toLowerCase()] = value;
  };

  Interp.prototype.exec = function (nodes) {
    for (var i = 0; i < nodes.length; i++) {
      if (++this.steps > MAX_STEPS) throw Unsupported('执行步数超限');
      if (this.exitFor || this.exitDo) return;
      this.execNode(nodes[i]);
    }
  };

  Interp.prototype.execNode = function (node) {
    var k = node[0], self = this;
    if (k === 'noop') return;
    if (k === 'dim') { node[1].forEach(function (n) { self.setVar(n, 0); }); return; }
    if (k === 'print') {
      var out = '';
      node[1].forEach(function (src, idx) {
        out += self.str(self.ev(parseExprSrc(src)));
        if (node[2][idx] === ',') out += '\t';
      });
      self.printed.push(out);
      return;
    }
    if (k === 'assign') {
      this.setVar(node[1], this.ev(node[2]));
      return;
    }
    if (k === 'exit') {
      if (node[1] === 'for') this.exitFor = true;
      else if (node[1] === 'do') this.exitDo = true;
      return;
    }
    if (k === 'if') {
      for (var i = 0; i < node[1].length; i++) {
        if (this.truth(this.ev(node[1][i][0]))) { this.exec(node[1][i][1]); return; }
      }
      this.exec(node[2] || []);
      return;
    }
    if (k === 'for') {
      var vr = node[1], from = this.num(this.ev(node[2])), to = this.num(this.ev(node[3]));
      var step = node[4] ? this.num(this.ev(node[4])) : 1;
      if (step === 0) throw Unsupported('Step 0 死循环');
      this.setVar(vr, from);
      var guard = 0;
      while ((step > 0 && this.num(this.getVar(vr)) <= to) || (step < 0 && this.num(this.getVar(vr)) >= to)) {
        this.exitFor = false;
        this.exec(node[5]);
        if (this.exitFor) { this.exitFor = false; break; }
        this.setVar(vr, this.num(this.getVar(vr)) + step);
        if (++guard > 100000) throw Unsupported('循环过长');
      }
      return;
    }
    if (k === 'do') {
      var ok = function (kind, cond) {
        if (!cond) return true;
        var v = self.truth(self.ev(cond));
        return kind === 'while' ? v : !v;
      };
      if (node[1] && !ok(node[1], node[2])) return;
      var g = 0;
      while (true) {
        this.exitDo = false;
        this.exec(node[5]);
        if (this.exitDo) { this.exitDo = false; break; }
        if (node[3] && !ok(node[3], node[4])) break;
        if (node[1] && !ok(node[1], node[2])) break;
        if (++g > 100000) throw Unsupported('循环过长');
      }
      return;
    }
    if (k === 'while') {
      var g2 = 0;
      while (this.truth(this.ev(node[1]))) {
        this.exec(node[2]);
        if (++g2 > 100000) throw Unsupported('循环过长');
      }
      return;
    }
    throw Unsupported('未知语句 ' + k);
  };

  // ---------- 入口 ----------
  function runVb(code, presets) {
    var lines = splitLines(code);
    // 去掉 Sub 签名 / End Sub，压平过程体
    var flat = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^(private|public)\s+sub\b/i.test(l) || /^sub\b/i.test(l) || /^(private|public)\s+function\b/i.test(l)) continue;
      if (/^end\s+(sub|function)$/i.test(l)) continue;
      flat.push(l);
    }
    var parsed = parseBlock(flat, 0, []);
    var it = new Interp();
    if (presets) Object.keys(presets).forEach(function (k) { it.setVar(k, presets[k]); });
    it.exec(parsed[0]);
    return { printed: it.printed, assigned: it.vars, steps: it.steps };
  }

  // ---------- 题干 → 代码 ----------
  var CJK = /[\u4e00-\u9fff]/;

  /** 页面取到的题干通常已被压成一行：按 VB 语句关键字重新断行 */
  function reflow(t) {
    var out = String(t).replace(
      /\s*(?=(?:(?:Private|Public)\s+Sub|End\s+Sub|Dim\s+[A-Za-z]|For\s+[A-Za-z]|Next\b|Do\s+(?:While|Until)|Loop\b|While\s+|Wend\b|If\s+|ElseIf\s+|Else\b|End\s+If\b|Print\s+|Text\d*\.Text\s*=))/gi,
      '\n');
    // 同一行里还压着后续语句：类型声明 / For 的 To 子句 / Then 之后断开
    out = out.replace(/(\bAs\s+[A-Za-z]\w*|\bTo\s+[-+]?\d+(?:\.\d+)?|\bThen)\s+(?=[A-Za-z_]\w*(?:\.\w+)?\s*=)/g, '$1\n');
    out = out.replace(/\n{2,}/g, '\n')
             .replace(/End\s*\n\s*If\b/g, 'End If')
             .replace(/End\s*\n\s*Sub\b/g, 'End Sub');
    return out;
  }

  function extractCode(stem) {
    var presets = {};
    if (String(stem).indexOf('\n') < 0) stem = reflow(stem);
    var m = /(?:文本框|textbox)\s*中?\s*(?:输入|键入)\s*["“]([^"”]+)["”]/i.exec(stem);
    if (!m) m = /输入\s*["“]([^"”]+)["”]/.exec(stem);
    if (!m) m = /(?:文本框|textbox)[^。；;]{0,12}?输入\s*([-+]?\d+(?:\.\d+)?)/i.exec(stem);
    if (!m) m = /输入\s*([-+]?\d+(?:\.\d+)?)\s*[，,。；;]/.exec(stem);
    if (m) presets['text1.text'] = m[1];

    var lines = String(stem).split('\n'), out = [], started = false;
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].trim();
      if (!s) continue;
      var endm = /^(end\s+(?:sub|function))\s*([\u4e00-\u9fff].*)$/i.exec(s);
      if (endm) { out.push(endm[1]); break; }
      if (/^end\s+(sub|function)\b/i.test(s)) { out.push(s); break; }
      if (!started) {
        if (/^(private|public)\s+(sub|function)\b/i.test(s) ||
            /^(private|public)\s+sub\b/i.test(s) ||
            /^(dim|for|do|while|if)\b/i.test(s) ||
            /^[A-Za-z_][\w.]*\s*=\s*.+$/.test(s) && !CJK.test(s)) {
          started = true;
        } else continue;
      }
      if (CJK.test(s)) {
        // 只保留含中文字符串字面量的代码行
        if (/["“][^"”]*[\u4e00-\u9fff]/.test(s)) out.push(s);
        continue;
      }
      out.push(s);
    }
    return { code: out.join('\n'), presets: presets };
  }

  function norm(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[，。；：]/g, '')
      .replace(/["“”]/g, '').toLowerCase();
  }

  /** 用解释器解一道题；返回 {letters, conf, note} 或 null */
  function solveVb(q) {
    if (!q || !q.options || !q.options.length) return null;
    var ex = extractCode(q.stem || '');
    if (!ex.code) return null;
    var res;
    try { res = runVb(ex.code, ex.presets); } catch (e) { return null; }

    function clean(list) {
      return list.map(function (s) { return String(s).trim(); })
        .filter(function (s) { return s !== ''; });
    }
    function match(outs) {
      if (!outs.length) return null;
      var cands = outs.map(norm);
      var i, j;
      for (i = 0; i < q.options.length; i++) {
        var o = norm(q.options[i].text);
        for (j = 0; j < cands.length; j++) {
          if (o === cands[j]) return [q.options[i].letter];
        }
      }
      for (i = 0; i < q.options.length; i++) {
        var o2 = norm(q.options[i].text);
        for (j = 0; j < cands.length; j++) {
          var c = cands[j];
          if (c && o2 && (o2.indexOf(c) >= 0 || c.indexOf(o2) >= 0) && !/^[0-9.]+$/.test(o2)) {
            return [q.options[i].letter];
          }
        }
      }
      return null;
    }

    // 先只认 Print 的输出（最可靠），没有再带上 Text1.Text 之类的赋值
    var printed = clean(res.printed);
    var hit = match(printed);
    var useOuts = printed;
    if (!hit) {
      var assignedText = [];
      Object.keys(res.assigned).forEach(function (k) {
        if (/^text\d*\.text$/i.test(k)) assignedText.push(res.assigned[k]);
      });
      useOuts = printed.concat(clean(assignedText));
      hit = match(useOuts);
    }
    if (!hit) return null;
    return { letters: hit, conf: 0.99, note: "trace='" + useOuts.join('|') + "'", engine: 'vb' };
  }

  return { runVb: runVb, extractCode: extractCode, solveVb: solveVb, norm: norm, Unsupported: Unsupported };
});

/*!
 * tsw_core.js —— 淘师湾作业网答案引擎（共享内核）
 * 被两处复用：
 *   1) build.py 打包进 51taoshi-auto-answer.user.js（Tampermonkey）
 *   2) tsw_answer.py 通过 CDP Runtime.evaluate 注入页面
 *
 * 只做四件事：采集答案 → 识别题目 → 填涂 → 交卷。
 * 不含任何 UI，不主动发请求。
 *
 * 兼容性：Chromium 63+（360 安全/极速浏览器 12+、Chrome 70+、Edge 79+）
 * 不使用可选链与空值合并，避免老内核报错。
 */
(function (root) {
  'use strict';

  if (root.TSWCore && root.TSWCore.version) return;

  var VERSION = '1.1.0';
  var LS_BANK = 'tsw_aa_bank_v1';

  /* ==========================================================
   * 0. 工具
   * ======================================================== */
  var U = {
    /** 题干归一化：去标签、空白、题号、标点，用于指纹比对 */
    norm: function (s) {
      if (s == null) return '';
      return String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/[\s\u3000]+/g, '')
        .replace(/^[（(【\[]?\s*(第)?\s*\d+\s*[题小]?[)）】\].、:：]?/, '')
        .replace(/[，。、；：？！“”‘’"'（）()《》〈〉\[\]【】<>.,;:?!~`·\-—_=+*&^%$#@|\\/]/g, '')
        .toLowerCase();
    },

    /** FNV-1a 32 位，题库主键 */
    hash: function (str) {
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      var hex = h.toString(16);
      while (hex.length < 8) hex = '0' + hex;
      return hex;
    },

    /** 二元组 Dice 相似度，题干排版差异兜底 */
    sim: function (a, b) {
      if (!a || !b) return 0;
      if (a === b) return 1;
      var A = {}, B = {}, i, inter = 0, na = 0, nb = 0;
      for (i = 0; i < a.length - 1; i++) {
        if (!A[a.substr(i, 2)]) { A[a.substr(i, 2)] = 1; na++; }
      }
      for (i = 0; i < b.length - 1; i++) {
        if (!B[b.substr(i, 2)]) { B[b.substr(i, 2)] = 1; nb++; }
      }
      if (!na || !nb) return 0;
      for (var k in A) if (B[k]) inter++;
      return (2 * inter) / (na + nb);
    },

    text: function (el) {
      if (!el) return '';
      return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    },

    /** 抽取答案字母：A / ABC / A,C / ['A','C'] / 对 / 错误 */
    letters: function (v) {
      if (v == null) return '';
      if (Object.prototype.toString.call(v) === '[object Array]') v = v.join(',');
      var s = String(v).toUpperCase().trim();
      if (/^(对|正确|TRUE|T|YES|√|是)$/.test(s)) return 'TRUE';
      if (/^(错|错误|FALSE|F|NO|×|否)$/.test(s)) return 'FALSE';
      if (/^[A-H]{1,8}$/.test(s)) return s;
      var found = [], re = /(^|[^A-Z])([A-H])(?=$|[^A-Z])/g, m;
      while ((m = re.exec(s))) if (found.indexOf(m[2]) < 0) found.push(m[2]);
      return found.sort().join('');
    },

    isChoiceLetters: function (v) {
      var s = String(v == null ? '' : v).trim().toUpperCase();
      return /^[A-H]{1,8}$/.test(s) || /^[A-H](\s*[,，、/]\s*[A-H])+$/.test(s);
    },

    fire: function (el, type) {
      var ev = type === 'click'
        ? new MouseEvent('click', { bubbles: true, cancelable: true, view: root })
        : new Event(type, { bubbles: true });
      el.dispatchEvent(ev);
    },

    sleep: function (ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    },
  };

  /* ==========================================================
   * 1. 存储适配（浏览器默认 localStorage）
   * ======================================================== */
  var store = {
    get: function (k) {
      try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; }
    },
    set: function (k, v) {
      try { if (root.localStorage) root.localStorage.setItem(k, v); } catch (e) {}
    },
  };

  function parseJSON(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /* ==========================================================
   * 2. 题库
   * ======================================================== */
  var Bank = {
    data: parseJSON(store.get(LS_BANK)) || {},
    dirty: false,
    onLog: null,

    log: function (msg, level) {
      if (typeof Bank.onLog === 'function') Bank.onLog(msg, level || 'info');
    },

    put: function (stem, ans, meta) {
      if (!stem || ans == null || ans === '') return false;
      var norm = U.norm(stem);
      if (norm.length < 4) return false;
      var key = U.hash(norm);
      var clean = String(stem).replace(/<[^>]+>/g, '').replace(/^\s*\d+\s*[.、．)）]\s*/, '').trim();
      var prev = this.data[key];
      var type = (meta && meta.type) || (prev && prev.type) || '';
      if (prev && prev.ans === ans && prev.type === type) return false;
      this.data[key] = {
        stem: clean.slice(0, 400),
        ans: ans,
        type: type,
        options: (meta && meta.options) || (prev && prev.options) || null,
        src: (meta && meta.src) || 'harvest',
        t: Date.now(),
      };
      this.dirty = true;
      this.flush();
      return true;
    },

    flush: function () {
      if (!this.dirty) return;
      store.set(LS_BANK, JSON.stringify(this.data));
      this.dirty = false;
    },

    get: function (stem) {
      var norm = U.norm(stem);
      if (!norm) return null;
      var key = U.hash(norm);
      if (this.data[key]) {
        var hit = this.data[key];
        return { ans: hit.ans, src: 'bank', sim: 1, type: hit.type, options: hit.options, stem: hit.stem };
      }
      var keys = [], k;
      for (k in this.data) if (this.data.hasOwnProperty(k)) keys.push(k);
      if (keys.length > 4000) return null;
      var best = null, bestSim = 0;
      for (var i = 0; i < keys.length; i++) {
        var rec = this.data[keys[i]];
        if (!rec || !rec.stem) continue;
        var s = U.sim(norm, U.norm(rec.stem));
        if (s > bestSim) { bestSim = s; best = rec; }
      }
      if (best && bestSim >= TSWCore.config.minSim) {
        return { ans: best.ans, src: 'bank', sim: bestSim, type: best.type, options: best.options, stem: best.stem };
      }
      return null;
    },

    size: function () {
      var n = 0;
      for (var k in this.data) if (this.data.hasOwnProperty(k)) n++;
      return n;
    },

    exportJSON: function () {
      return JSON.stringify({ v: 1, ts: new Date().toISOString(), items: this.data }, null, 2);
    },

    importJSON: function (text, merge) {
      var obj = parseJSON(text);
      if (!obj) throw new Error('不是合法 JSON');
      var items = obj.items || obj;
      if (typeof items !== 'object') throw new Error('结构不匹配');
      if (!merge) this.data = {};
      var n = 0;
      for (var k in items) {
        if (!items.hasOwnProperty(k)) continue;
        var r = items[k];
        if (!r || !r.stem || r.ans == null) continue;
        this.data[U.hash(U.norm(r.stem))] = r;
        n++;
      }
      this.dirty = true;
      this.flush();
      return n;
    },

    clear: function () {
      this.data = {};
      this.dirty = true;
      this.flush();
    },
  };

  /* ==========================================================
   * 3. 题型
   * ======================================================== */
  var TYPE = { SINGLE: 'single', MULTI: 'multi', JUDGE: 'judge', FILL: 'fill', UNKNOWN: 'unknown' };

  function guessType(q) {
    var t = (q.typeName || '') + ' ' + (q.type || '');
    if (/多选|多项|不定项/.test(t)) return TYPE.MULTI;
    if (/判断/.test(t)) return TYPE.JUDGE;
    if (/填空|简答|问答|操作|主观/.test(t)) return TYPE.FILL;
    if (/单选|单项|选择/.test(t)) return TYPE.SINGLE;
    if ((q.options || []).length >= 2) return q.multiHint ? TYPE.MULTI : TYPE.SINGLE;
    return TYPE.FILL;
  }

  /* ==========================================================
   * 4. 答案采集
   * ======================================================== */
  var STEM_KEYS = ['field01', 'questionName', 'question', 'stem', 'title', 'content', 'timu', 'questionContent', 'name'];
  var ANS_KEYS = ['answer', 'rightAnswer', 'correctAnswer', 'right', 'correct', 'daan', 'field04', 'answerStr', 'trueAnswer', 'stdAnswer'];

  var CAND = [];   // 页面数据里发现的题目对象
  var RAW = [];    // 原始响应（诊断用）

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return null;
  }

  function pushCand(rec) {
    CAND.push(rec);
    if (CAND.length > 3000) CAND.shift();
  }

  function normalizeAns(rec, raw) {
    if (raw == null) return '';
    var v = raw;
    if (typeof v === 'object') v = v.answer || v.value || v.text || '';
    if (Object.prototype.toString.call(v) === '[object Array]') v = v.join(',');
    var s = String(v).trim();
    if (!s) return '';
    if (U.letters(s) && U.isChoiceLetters(s)) return U.letters(s);
    if (guessType(rec) === TYPE.JUDGE) {
      if (s === '1' || s === 'A' || s === '√' || s === '对') return 'TRUE';
      if (s === '0' || s === 'B' || s === '×' || s === '错') return 'FALSE';
    }
    return s;
  }

  /** 递归遍历任意 JSON，捞出「像题目」的对象并入库 */
  function harvest(node, depth) {
    if (!node || depth > 8) return;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      for (var i = 0; i < node.length; i++) harvest(node[i], depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    var stem = pick(node, STEM_KEYS);
    var ansRaw = pick(node, ANS_KEYS);
    var opts = node.options || node.optionList || node.opts || null;

    var looks = stem && typeof stem === 'string' && stem.length > 3 && (
      Object.prototype.toString.call(opts) === '[object Array]' ||
      ansRaw != null || node.questionType != null || node.questionTypeName != null || node.field05 != null
    );

    if (looks) {
      var options = null;
      if (Object.prototype.toString.call(opts) === '[object Array]') {
        options = [];
        for (var j = 0; j < opts.length; j++) {
          var o = opts[j] || {};
          options.push({
            key: String(o.field03 || o.key || o.optionKey || o.code || String.fromCharCode(65 + j)).toUpperCase(),
            text: String(o.field01 || o.text || o.content || o.value || ''),
          });
        }
      }
      var rec = {
        stem: String(stem).replace(/<[^>]+>/g, '').trim(),
        id: node.field05 || node.rec_id || node.id || node.questionId || null,
        typeName: node.questionTypeName || node.typeName || node.questionType || '',
        options: options,
        multiHint: /多选|多项/.test(String(node.questionTypeName || node.typeName || '')),
        ansRaw: ansRaw,
      };
      pushCand(rec);
      if (ansRaw != null && ansRaw !== '') {
        var a = normalizeAns(rec, ansRaw);
        if (a) {
          Bank.put(rec.stem, a, { type: guessType(rec), options: options, src: 'net' });
          Bank.log('采集 [网络JSON] ' + rec.stem.slice(0, 24) + '… → ' + a);
        }
      }
    }

    for (var k in node) {
      if (!node.hasOwnProperty(k)) continue;
      var v = node[k];
      if (v && typeof v === 'object') harvest(v, depth + 1);
    }
  }

  /** 从 start 处的花括号/方括号切出平衡片段（跳过字符串里的括号） */
  function braceSlice(src, start) {
    var open = src.charAt(start);
    var close = open === '{' ? '}' : ']';
    var depth = 0, inStr = false, quote = '', esc = false;
    var limit = Math.min(src.length, start + 2000000);
    for (var i = start; i < limit; i++) {
      var c = src.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  }

  /** 一段文本：可能是 JSON、也可能是带内联对象的 JS/HTML */
  function harvestText(text, srcTag) {
    if (!text || typeof text !== 'string') return 0;
    var trimmed = text.replace(/^\s+/, '');
    var n = 0, j;

    if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
      j = parseJSON(trimmed);
      if (j) { harvest(j, 0); return 1; }
    }
    // 内联 var x = {...}
    if (/=\s*[[{]/.test(text)) {
      var re = /=\s*([[{])/g, m;
      while ((m = re.exec(text))) {
        var start = m.index + m[0].length - 1;
        var chunk = braceSlice(text, start);
        if (!chunk) continue;
        j = parseJSON(chunk);
        if (j) { harvest(j, 0); n++; }
      }
    }
    // 弱解析：field01 与 answer 扁平出现
    if (!n && /field01|rightAnswer|correctAnswer/i.test(text)) {
      var pairs = [];
      var re2 = /(field01|answer|rightAnswer|correctAnswer|field04)\s*[:=]\s*(['"])([\s\S]*?)\2/g, m2;
      while ((m2 = re2.exec(text))) pairs.push([m2[1], m2[3]]);
      var stems = [], anss = [];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i][0] === 'field01') stems.push(pairs[i][1]);
        else anss.push(pairs[i][1]);
      }
      if (stems.length === 1 && anss.length) {
        Bank.put(stems[0], anss[0], { src: srcTag || 'inline-weak' });
        n++;
      }
    }
    return n;
  }

  /** 结果页/解析页：通用扫描「正确答案：X」与高亮选项 */
  function harvestResultDom() {
    var n = 0;
    var put = function (stem, ans, src) {
      if (!stem || U.norm(stem).length < 4) return false;
      return Bank.put(stem, ans, { src: src || 'result-dom' });
    };
    var stemOf = function (el) {
      var node = el;
      for (var i = 0; i < 4 && node; i++, node = node.parentElement) {
        if (node.querySelector) {
          var s = node.querySelector('.stem,.timu h5,.timu,h5,.qtitle,.question-title,.title');
          if (s && s !== el && U.text(s)) return U.text(s);
        }
        if (node.tagName === 'TR') {
          var c = node.querySelector('td,th');
          if (c && U.text(c).length > 4) return U.text(c);
        }
      }
      return '';
    };
    var ANS_RE = /(?:正确答案|参考答案|标准答案|答案)\s*[:：]\s*([A-H]{1,8}(?![A-Za-z])|对|错|√|×|[^\s，。；;、]{1,60})/;

    var nodes = document.querySelectorAll('div,li,p,td,span,dd,b,strong');
    var guard = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (guard++ > 6000) break;
      var el = nodes[i];
      if (el.children.length > 6) continue;
      var t = U.text(el);
      if (!t || t.length > 400) continue;
      if (!/(正确答案|参考答案|标准答案)/.test(t)) continue;
      var m = t.match(ANS_RE);
      if (!m) continue;
      var stem = stemOf(el);
      if (!stem) continue;
      var ans = m[1].trim();
      if (/^(对|√)$/.test(ans)) ans = 'TRUE';
      else if (/^(错|×)$/.test(ans)) ans = 'FALSE';
      else if (U.isChoiceLetters(ans)) ans = U.letters(ans);
      if (put(stem, ans)) n++;
    }

    var hl = document.querySelectorAll('.right,.correct,.isRight,.dui,.choose-right,[data-right="1"]');
    for (var k = 0; k < hl.length; k++) {
      var ht = U.text(hl[k]);
      var lm = ht.match(/^\s*([A-H])\s*[.．、:：)）]/);
      if (!lm) continue;
      var st = stemOf(hl[k]);
      if (st && put(st, lm[1])) n++;
    }

    if (n) Bank.log('结果页采集 ' + n + ' 条');
    return n;
  }

  /** 页面内联数据：<script> 里的对象、data-* 属性 */
  function harvestInline() {
    var n = 0;
    var scripts = document.querySelectorAll('script:not([src])');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || '';
      if (t.length < 30 || t.length > 3000000) continue;
      if (!/field01|answer|correctAnswer|questionType|options/i.test(t)) continue;
      n += harvestText(t, 'inline');
    }
    var attrs = document.querySelectorAll('[data-answer],[data-right],[data-correct],[data-stem]');
    for (var j = 0; j < attrs.length; j++) {
      var el = attrs[j];
      var stem = el.getAttribute('data-stem') || U.text(el.querySelector('.timu,.stem,.title') || el);
      var ans = el.getAttribute('data-answer') || el.getAttribute('data-right') || el.getAttribute('data-correct');
      if (stem && ans) {
        Bank.put(stem, normalizeAns({ stem: stem }, ans), { src: 'dom-attr' });
        n++;
      }
    }
    n += harvestResultDom();
    if (n) Bank.log('页面内联采集 ' + n + ' 处');
    return n;
  }

  /* ==========================================================
   * 5. 题目识别
   * ======================================================== */
  var Q_SELECTORS = [
    '.testCont', '.questionItem', '.question-item', '.questionLi', '.qitem',
    'li[id^="q"]', 'div[id^="question"]', '[data-questionid]', '[data-qid]', '.timu',
  ].join(',');

  var STEM_SELECTORS = ['.timu h5', '.timu .title', '.timu p', 'h5.qtitle', '.qtitle', '.question-title', '.stem', 'h5', '.timu'];

  function discoverQuestions() {
    var set = [], seenEl = [];
    var Q_HIT = 'input,textarea,select,.choose-list li,li.option,.option,[data-option],[data-key]';
    var nodes = document.querySelectorAll(Q_SELECTORS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var parentBox = el.parentElement ? el.parentElement.closest(Q_SELECTORS) : null;
      if (parentBox && parentBox !== el) continue;
      if (!el.querySelector(Q_HIT)) continue;
      if (seenEl.indexOf(el) < 0) { seenEl.push(el); set.push(el); }
    }
    if (!set.length) {
      var inputs = document.querySelectorAll('input[type=radio],input[type=checkbox]');
      for (var j = 0; j < inputs.length; j++) {
        var box = inputs[j].closest('li,div,p,form,table') || inputs[j].parentElement;
        if (box && seenEl.indexOf(box) < 0) { seenEl.push(box); set.push(box); }
      }
    }

    var list = [];
    for (var k = 0; k < set.length; k++) {
      var q = readQuestion(set[k], list.length + 1);
      if (q) list.push(q);
    }
    // 去重
    var dedup = [], marks = {};
    for (var m = 0; m < list.length; m++) {
      var key = U.hash(U.norm(list[m].stem)) + '|' + list[m].controls.length;
      if (marks[key]) continue;
      marks[key] = 1;
      dedup.push(list[m]);
    }
    return dedup;
  }

  function readQuestion(el, idx) {
    var stemEl = null;
    for (var i = 0; i < STEM_SELECTORS.length; i++) {
      var cand = el.querySelector(STEM_SELECTORS[i]);
      if (cand && U.text(cand)) { stemEl = cand; break; }
    }
    if (!stemEl) stemEl = el;
    var stem = U.text(stemEl)
      .replace(/【[^】]{1,10}】/g, '')
      .replace(/^\s*\d+\s*[.、．)）]\s*/, '')
      .trim();
    if (!stem) return null;

    var all = el.querySelectorAll('input,textarea,select');
    var controls = [];
    for (var c = 0; c < all.length; c++) {
      var ctl = all[c];
      if (ctl.type === 'hidden' || ctl.disabled) continue;
      if (/^(submit|button|reset|image|file)$/i.test(ctl.type)) continue;
      controls.push(ctl);
    }

    // 无 input 的点击式选项
    if (!controls.length) {
      var clickOpts = [];
      var boxNodes = el.querySelectorAll('.choose-list li,li.option,.option,[data-option],[data-key]');
      for (var d = 0; d < boxNodes.length; d++) {
        if (!boxNodes[d].querySelector('input')) clickOpts.push(boxNodes[d]);
      }
      if (clickOpts.length >= 2) {
        var opts2 = [];
        for (var e = 0; e < clickOpts.length; e++) {
          var o2 = clickOpts[e];
          var t2 = U.text(o2);
          var m2 = t2.match(/^\s*([A-H])\s*[.．、:：)）]?\s*/);
          var key2 = (m2 && m2[1]) || (o2.getAttribute('data-option') || o2.getAttribute('data-key')) || String.fromCharCode(65 + e);
          opts2.push({
            key: String(key2).toUpperCase(),
            text: t2.replace(/^\s*[A-H]\s*[.．、:：)）]?\s*/, ''),
            el: o2,
            control: null,
          });
        }
        var qc = { el: el, idx: idx, stem: stem, options: opts2, controls: [], typeName: el.getAttribute('data-type') || '', mode: 'click' };
        qc.multiHint = /多选/.test(qc.typeName);
        qc.type = guessType(qc);
        return qc;
      }
      return null;
    }

    // 选项：以控件为唯一依据，避免 label/li 嵌套导致重复
    var options = [];
    var choiceCtls = [];
    for (var f = 0; f < controls.length; f++) {
      if (/radio|checkbox/.test(controls[f].type)) choiceCtls.push(controls[f]);
    }
    for (var g = 0; g < choiceCtls.length; g++) {
      var ctl2 = choiceCtls[g];
      var wrap = ctl2.closest('label') || ctl2.closest('li') || ctl2.parentElement || ctl2;
      var txt = U.text(wrap);
      var mm = txt.match(/^\s*([A-H])\s*[.．、:：)）]?\s*/);
      var key = (ctl2.value && /^[A-H]$/i.test(ctl2.value)) ? ctl2.value.toUpperCase() : ((mm && mm[1]) || String.fromCharCode(65 + g));
      options.push({
        key: key.toUpperCase(),
        text: txt.replace(/^\s*[A-H]\s*[.．、:：)）]?\s*/, ''),
        el: wrap,
        control: ctl2,
      });
    }

    var hasRadio = false, hasCheck = false;
    for (var h = 0; h < controls.length; h++) {
      if (controls[h].type === 'radio') hasRadio = true;
      if (controls[h].type === 'checkbox') hasCheck = true;
    }
    var q = {
      el: el,
      idx: idx,
      stem: stem,
      controls: controls,
      options: options,
      typeName: (el.getAttribute('data-type') || '') + ' ' + (hasCheck && !hasRadio ? '多选' : ''),
      multiHint: hasCheck && !hasRadio,
      mode: 'input',
    };
    q.type = guessType(q);
    return q;
  }

  /* ==========================================================
   * 6. 作答
   * ======================================================== */
  /** 程序推演通道：题干里带 VB 代码时算出输出并匹配选项（需要 tsw_vb.js） */
  function tryVb(q) {
    var Vb = root.Vb;
    if (!Vb || typeof Vb.solveVb !== 'function' || !q.options || !q.options.length) return null;
    var opts = [];
    for (var i = 0; i < q.options.length; i++) {
      opts.push({ letter: q.options[i].key, text: q.options[i].text });
    }
    var r;
    try { r = Vb.solveVb({ stem: q.stem, options: opts }); } catch (e) { return null; }
    if (!r || !r.letters || !r.letters.length) return null;
    return { ans: r.letters.join(''), src: 'vb', sim: 1, note: r.note || '' };
  }

  function findAnswer(q) {
    var i;
    for (i = 0; i < CAND.length; i++) {
      var c = CAND[i];
      if (c.ansRaw == null || c.ansRaw === '') continue;
      if (U.norm(c.stem) !== U.norm(q.stem)) continue;
      var a = normalizeAns(c, c.ansRaw);
      if (a) return { ans: a, src: 'page', sim: 1 };
    }
    if (q.el.getAttribute) {
      var domAns = q.el.getAttribute('data-answer') || q.el.getAttribute('data-right');
      if (domAns) return { ans: normalizeAns(q, domAns), src: 'dom-attr', sim: 1 };
    }
    return Bank.get(q.stem) || tryVb(q);
  }

  function setValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? root.HTMLTextAreaElement.prototype : root.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    U.fire(el, 'input');
    U.fire(el, 'change');
    U.fire(el, 'blur');
  }

  function applyChoice(q, ansRaw) {
    var ans = String(ansRaw == null ? '' : ansRaw).trim().toUpperCase();
    if (q.type === TYPE.JUDGE) {
      if (ans === 'TRUE' || ans === '对' || ans === '√' || ans === 'A') ans = 'A';
      else if (ans === 'FALSE' || ans === '错' || ans === '×' || ans === 'B') ans = 'B';
    }
    var letters = U.letters(ans);
    if (!letters || letters === 'TRUE' || letters === 'FALSE') return 0;
    var want = letters.split('');
    var targets = [], i;

    for (i = 0; i < q.options.length; i++) {
      if (want.indexOf(q.options[i].key) >= 0) targets.push(q.options[i]);
    }
    // 字母对不上时，用选项文本相似度二次匹配（题库跨试卷复用）
    if (!targets.length) {
      var rec = Bank.get(q.stem);
      var bankOpts = rec && rec.options;
      if (bankOpts && bankOpts.length) {
        var texts = [];
        for (i = 0; i < want.length; i++) {
          for (var b = 0; b < bankOpts.length; b++) {
            if (String(bankOpts[b].key).toUpperCase() === want[i] && bankOpts[b].text) texts.push(bankOpts[b].text);
          }
        }
        for (i = 0; i < q.options.length; i++) {
          for (var t = 0; t < texts.length; t++) {
            if (U.sim(U.norm(q.options[i].text), U.norm(texts[t])) > 0.8) { targets.push(q.options[i]); break; }
          }
        }
      }
    }
    if (!targets.length) return 0;

    var ok = 0;
    for (i = 0; i < targets.length; i++) {
      var o = targets[i];
      var c = o.control;
      if (!c) {
        if (!o.el) continue;
        o.el.click();
        var inner = o.el.querySelector && o.el.querySelector('input');
        if (inner && !inner.checked) { inner.checked = true; U.fire(inner, 'change'); }
        ok++;
        continue;
      }
      if (/radio|checkbox/.test(c.type)) {
        if (!c.checked) { c.click(); if (!c.checked) { c.checked = true; U.fire(c, 'change'); } }
        if (c.checked) ok++;
      } else {
        (o.el || c).click();
        ok++;
      }
    }
    return ok;
  }

  function applyFill(q, ansRaw) {
    var ans = String(ansRaw == null ? '' : ansRaw).trim();
    if (!ans) return 0;
    var editable = [], i;
    for (i = 0; i < q.controls.length; i++) {
      var c = q.controls[i];
      if (c.tagName === 'TEXTAREA' || /^(text|search|number|email|url|tel|password)$/i.test(c.type)) editable.push(c);
    }
    if (!editable.length) return 0;
    var parts = ans.split(/\s*[|｜;；]\s*|\s{2,}/);
    var clean = [];
    for (i = 0; i < parts.length; i++) if (parts[i]) clean.push(parts[i]);
    for (i = 0; i < editable.length; i++) {
      var v = clean.length > 1 ? (clean[i] != null ? clean[i] : '') : ans;
      setValue(editable[i], v);
    }
    return editable.length;
  }

  function applyAnswer(q, ansRaw) {
    if (q.type === TYPE.SINGLE || q.type === TYPE.MULTI || q.type === TYPE.JUDGE) return applyChoice(q, ansRaw);
    return applyFill(q, ansRaw);
  }

  function mark(q, hit) {
    try {
      q.el.style.outline = '2px solid #2e9e5b';
      q.el.style.outlineOffset = '2px';
      if (!q.el.querySelector('.tsw-aa-tag')) {
        var tag = document.createElement('span');
        tag.className = 'tsw-aa-tag';
        tag.style.cssText = 'display:inline-block;margin-left:8px;font-size:12px;padding:1px 6px;border-radius:4px;' +
          'background:#e7f5ec;color:#1f7a45;border:1px solid #bfe3cd';
        q.el.insertBefore(tag, q.el.firstChild);
      }
      var el = q.el.querySelector('.tsw-aa-tag');
      el.textContent = '答案 ' + hit.ans + ' · ' + ({ page: '页面数据', bank: '题库', 'dom-attr': '页面标记', vb: '程序推演' }[hit.src] || hit.src);
    } catch (e) {}
  }

  /* ==========================================================
   * 7. 交卷
   * ======================================================== */
  function findSubmitButton() {
    var kw = /提交试卷|交卷|提交作业|保存并提交|提交答案|确定提交/;
    var els = document.querySelectorAll('a,button,input[type=button],input[type=submit],div[onclick],span[onclick]');
    for (var i = 0; i < els.length; i++) {
      var t = U.text(els[i]) || els[i].value || '';
      if (kw.test(t)) return els[i];
    }
    return null;
  }

  function submit() {
    var btn = findSubmitButton();
    if (!btn) { Bank.log('未找到「提交试卷」按钮', 'err'); return false; }
    Bank.log('点击交卷：' + (U.text(btn) || btn.value));
    btn.click();
    setTimeout(function () {
      var cands = document.querySelectorAll('.layui-layer-btn0,.layui-layer-btn a,.btn-primary,.confirm,.sure,.ui-dialog-buttonpane button');
      for (var i = 0; i < cands.length; i++) {
        if (/确定|确认|是|OK/i.test(U.text(cands[i]))) {
          Bank.log('确认交卷弹层');
          cands[i].click();
          return;
        }
      }
    }, 600);
    return true;
  }

  /* ==========================================================
   * 8. 主流程
   * ======================================================== */
  var state = { questions: [], total: 0, hit: 0, filled: 0, missed: 0, details: [], lastRun: 0 };

  async function fillAll(opts) {
    opts = opts || {};
    var dryRun = !!opts.dryRun;
    var questions = discoverQuestions();
    state.questions = questions;
    state.total = questions.length;
    state.hit = 0; state.filled = 0; state.missed = 0;
    state.details = [];

    if (!questions.length) {
      Bank.log('未识别到题目（可能不在答题页，或版式未被识别）', 'warn');
      state.lastRun = Date.now();
      return state;
    }
    Bank.log('识别到 ' + questions.length + ' 道题');

    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      var hit = findAnswer(q);
      if (!hit) {
        state.missed++;
        state.details.push({ idx: q.idx, stem: q.stem.slice(0, 60), ans: '', src: '', ok: false,
                             type: q.type, reason: 'no-answer' });
        Bank.log('#' + q.idx + ' 无答案：' + q.stem.slice(0, 28), 'warn');
        continue;
      }
      state.hit++;
      var applied = 0;
      if (!dryRun) applied = applyAnswer(q, hit.ans);
      if (!dryRun && applied > 0) {
        state.filled++;
        mark(q, hit);
        Bank.log('#' + q.idx + ' → ' + hit.ans + '  [' + hit.src + (hit.sim < 1 ? ' sim=' + hit.sim.toFixed(2) : '') + ']');
      } else if (!dryRun) {
        Bank.log('#' + q.idx + ' 填涂失败：' + q.stem.slice(0, 24), 'err');
      }
      state.details.push({
        idx: q.idx, stem: q.stem.slice(0, 60), ans: hit.ans, src: hit.src,
        sim: hit.sim, type: q.type, ok: applied > 0 || dryRun,
      });
    }

    state.lastRun = Date.now();
    Bank.log('完成：命中 ' + state.hit + '/' + state.total + '，已填 ' + state.filled +
      (state.missed ? '，缺答案 ' + state.missed : ''), 'ok');
    return state;
  }

  async function run(opts) {
    opts = opts || {};
    harvestInline();
    var st = await fillAll(opts);
    if (opts.autoSubmit && !opts.dryRun && st.missed === 0 && st.total > 0) {
      var delay = opts.submitDelay == null ? 4000 : opts.submitDelay;
      Bank.log('将在 ' + Math.round(delay / 1000) + ' 秒后自动交卷', 'warn');
      await U.sleep(delay);
      submit();
    }
    return st;
  }

  /* ==========================================================
   * 9. 导出
   * ======================================================== */
  var TSWCore = {
    version: VERSION,
    U: U,
    TYPE: TYPE,
    bank: Bank,
    state: state,
    config: { minSim: 0.82 },

    setStore: function (adapter) {
      if (!adapter || typeof adapter.get !== 'function' || typeof adapter.set !== 'function') return false;
      store = adapter;
      Bank.data = parseJSON(store.get(LS_BANK)) || {};
      return true;
    },
    setLogger: function (fn) { Bank.onLog = fn; },

    ingestObject: function (obj) { harvest(obj, 0); return Bank.size(); },
    ingestText: function (text, tag) { return harvestText(text, tag); },
    ingestTexts: function (arr) {
      var n = 0;
      for (var i = 0; i < arr.length; i++) n += harvestText(arr[i], 'net');
      return n;
    },
    harvestDom: function () { return harvestResultDom(); },
    harvestInline: function () { return harvestInline(); },

    discover: discoverQuestions,
    fillAll: fillAll,
    run: run,
    submit: submit,
    findSubmitButton: findSubmitButton,

    // 题库
    bankSize: function () { return Bank.size(); },
    exportBank: function () { return Bank.exportJSON(); },
    importBank: function (text, merge) { return Bank.importJSON(text, merge); },
    clearBank: function () { Bank.clear(); },

    // 诊断
    candidates: function () { return CAND.slice(0); },
    rawCount: function () { return RAW.length; },
    stats: function () {
      return {
        version: VERSION,
        url: root.location ? root.location.href : '',
        bank: Bank.size(),
        questions: state.total,
        hit: state.hit,
        filled: state.filled,
        missed: state.missed,
        candidates: CAND.length,
        submitButton: findSubmitButton() ? true : false,
      };
    },
    diagnose: function () {
      var qs = discoverQuestions();
      var out = [];
      for (var i = 0; i < qs.length; i++) {
        var q = qs[i];
        var opts = [];
        for (var j = 0; j < q.options.length; j++) opts.push({ key: q.options[j].key, text: q.options[j].text.slice(0, 80) });
        var ctl = [];
        for (var k = 0; k < q.controls.length; k++) {
          ctl.push({ tag: q.controls[k].tagName, type: q.controls[k].type, name: q.controls[k].name, value: q.controls[k].value });
        }
        out.push({
          idx: q.idx, type: q.type, mode: q.mode || 'input',
          stem: q.stem.slice(0, 200), options: opts, controls: ctl, answer: findAnswer(q),
        });
      }
      var btn = findSubmitButton();
      return {
        version: VERSION,
        url: root.location ? root.location.href : '',
        title: root.document ? root.document.title : '',
        questions: out,
        candidates: CAND.length,
        bankSize: Bank.size(),
        submitButton: btn ? btn.outerHTML : null,
      };
    },
  };

  root.TSWCore = TSWCore;
})(typeof window !== 'undefined' ? window : this);


/*!
 * panel.js —— 悬浮面板（仅在 Tampermonkey 版启用）
 * 依赖 tsw_core.js 提供的 window.TSWCore
 */
(function (root) {
  'use strict';
  if (!root.TSWCore) return;
  if (root.__TSW_PANEL__) return;
  root.__TSW_PANEL__ = true;

  var C = root.TSWCore;
  var LS_CFG = 'tsw_aa_cfg_v1';
  var IS_TOP = true;
  try { IS_TOP = (root.top === root.self); } catch (e) { IS_TOP = true; }

  var CFG = { autoFill: true, autoSubmit: false, submitDelay: 4000, panel: true };
  try {
    var saved = JSON.parse(root.localStorage.getItem(LS_CFG) || '{}');
    for (var k in saved) if (saved.hasOwnProperty(k) && CFG.hasOwnProperty(k)) CFG[k] = saved[k];
  } catch (e) {}
  function saveCfg() {
    try { root.localStorage.setItem(LS_CFG, JSON.stringify(CFG)); } catch (e) {}
  }

  var panel = null;
  var submitToken = 0;

  /* --------------------------------------------------------
   * 网络嗅探：页面自己请求回来的试卷 JSON 里就带标准答案
   * （Python 版靠 CDP 的 Network 域，油猴版只能靠这个钩子）
   * ------------------------------------------------------ */
  var snifferReady = false;
  function installSniffer() {
    if (snifferReady) return;
    snifferReady = true;

    function feed(text, url) {
      if (!text || text.length > 4000000) return;
      try {
        if (C.ingestText(text, 'net')) {
          var n = C.bankSize();
          log('收到接口数据，题库 ' + n + ' 条  ' + String(url || '').slice(-48));
        }
      } catch (e) {}
    }

    // XHR
    var XO = root.XMLHttpRequest && root.XMLHttpRequest.prototype.open;
    var XS = root.XMLHttpRequest && root.XMLHttpRequest.prototype.send;
    if (XO && XS) {
      root.XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__tsw_url = String(url || ''); } catch (e) {}
        return XO.apply(this, arguments);
      };
      root.XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        xhr.addEventListener('load', function () {
          try {
            var rt = xhr.responseType;
            if (rt && rt !== 'text' && rt !== 'json') return;
            if (rt === 'json') return feed(JSON.stringify(xhr.response), xhr.__tsw_url);
            feed(xhr.responseText, xhr.__tsw_url);
          } catch (e) {}
        }, false);
        return XS.apply(this, arguments);
      };
    }

    // fetch
    var of = root.fetch;
    if (typeof of === 'function') {
      root.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        return of.apply(this, arguments).then(function (res) {
          try {
            var ct = (res.headers && res.headers.get('content-type')) || '';
            if (/json|javascript|html|text/i.test(ct)) {
              res.clone().text().then(function (txt) { feed(txt, url); }).catch(function () {});
            }
          } catch (e) {}
          return res;
        });
      };
    }

    log('已挂载网络嗅探（XHR / fetch）');
  }

  function log(msg, level) {
    if (panel && panel.write) panel.write({ t: Date.now(), level: level || 'info', msg: String(msg) });
    try { console.log('[TSW]', level || 'info', msg); } catch (e) {}
  }
  C.setLogger(log);

  function buildPanel() {
    if (panel) return panel;
    var host = document.createElement('div');
    host.id = 'tsw-aa-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    root.document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.box{width:330px;font:12px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
      'background:#fff;color:#1d2b28;border:1px solid #cfd8d3;border-radius:12px;',
      'box-shadow:0 10px 28px rgba(0,0,0,.18);overflow:hidden}',
      '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(135deg,#0f6b52,#17886a);color:#fff;cursor:move}',
      '.hd b{font-size:13px;flex:1}',
      '.hd button{background:rgba(255,255,255,.16);border:0;color:#fff;border-radius:6px;padding:2px 8px;cursor:pointer}',
      '.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e6ece9;border-bottom:1px solid #e6ece9}',
      '.stat{background:#fff;padding:8px 6px;text-align:center}',
      '.stat b{display:block;font-size:16px;color:#0f6b52}',
      '.stat span{font-size:10px;color:#7b8b85}',
      '.bd{padding:10px 12px;display:grid;gap:8px}',
      '.row{display:flex;gap:6px;flex-wrap:wrap}',
      'button.b{flex:1;min-width:92px;border:1px solid #cfd8d3;background:#f7faf8;color:#1d2b28;',
      'border-radius:7px;padding:7px 8px;font-size:12px;cursor:pointer}',
      'button.b:hover{background:#eaf5ef;border-color:#17886a;color:#0f6b52}',
      'button.p{background:#0f6b52;color:#fff;border-color:#0f6b52}',
      'button.d{border-color:#e3c6c0;color:#a8402c;background:#fdf7f5}',
      'label.ck{display:flex;align-items:center;gap:6px;color:#4c5c57}',
      '#log{max-height:150px;overflow:auto;background:#f6f8f7;border:1px solid #e3e9e6;border-radius:7px;',
      'padding:6px 8px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}',
      '#log div{padding:1px 0;white-space:pre-wrap;word-break:break-all}',
      '.i{color:#3d6b57}.w{color:#a76312}.e{color:#a8402c}.o{color:#0f6b52;font-weight:600}',
      '.ft{padding:6px 12px;background:#f6f8f7;border-top:1px solid #e6ece9;color:#7b8b85;font-size:10px;display:flex;justify-content:space-between}',
      '.min .bd,.min .stats,.min .ft{display:none}',
      '</style>',
      '<div class="box">',
      '  <div class="hd"><b>淘师湾自动答题 <small>v' + C.version + '</small></b><button id="min">—</button></div>',
      '  <div class="stats">',
      '    <div class="stat"><b id="s-total">0</b><span>题目</span></div>',
      '    <div class="stat"><b id="s-hit">0</b><span>命中</span></div>',
      '    <div class="stat"><b id="s-fill">0</b><span>已填</span></div>',
      '    <div class="stat"><b id="s-bank">0</b><span>题库</span></div>',
      '  </div>',
      '  <div class="bd">',
      '    <div class="row"><button class="b p" id="go">扫描并作答</button><button class="b" id="scan">只扫描</button></div>',
      '    <div class="row"><button class="b" id="submit">交卷</button><button class="b" id="dump">导出题库</button><button class="b" id="diag">诊断</button></div>',
      '    <div class="row"><label class="ck"><input type="checkbox" id="ck-auto">自动作答</label>',
      '      <label class="ck"><input type="checkbox" id="ck-submit">自动交卷</label>',
      '      <button class="b d" id="clear" style="flex:0 0 auto;min-width:0">清空题库</button></div>',
      '    <div id="log"></div>',
      '  </div>',
      '  <div class="ft"><span id="ft-l">就绪</span><span id="ft-r"></span></div>',
      '</div>'
    ].join('');

    var $ = function (id) { return shadow.getElementById(id); };
    $('ck-auto').checked = !!CFG.autoFill;
    $('ck-submit').checked = !!CFG.autoSubmit;

    $('go').onclick = function () { broadcast('run'); doRun(false); };
    $('scan').onclick = function () { broadcast('scan'); doRun(true); };
    $('submit').onclick = function () { broadcast('submit'); C.submit(); };
    $('diag').onclick = function () { download('tsw-diag-' + Date.now() + '.json', JSON.stringify(C.diagnose(), null, 2)); };
    $('dump').onclick = function () {
      download('tsw-answer-bank-' + new Date().toISOString().slice(0, 10) + '.json', C.exportBank());
      log('已导出题库 ' + C.bankSize() + ' 条');
    };
    $('clear').onclick = function () {
      if (root.confirm('清空本地题库？不可恢复。')) { C.clearBank(); panel.render(); log('题库已清空'); }
    };
    $('ck-auto').onchange = function (e) { CFG.autoFill = e.target.checked; saveCfg(); };
    $('ck-submit').onchange = function (e) { CFG.autoSubmit = e.target.checked; saveCfg(); };
    $('min').onclick = function () {
      var box = shadow.querySelector('.box');
      box.className = box.className === 'box min' ? 'box' : 'box min';
      $('min').textContent = box.className.indexOf('min') >= 0 ? '＋' : '—';
    };

    // 拖拽
    var hd = shadow.querySelector('.hd');
    var drag = null;
    hd.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      var r = host.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
    });
    root.addEventListener('mousemove', function (e) {
      if (!drag) return;
      host.style.right = 'auto'; host.style.bottom = 'auto';
      host.style.left = (drag.l + e.clientX - drag.x) + 'px';
      host.style.top = (drag.t + e.clientY - drag.y) + 'px';
    });
    root.addEventListener('mouseup', function () { drag = null; });

    function download(name, text) {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    }

    panel = {
      render: function () {
        var st = C.state;
        $('s-total').textContent = st.total || 0;
        $('s-hit').textContent = st.hit || 0;
        $('s-fill').textContent = st.filled || 0;
        $('s-bank').textContent = C.bankSize();
        $('ft-l').textContent = st.lastRun ? '上次运行 ' + new Date(st.lastRun).toLocaleTimeString() : '就绪';
      },
      write: function (line) {
        var box = $('log');
        if (!box) return;
        var d = document.createElement('div');
        d.className = line.level === 'err' ? 'e' : line.level === 'warn' ? 'w' : line.level === 'ok' ? 'o' : 'i';
        d.textContent = new Date(line.t).toLocaleTimeString() + '  ' + line.msg;
        box.appendChild(d);
        while (box.childElementCount > 200) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
      },
      tick: function (sec) { $('ft-r').textContent = '交卷倒计时 ' + sec + 's'; },
    };

    panel.render();
    return panel;
  }

  async function doRun(dryRun) {
    var st = await C.fillAll({ dryRun: !!dryRun });
    panel.render();
    if (!dryRun && CFG.autoSubmit && st.missed === 0 && st.total > 0) {
      var token = ++submitToken;
      var left = CFG.submitDelay;
      log('将在 ' + Math.round(left / 1000) + ' 秒后自动交卷（点“交卷”按钮可立即执行）', 'warn');
      while (left > 0) {
        if (submitToken !== token) { log('已取消自动交卷'); return; }
        panel.tick(Math.ceil(left / 1000));
        await C.U.sleep(500);
        left -= 500;
      }
      C.submit();
    }
  }

  function broadcast(cmd) {
    if (!IS_TOP) return;
    var frames = root.document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage({ tsw: 'cmd', cmd: cmd }, '*'); } catch (e) {}
    }
  }

  function boot() {
    if (!CFG.panel || !IS_TOP) return;
    buildPanel();
    if (IS_TOP) {
      root.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d || d.tsw !== 'cmd') return;
        if (d.cmd === 'run') doRun(false);
        else if (d.cmd === 'scan') doRun(true);
        else if (d.cmd === 'submit') C.submit();
      });
    }

    C.harvestInline();

    var tries = 0, done = false;
    var timer = setInterval(function () {
      tries++;
      var n = C.discover().length;
      if (n > 0 && !done) {
        done = true;
        clearInterval(timer);
        C.harvestInline();
        if (CFG.autoFill) { log('检测到 ' + n + ' 道题，自动作答'); doRun(false); }
        return;
      }
      if (tries >= 20 && !done) {
        clearInterval(timer);
        if (!document.querySelector('.score') && !/result|answer/i.test(location.pathname)) {
          log('未检测到题目；如在答题页请点“扫描并作答”', 'warn');
        }
      }
    }, 700);

    root.addEventListener('load', function () { if (!done) C.harvestInline(); });
  }

  // 嗅探必须在 document-start 同步安装，否则页面首包的 XHR 会漏掉
  try { installSniffer(); } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);

