/* mdpack runtime — vanilla JS, no dependencies */
(function () {
  'use strict';
  var DATA = window.MDPACK_DATA; // { title, entry, pages: {path: html}, tree: [...] }
  var pages = DATA.pages;
  var entry = DATA.entry;

  var $ = function (id) { return document.getElementById(id); };
  var content = $('content');
  var tocPane = $('sb-toc');
  var outlinePane = $('sb-outline');
  var toastEl = $('toast');
  var toastTimer = null;
  var currentPath = null;

  /* ---------- utils ---------- */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  function pageTitle(path) {
    return path === entry ? DATA.title : path.replace(/\.[^./]+$/, '').split('/').pop();
  }

  /* ---------- routing ---------- */
  function parseHash() {
    var raw = '';
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch (e) { raw = location.hash.slice(1); }
    if (!raw || raw.charAt(0) !== '/') raw = '/' + entry;
    var qIdx = raw.indexOf('?');
    var pathPart = qIdx === -1 ? raw : raw.slice(0, qIdx);
    var query = qIdx === -1 ? '' : raw.slice(qIdx + 1);
    var anchor = null;
    query.split('&').forEach(function (kv) {
      var eq = kv.indexOf('=');
      if (eq > -1 && kv.slice(0, eq) === 'h') anchor = kv.slice(eq + 1);
    });
    return { path: pathPart.slice(1), anchor: anchor };
  }

  function routeTo(path, anchor) {
    var h = '#/' + encodeURI(path);
    if (anchor) h += '?h=' + encodeURIComponent(anchor);
    if (location.hash === h) render();
    else location.hash = h;
  }

  function scrollAnchor(anchor) {
    if (!anchor) { window.scrollTo(0, 0); return; }
    var el = document.getElementById(anchor);
    if (!el) {
      // fallback: find heading whose text matches the anchor string
      var want = anchor.replace(/-/g, ' ');
      var hs = content.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].id === anchor || hs[i].textContent.replace(/\s+/g, ' ') === want) { el = hs[i]; break; }
      }
    }
    if (el) el.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }

  /* ---------- mermaid (optional) ---------- */
  function renderMermaid() {
    if (!window.mermaid) return;
    var blocks = content.querySelectorAll('pre > code[class*="language-mermaid"]');
    if (!blocks.length) return;
    Array.prototype.forEach.call(blocks, function (code) {
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
    });
    try {
      mermaid.initialize({ startOnLoad: false, theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default' });
      mermaid.run({ nodes: content.querySelectorAll('div.mermaid') });
    } catch (e) { /* noop */ }
  }

  /* ---------- page render ---------- */
  function render() {
    var r = parseHash();
    if (!pages.hasOwnProperty(r.path)) {
      content.innerHTML = '<h1>404</h1><p>未找到文档：<code>' + r.path + '</code></p><p><a href="#/' + encodeURI(entry) + '">返回首页</a></p>';
      $('tb-title').textContent = '未找到文档';
      window.scrollTo(0, 0);
      return;
    }
    var samePage = r.path === currentPath;
    currentPath = r.path;
    if (!samePage) {
      content.innerHTML = pages[r.path];
      window.scrollTo(0, 0);
    }
    document.title = pageTitle(r.path) + ' · ' + DATA.title;
    $('tb-title').textContent = document.title;
    markActiveToc();
    buildOutline();
    if (r.anchor) scrollAnchor(r.anchor);
    renderMermaid();
  }

  /* ---------- sidebar: file tree ---------- */
  function buildTree(nodes, container) {
    nodes.forEach(function (node) {
      if (node.t === 'd') {
        var details = document.createElement('details');
        var summary = document.createElement('summary');
        summary.textContent = node.name;
        details.appendChild(summary);
        var children = document.createElement('div');
        children.className = 'sb-children';
        details.appendChild(children);
        buildTree(node.children, children);
        container.appendChild(details);
        details.dataset.dirPath = node.path;
      } else {
        var a = document.createElement('a');
        a.href = '#/' + encodeURI(node.path);
        a.textContent = node.name;
        a.dataset.filePath = node.path;
        container.appendChild(a);
      }
    });
  }

  function markActiveToc() {
    var links = tocPane.querySelectorAll('a[data-file-path]');
    var active = null;
    Array.prototype.forEach.call(links, function (a) {
      var on = a.dataset.filePath === currentPath;
      a.classList.toggle('active', on);
      if (on) active = a;
    });
    // expand ancestor folders of the current page
    if (active) {
      var node = active.parentElement;
      while (node && node !== tocPane) {
        if (node.tagName === 'DETAILS') node.open = true;
        node = node.parentElement;
      }
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------- sidebar: current-page outline ---------- */
  function buildOutline() {
    outlinePane.innerHTML = '';
    var hs = content.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]');
    if (!hs.length) {
      outlinePane.innerHTML = '<p style="color:var(--fg-muted);font-size:13px;padding:8px;">本页没有可显示的标题。</p>';
      return;
    }
    Array.prototype.forEach.call(hs, function (h) {
      var a = document.createElement('a');
      a.href = '#/' + encodeURI(currentPath) + '?h=' + encodeURIComponent(h.id);
      a.textContent = h.textContent;
      a.style.setProperty('--lv', Math.max(0, parseInt(h.tagName.charAt(1), 10) - 1));
      outlinePane.appendChild(a);
    });
  }

  /* ---------- sidebar open/close ---------- */
  var mqDesktop = window.matchMedia('(min-width: 1100px)');

  function applyDefaultSidebar() {
    document.body.classList.toggle('mobile', !mqDesktop.matches);
    document.body.classList.toggle('sb-open', mqDesktop.matches);
  }

  $('btn-sidebar').addEventListener('click', function () {
    document.body.classList.toggle('sb-open');
  });
  $('backdrop').addEventListener('click', function () {
    document.body.classList.remove('sb-open');
  });
  if (mqDesktop.addEventListener) mqDesktop.addEventListener('change', applyDefaultSidebar);
  else mqDesktop.addListener(applyDefaultSidebar);
  applyDefaultSidebar();

  /* ---------- tabs ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.sb-tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.sb-tab'), function (t) { t.classList.remove('active'); });
      Array.prototype.forEach.call(document.querySelectorAll('.sb-pane'), function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      $(tab.dataset.tab === 'toc' ? 'sb-toc' : 'sb-outline').classList.add('active');
    });
  });

  /* ---------- topbar actions ---------- */
  $('btn-back').addEventListener('click', function () { history.back(); });
  $('btn-home').addEventListener('click', function () { routeTo(entry); });

  var FS_KEY = 'mdpack-fs';
  var FS_MIN = 12, FS_MAX = 26, FS_DEFAULT = 16;
  function applyFs(px) {
    document.documentElement.style.setProperty('--fs', px + 'px');
  }
  function getFs() {
    var v = parseInt(localStorage.getItem(FS_KEY), 10);
    if (isNaN(v) || v < FS_MIN || v > FS_MAX) v = FS_DEFAULT;
    return v;
  }
  function setFs(px) {
    px = Math.min(FS_MAX, Math.max(FS_MIN, px));
    localStorage.setItem(FS_KEY, String(px));
    applyFs(px);
    toast('字号：' + px + 'px');
  }
  $('btn-font-inc').addEventListener('click', function () { setFs(getFs() + 1); });
  $('btn-font-dec').addEventListener('click', function () { setFs(getFs() - 1); });
  $('btn-font-reset').addEventListener('click', function () { setFs(FS_DEFAULT); });
  applyFs(getFs());

  var THEME_KEY = 'mdpack-theme';
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
  }
  setTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
  $('btn-theme').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    setTheme(dark ? 'light' : 'dark');
    renderMermaid();
  });

  /* ---------- broken links ---------- */
  content.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a') : null;
    if (a && a.classList.contains('md-broken')) {
      ev.preventDefault();
      toast('目标页面不存在（原始链接为空或无法解析）');
    }
  });

  /* ---------- boot ---------- */
  buildTree(DATA.tree, tocPane);
  window.addEventListener('hashchange', render);
  render();
})();
