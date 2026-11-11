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
