#!/usr/bin/env node
/**
 * mdpack — 把一个文件夹内的 Markdown 全部打包成单个自包含 HTML 文件。
 *
 * 用法:
 *   node mdpack.mjs <文件夹> [--entry <一级目录下的入口.md>] [-o <输出.html>]
 *                  [--title <文档标题>] [--exclude <名称>]... [--mermaid]
 *
 * 默认排除 .git / .idea / node_modules / 输出文件本身；
 * 默认入口为文件夹一级的 README.md；默认输出 <文件夹名>.html。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import ins from 'markdown-it-ins';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import abbr from 'markdown-it-abbr';
import deflist from 'markdown-it-deflist';
import taskLists from 'markdown-it-task-lists';
import attrs from 'markdown-it-attrs';
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opts = { exclude: [], mermaid: false, entry: null, out: null, title: null, dir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry') opts.entry = argv[++i];
    else if (a === '-o' || a === '--output') opts.out = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--exclude') opts.exclude.push(argv[++i]);
    else if (a === '--mermaid') opts.mermaid = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (!a.startsWith('-')) opts.dir = a;
    else { console.error(`未知参数: ${a}`); process.exit(1); }
  }
  return opts;
}
function usage() {
  console.log(fs.readFileSync(path.join(__dirname, 'USAGE.txt'), 'utf8'));
}

const opts = parseArgs(process.argv);
if (!opts.dir) { console.error('错误: 请指定要打包的文件夹。用法: node mdpack.mjs <文件夹> [选项]'); process.exit(1); }

const SRC_DIR = path.resolve(opts.dir);
if (!fs.existsSync(SRC_DIR) || !fs.statSync(SRC_DIR).isDirectory()) {
  console.error(`错误: "${SRC_DIR}" 不是有效文件夹`); process.exit(1);
}

const DEFAULT_EXCLUDES = ['.git', '.idea', 'node_modules'];
const EXCLUDES = new Set([...DEFAULT_EXCLUDES, ...opts.exclude]);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
};

/* ---------------- scan ---------------- */
const outputAbs = opts.out ? path.resolve(opts.out) : path.join(SRC_DIR, path.basename(SRC_DIR) + '.html');
const mdFiles = [];   // posix relative paths
const assets = new Map(); // posix rel -> dataURI
let scanned = 0;

function toPosix(p) { return p.split(path.sep).join('/'); }

function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (EXCLUDES.has(name) || abs === outputAbs) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { walk(abs); continue; }
    scanned++;
    const rel = toPosix(path.relative(SRC_DIR, abs));
    if (name.toLowerCase().endsWith('.md')) { mdFiles.push(rel); continue; }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    assets.set(rel, `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`);
  }
}
walk(SRC_DIR);
if (!mdFiles.length) { console.error('错误: 文件夹内没有找到任何 .md 文件'); process.exit(1); }

const entryRel = toPosix(path.normalize(opts.entry || 'README.md'));
if (!mdFiles.includes(entryRel)) {
  console.error(`错误: 入口文件 "${entryRel}" 不存在（可用 --entry 指定一级目录下的入口 md）。可用的 md: ${mdFiles.slice(0, 10).join(', ')}${mdFiles.length > 10 ? ' ...' : ''}`);
  process.exit(1);
}
const pageSet = new Set(mdFiles);

/* ---------------- markdown-it ---------------- */
const md = new MarkdownIt({
  html: true, linkify: true, typographer: true, breaks: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch { /* noop */ }
    }
    return ''; // markdown-it 会自行转义
  },
});
md.use(anchor, { slugify: s => s.trim().replace(/\s+/g, '-') });
md.use(footnote); md.use(mark); md.use(ins); md.use(sub); md.use(sup);
md.use(abbr); md.use(deflist); md.use(taskLists); md.use(attrs);
md.use(typeof katexPlugin === 'function' ? katexPlugin : katexPlugin.default);

/** 解析链接/图片目标 -> 路由 hash / dataURI / broken 标记 */
function decodePart(s) { try { return decodeURIComponent(s); } catch { return s; } }

function resolveTarget(raw, srcDir) {
  const t = raw.trim();
  if (t === '') return { kind: 'broken' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) || t.startsWith('//')) return { kind: 'external', href: t };
  const [beforeHash, rawFrag = ''] = t.split('#');
  const frag = decodePart(rawFrag); // markdown-it 会把 href 整体 percent-encode
  if (beforeHash === '' && rawFrag) return { kind: 'anchor', anchor: frag }; // 页内锚点
  const norm = toPosix(path.posix.normalize(path.posix.join(toPosix(srcDir), decodePart(beforeHash))));
  if (pageSet.has(norm)) return { kind: 'page', path: norm, anchor: rawFrag ? frag : null };
  if (assets.has(norm)) return { kind: 'asset', dataURI: assets.get(norm), name: path.posix.basename(norm) };
  return { kind: 'broken' };
}

md.core.ruler.push('mdpack_rewrite', state => {
  const env = state.env || {};
  const visit = tokens => {
    for (const tok of tokens) {
      if (tok.type === 'inline' && tok.children) { visit(tok.children); continue; }
      if (tok.type === 'link_open') {
        const href = tok.attrGet('href');
        if (href == null) continue;
        const r = resolveTarget(href, env.srcDir || '');
        if (r.kind === 'page') {
          let h = '#/' + encodeURI(r.path);
          if (r.anchor) h += '?h=' + encodeURIComponent(r.anchor);
          tok.attrSet('href', h);
        } else if (r.kind === 'asset') {
          tok.attrSet('href', r.dataURI);
          tok.attrSet('download', r.name);
        } else if (r.kind === 'anchor') {
          tok.attrSet('href', '#/' + encodeURI(env.page) + '?h=' + encodeURIComponent(r.anchor));
        } else if (r.kind === 'broken') {
          tok.attrSet('href', '#');
          tok.attrJoin('class', 'md-broken');
        }
      } else if (tok.type === 'image') {
        const src = tok.attrGet('src');
        if (!src) continue;
        const r = resolveTarget(src, env.srcDir || '');
        if (r.kind === 'asset') tok.attrSet('src', r.dataURI);
        else if (r.kind === 'broken') tok.attrSet('alt', (tok.attrGet('alt') || '') + '（资源缺失: ' + src + '）');
      }
    }
  };
  visit(state.tokens);
});

/* ---------------- render all pages ---------------- */
const pages = {};
for (const rel of mdFiles) {
  const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
  pages[rel] = md.render(src, { srcDir: path.posix.dirname(rel), page: rel });
}

/* ---------------- build tree ---------------- */
function buildTree() {
  const root = { t: 'd', name: '', path: '', children: [] };
  const findChild = (node, name) => node.children.find(c => c.name === name);
  for (const rel of [...mdFiles].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const parts = rel.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (isFile) cur.children.push({ t: 'f', name: part.replace(/\.md$/i, ''), path: rel });
      else {
        let child = findChild(cur, part);
        if (!child) { child = { t: 'd', name: part, path: parts.slice(0, i + 1).join('/'), children: [] }; cur.children.push(child); }
        cur = child;
      }
    });
  }
  const sortRec = node => {
    node.children.sort((a, b) => (a.t === b.t ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.t === 'd' ? -1 : 1));
    node.children.forEach(c => { if (c.t === 'd') sortRec(c); });
  };
  sortRec(root);
  return root.children;
}

/* ---------------- embed KaTeX css (woff2 only) ---------------- */
function katexCss() {
  const cssPath = path.join(__dirname, 'node_modules/katex/dist/katex.min.css');
  let css = fs.readFileSync(cssPath, 'utf8');
  // 去掉 woff/ttf 回退源，仅保留 woff2 并转 base64
  css = css.replace(/,url\(([^)]*\.(woff|ttf))\)\s*format\([^)]*\)/g, '');
  const fontDir = path.join(__dirname, 'node_modules/katex/dist');
  css = css.replace(/url\((fonts\/[^)]*\.woff2)\)/g, (_, rel) => {
    const buf = fs.readFileSync(path.join(fontDir, rel));
    return `url(data:font/woff2;base64,${buf.toString('base64')})`;
  });
  if (css.includes('url(fonts/')) throw new Error('katex css 中仍有未内嵌的字体引用');
  return css;
}

/* ---------------- embed highlight.js themes (scoped for light/dark) ---------------- */
function scopeCss(css, prefix) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map(chunk => {
      const i = chunk.indexOf('{');
      if (i === -1) return '';
      const sels = chunk.slice(0, i).trim();
      if (!sels || sels.startsWith('@')) return chunk.slice(i) + '}'; // @media 等原样保留
      const body = chunk.slice(i);
      const scoped = sels.split(',').map(s => `${prefix} ${s.trim()}`).join(',');
      return scoped + body + '}';
    })
    .join('');
}

/* ---------------- assemble ---------------- */
function readSrc(p) { return fs.readFileSync(path.join(__dirname, 'src', p), 'utf8'); }

const entryHtml = pages[entryRel];
const h1 = entryHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
const title = opts.title || (h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : path.basename(SRC_DIR));

const styleCss = [
  readSrc('style.css'),
  katexCss(),
  scopeCss(fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github.min.css'), 'utf8'), 'html:not([data-theme="dark"]) .md-body'),
  scopeCss(fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github-dark.min.css'), 'utf8'), 'html[data-theme="dark"] .md-body'),
].join('\n');

let mermaidLib = '';
if (opts.mermaid) {
  const mm = path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js');
  if (fs.existsSync(mm)) mermaidLib = fs.readFileSync(mm, 'utf8');
  else console.error('警告: --mermaid 已启用但未安装 mermaid（npm i mermaid），图表将按普通代码块显示');
}

const dataJson = JSON.stringify({ title, entry: entryRel, pages, tree: buildTree() })
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const html = readSrc('template.html')
  .replace('{{TITLE}}', title.replace(/</g, '&lt;'))
  .replace('{{STYLE}}', () => styleCss)
  .replace('{{DATA}}', () => dataJson)
  .replace('{{MERMAID_LIB}}', () => mermaidLib)
  .replace('{{RUNTIME}}', () => readSrc('runtime.js'));

fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
fs.writeFileSync(outputAbs, html);

/* ---------------- report ---------------- */
const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log(`✔ 打包完成: ${outputAbs}`);
console.log(`  扫描文件 ${scanned} 个 | 页面 ${mdFiles.length} 篇 | 资源 ${assets.size} 个 | 入口 ${entryRel}`);
console.log(`  体积 ${kb(Buffer.byteLength(html))} (其中 KaTeX 字体+样式 ${kb(Buffer.byteLength(styleCss))})`);
if (opts.mermaid && !mermaidLib) console.log('  注意: mermaid 未安装，图表未嵌入');
