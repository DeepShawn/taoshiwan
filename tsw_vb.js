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
