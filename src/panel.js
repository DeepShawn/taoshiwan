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
