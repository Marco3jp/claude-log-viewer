import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const LIST_KEYS = ['project', 'repo', 'ref', 'branch', 'tool', 'mcp'];
const FACET_LABELS = {
  repo: 'リポジトリ', ref: 'Issue・PR', project: 'プロジェクト', branch: 'ブランチ', tool: 'ツール', mcp: 'MCP サーバー',
};
const TOGGLES = [
  ['thinking', '思考'], ['bash', 'Bash'], ['tool', 'ツール'], ['mcp', 'MCP'], ['agent', 'サブエージェント'], ['system', 'システム'],
];

const state = {
  q: '', from: '', to: '', path: '', pathMode: 'any', sort: 'end', bm: '', empty: '', s: null, view: '',
  project: [], repo: [], ref: [], branch: [], tool: [], mcp: [],
};
let facetsCache = {};
let projectLabels = {};
let current = null; // 表示中のセッション
let findTerms = [];
let marks = [];
let markIndex = -1;

// ---------- 共通 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function fmtTime(iso, withDate = true) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${t}` : t;
}

function fmtRange(a, b) {
  if (!a) return '';
  const sameDay = new Date(a).toDateString() === new Date(b).toDateString();
  return `${fmtTime(a)} 〜 ${sameDay ? fmtTime(b, false) : fmtTime(b)}`;
}

function parseTerms(q) {
  const out = [];
  for (const m of (q ?? '').matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    if (m[1] || m[3]) continue;
    const t = (m[2] ?? m[4]).toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function highlightHtml(text, terms) {
  const safe = esc(text);
  if (!terms.length) return safe;
  const re = new RegExp(`(${terms.map((t) => reEsc(esc(t))).join('|')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function refUrl(ref, kind) {
  const [repo, n] = ref.split('#');
  return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- URL と状態 ----------
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v && !(k === 'pathMode' && v === 'any') && !(k === 'sort' && v === 'end')) p.set(k, v);
  }
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of Object.keys(state)) {
    if (Array.isArray(state[k])) state[k] = p.getAll(k);
    else if (p.has(k)) state[k] = p.get(k);
  }
}

function apiParams() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) {
    if (k === 's' || k === 'view') continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v) p.set(k, v);
  }
  return p;
}

// ---------- 一覧 ----------
let reqSeq = 0;
async function loadList() {
  writeHash();
  const seq = ++reqSeq;
  const res = await fetch(`/api/sessions?${apiParams()}`);
  const data = await res.json();
  if (seq !== reqSeq) return;
  facetsCache = data.facets;
  projectLabels = data.projectLabels ?? {};
  renderChips();
  renderFacets();
  const shown = data.total > data.sessions.length ? `（上位 ${data.sessions.length} 件を表示）` : '';
  const hidden = data.hiddenEmpty ? `・返答の無い ${data.hiddenEmpty} 件を隠しています` : '';
  $('count').textContent = `${data.total} 件${shown} / 全 ${data.indexed} セッション${hidden}`;
  $('sv-empty').checked = !!state.empty;
  $('side-count').textContent = `${data.total} 件`;
  $('bm-only').classList.toggle('on', !!state.bm);
  $('sv-bm').checked = !!state.bm;
  const terms = parseTerms(state.q);
  $('list').replaceChildren(...data.sessions.map((s) => renderCompactItem(s, terms)));
  $('cards').replaceChildren(...data.sessions.map((s) => renderCard(s, terms)));
}

function addFilter(key, value) {
  if (!state[key].includes(value)) state[key].push(value);
  loadList();
}

function sessionTitle(s) {
  return s.title || s.firstPrompt || '(プロンプトなし)';
}

async function toggleBookmark(id, on) {
  const res = await fetch(`/api/bookmark?id=${encodeURIComponent(id)}&on=${on ? 1 : 0}`, { method: 'POST' });
  if (!res.ok) return;
  if (current?.session.id === id) {
    current.session.bookmarked = on;
    renderBookmarkButtons();
  }
  loadList();
}

function bookmarkButton(s) {
  return h('button', {
    class: `bm-btn${s.bookmarked ? ' on' : ''}`,
    title: s.bookmarked ? 'ブックマークを外す' : 'ブックマークする',
    onclick: (e) => { e.stopPropagation(); toggleBookmark(s.id, !s.bookmarked); },
  }, s.bookmarked ? '★' : '☆');
}

function selectSession(id) {
  showView('session');
  openSession(id);
}

function renderCompactItem(s, terms) {
  const li = h('li', {
    class: s.id === state.s ? 'active' : '',
    title: fmtRange(s.start, s.end),
    onclick: () => selectSession(s.id),
  },
  h('div', { class: 's-line' },
    s.bookmarked ? h('span', { class: 'bm-mark' }, '★') : null,
    h('div', { class: 's-title', html: highlightHtml(sessionTitle(s), terms) })),
  s.snippet ? h('div', { class: 's-snippet', html: highlightHtml(s.snippet, terms) }) : null);
  li.dataset.id = s.id;
  return li;
}

function renderCard(s, terms) {
  const li = h('li', {
    class: s.id === state.s ? 'active' : '',
    onclick: () => selectSession(s.id),
  },
  h('div', { class: 's-line' }, bookmarkButton(s), h('div', { class: 's-title', html: highlightHtml(sessionTitle(s), terms) })),
  s.title && s.firstPrompt ? h('div', { class: 's-prompt', html: highlightHtml(s.firstPrompt, terms) }) : null,
  h('div', { class: 's-meta' },
    h('span', {}, fmtRange(s.start, s.end)),
    h('span', {}, `プロンプト ${s.prompts}`),
    s.bash ? h('span', {}, `Bash ${s.bash}`) : null,
    s.writes ? h('span', {}, `編集 ${s.writes}`) : null,
    s.subagents ? h('span', {}, `サブエージェント ${s.subagents}`) : null,
    s.hits != null ? h('span', {}, `一致 ${s.hits >= 999 ? '999+' : s.hits}`) : null),
  h('div', { class: 's-badges' },
    s.repos.map((r) => h('span', { class: 'badge repo' }, r.replace(/^local:/, ''))),
    s.branches.slice(0, 2).map((b) => h('span', { class: 'badge' }, b)),
    s.refs.slice(0, 6).map((r) => h('span', { class: 'badge ref' }, `${r.kind === 'pr' ? 'PR' : 'Issue'} ${r.ref.split('/')[1]}`)),
    s.refs.length > 6 ? h('span', { class: 'badge' }, `+${s.refs.length - 6}`) : null),
  s.snippet ? h('div', { class: 's-snippet', html: highlightHtml(s.snippet, terms) }) : null);
  li.dataset.id = s.id;
  return li;
}

function chipLabel(key, value) {
  if (key === 'project') return projectLabels[value] ?? value;
  return value.replace(/^local:/, '');
}

function renderChips() {
  const chips = [];
  for (const key of LIST_KEYS) {
    for (const v of state[key]) {
      chips.push(h('span', { class: 'chip', title: v },
        h('span', {}, `${FACET_LABELS[key]}: ${chipLabel(key, v)}`),
        h('button', { title: '外す', onclick: () => { state[key] = state[key].filter((x) => x !== v); loadList(); } }, '×')));
    }
  }
  if (state.path) {
    const mode = { any: '読み書き', read: '読んだ', write: '書いた' }[state.pathMode];
    chips.push(h('span', { class: 'chip', title: state.path },
      h('span', {}, `ファイル(${mode}): ${state.path}`),
      h('button', { onclick: () => { state.path = ''; $('path').value = ''; loadList(); } }, '×')));
  }
  if (state.from || state.to) {
    chips.push(h('span', { class: 'chip' },
      h('span', {}, `期間: ${state.from || '…'} 〜 ${state.to || '…'}`),
      h('button', { onclick: () => { state.from = ''; state.to = ''; $('from').value = ''; $('to').value = ''; loadList(); } }, '×')));
  }
  $('chips').replaceChildren(...chips);
  $('sv-chips').replaceChildren(...chips.map((c) => {
    // 同じ要素は 2 か所に置けないので複製する。× のイベントは複製されないので付け直す
    const copyEl = c.cloneNode(true);
    copyEl.querySelector('button').addEventListener('click', () => c.querySelector('button').click());
    return copyEl;
  }));
}

const facetExpanded = {};
function renderFacets() {
  const order = ['repo', 'ref', 'project', 'branch', 'tool', 'mcp'];
  const nodes = [];
  for (const key of order) {
    const items = (facetsCache[key] ?? []).filter((x) => !state[key].includes(x.value));
    if (!items.length) continue;
    const limit = facetExpanded[key] ? items.length : 6;
    nodes.push(h('div', { class: 'facet' },
      h('h4', {}, FACET_LABELS[key],
        items.length > 6 ? h('button', { onclick: () => { facetExpanded[key] = !facetExpanded[key]; renderFacets(); } }, facetExpanded[key] ? 'たたむ' : `全 ${items.length} 件`) : ''),
      h('ul', {}, items.slice(0, limit).map((x) => h('li', { title: x.value, onclick: () => addFilter(key, x.value) },
        h('span', { class: 'v' }, chipLabel(key, x.value)),
        h('span', { class: 'n' }, x.count))))));
  }
  $('facets').replaceChildren(...nodes);
}

// ---------- 画面の切り替え ----------
function showView(view) {
  state.view = view === 'search' ? 'search' : '';
  $('search-view').hidden = view !== 'search';
  $('session').hidden = view !== 'session';
  $('empty').hidden = view !== 'empty';
  $('open-search').classList.toggle('on', view === 'search');
  writeHash();
}

function openSearchView() {
  $('sv-q').value = state.q;
  showView('search');
  $('sv-q').focus();
}

function closeSearchView() {
  showView(current ? 'session' : 'empty');
}

// ---------- セッション表示 ----------
async function openSession(id, { reload = false } = {}) {
  state.s = id;
  writeHash();
  for (const li of document.querySelectorAll('.session-list li')) li.classList.toggle('active', li.dataset.id === id);
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const data = await res.json();
  const box = $('events');
  const scroll = box.scrollTop;
  const openIds = new Set([...box.querySelectorAll('details.tool[open]')].map((d) => d.dataset.id));
  current = data;
  renderHead(data);
  renderEvents(box, data.events, data.session.cwd);
  renderToc();
  if (reload) {
    // 開いていたツールの中身を先に描いておかないと、高さが変わって読んでいた位置からずれる
    for (const d of box.querySelectorAll('details.tool')) if (openIds.has(d.dataset.id)) openTool(d);
    runFind(false);
    box.scrollTop = scroll;
    updateTocActive();
    return;
  }
  box.scrollTop = 0;
  $('find').value = state.q.replace(/(^|\s)-("[^"]+"|\S+)/g, ' ').trim();
  runFind(true);
}

async function reloadAll() {
  const btns = document.querySelectorAll('.reload');
  btns.forEach((b) => { b.disabled = true; });
  try {
    await loadList();
    if (state.s) await openSession(state.s, { reload: true });
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function renderHead(d) {
  const s = d.session;
  const resume = `cd ${JSON.stringify(s.cwd ?? '.')} && claude --resume ${s.id}`;
  const btn = h('button', { onclick: (e) => copy(resume, e.currentTarget) }, 'コピー');
  const rows = [
    ['再開', h('code', {}, `claude --resume ${s.id}`), btn],
    ['期間', `${fmtRange(s.start, s.end)}　プロンプト ${s.prompts}・応答 ${s.turns}`],
    ['場所', h('code', {}, s.cwd ?? '')],
  ];
  if (s.repos.length || s.branches.length) {
    rows.push(['リポジトリ',
      s.repos.map((r) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); addFilter('repo', r); } }, r.replace(/^local:/, ''))),
      s.branches.map((b) => h('span', { class: 'badge' }, b))]);
  }
  if (s.refs.length) {
    rows.push(['Issue・PR', s.refs.map((r) => h('a', { href: refUrl(r.ref, r.kind), target: '_blank', rel: 'noreferrer' },
      `${r.kind === 'pr' ? 'PR' : 'Issue'} ${r.ref}`))]);
  }
  const files = d.files.write.length + d.files.read.length;
  if (files) {
    const ul = h('ul', {},
      d.files.write.map((f) => h('li', { class: 'w' }, f)),
      d.files.read.filter((f) => !d.files.write.includes(f)).map((f) => h('li', { class: 'r' }, f)));
    rows.push(['ファイル', h('details', { class: 'files' }, h('summary', {}, `書いた ${d.files.write.length}・読んだ ${d.files.read.length}`), ul)]);
  }
  const title = s.title || s.firstPrompt?.slice(0, 80) || s.id;
  $('session-head').replaceChildren(
    h('h2', {}, h('button', { class: 'bm-btn', id: 'head-bm' }), h('span', {}, title)),
    h('dl', { class: 'head-grid' }, rows.flatMap(([k, ...v]) => [h('dt', {}, k), h('dd', {}, ...v)])),
  );
  $('tb-title-text').textContent = title;
  $('tb-title-text').title = title;
  renderBookmarkButtons();
}

function renderBookmarkButtons() {
  const s = current?.session;
  if (!s) return;
  for (const btn of [$('head-bm'), $('tb-bm')]) {
    btn.textContent = s.bookmarked ? '★' : '☆';
    btn.classList.toggle('on', !!s.bookmarked);
    btn.title = s.bookmarked ? 'ブックマークを外す' : 'ブックマークする';
    btn.onclick = () => toggleBookmark(s.id, !s.bookmarked);
  }
}

function shortPath(p, cwd) {
  if (typeof p !== 'string') return '';
  return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

function toolSummary(ev, cwd) {
  const i = ev.input ?? {};
  switch (ev.name) {
    case 'Bash': {
      const cmd = (i.command ?? '').split('\n')[0];
      return i.description ? `${i.description}　$ ${cmd}` : `$ ${cmd}`;
    }
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': case 'MultiEdit':
      return shortPath(i.file_path ?? i.notebook_path, cwd);
    case 'Grep': return `${i.pattern ?? ''}${i.path ? `  in ${shortPath(i.path, cwd)}` : ''}`;
    case 'Glob': return i.pattern ?? '';
    case 'Agent': case 'Task': return `${i.description ?? ''}${i.subagent_type ? `（${i.subagent_type}）` : ''}`;
    case 'WebFetch': return i.url ?? '';
    case 'WebSearch': return i.query ?? '';
    case 'Skill': return i.skill ?? '';
    default: return JSON.stringify(i).slice(0, 300);
  }
}

function eventCategory(ev) {
  if (ev.kind === 'tool') return ev.category;
  return ev.kind;
}

function searchableText(ev) {
  if (ev.kind === 'tool') return `${ev.name}\n${JSON.stringify(ev.input)}\n${ev.result ?? ''}`.toLowerCase();
  return (ev.text ?? '').toLowerCase();
}

function pre(text, cls = '') {
  const lines = (text ?? '').split('\n').length;
  const el = h('pre', { class: `${cls} ${lines > 25 ? 'clamp' : ''}` }, text ?? '');
  return el;
}

function section(title, text, { cls = '', copyText } = {}) {
  const head = h('h6', {}, title);
  if (copyText != null) head.append(h('button', { onclick: (e) => copy(copyText, e.currentTarget) }, 'コピー'));
  const p = pre(text, cls);
  if (p.classList.contains('clamp')) {
    head.append(h('button', { onclick: (e) => { p.classList.toggle('clamp'); e.currentTarget.textContent = p.classList.contains('clamp') ? '全部表示' : 'たたむ'; } }, '全部表示'));
  }
  return [head, p];
}

function toolBody(ev, cwd) {
  const i = ev.input ?? {};
  const body = h('div', { class: 'tool-body' });
  const resultTitle = ev.isError ? '結果（エラー）' : '結果';
  const result = () => (ev.result == null ? h('h6', {}, '結果なし') : section(`${resultTitle}${ev.truncated ? '（長いので途中まで）' : ''}`, ev.result, { cls: ev.isError ? 'err' : '' }));
  switch (ev.name) {
    case 'Bash':
      body.append(...section('コマンド', i.command, { copyText: i.command }), ...[result()].flat());
      break;
    case 'Edit':
      body.append(h('h6', {}, i.file_path), ...section('変更前', i.old_string, { cls: 'diff-old' }), ...section('変更後', i.new_string, { cls: 'diff-new' }), ...[result()].flat());
      break;
    case 'Write':
      body.append(h('h6', {}, i.file_path), ...section('内容', i.content, { cls: 'diff-new' }), ...[result()].flat());
      break;
    case 'Agent': case 'Task': {
      body.append(...section('依頼', i.prompt), ...[result()].flat());
      if (ev.agentId && current) {
        const box = h('div', { class: 'subagent' });
        const btn = h('button', {
          onclick: async () => {
            btn.disabled = true;
            const res = await fetch(`/api/agent?session=${encodeURIComponent(current.session.id)}&agent=${encodeURIComponent(ev.agentId)}`);
            if (!res.ok) { btn.textContent = 'ログが見つかりません'; return; }
            const d = await res.json();
            btn.remove();
            renderEvents(box, d.events, cwd, true);
            if (findTerms.length) highlight(box, findTerms);
          },
        }, 'サブエージェントのやり取りを開く');
        body.append(btn, box);
      }
      break;
    }
    default:
      body.append(...section('入力', JSON.stringify(i, null, 2)), ...[result()].flat());
  }
  return body;
}

function openTool(details) {
  details._render?.();
  details.open = true;
}

function renderEvent(ev, cwd) {
  const cat = eventCategory(ev);
  const el = h('div', { class: `ev ev-${cat}` });
  if (ev.kind === 'tool') {
    const name = ev.category === 'mcp' ? `${ev.server} / ${ev.name.split('__').slice(2).join('__')}` : ev.name;
    const details = h('details', { class: 'tool' },
      h('summary', {},
        h('span', { class: 'name' }, name),
        h('span', { class: 'sum' }, toolSummary(ev, cwd)),
        ev.isError ? h('span', { class: 'err' }, 'エラー') : null,
        h('span', { class: 'ev-label' }, fmtTime(ev.ts, false))));
    if (ev.id) details.dataset.id = ev.id;
    details._render = () => {
      if (details.dataset.rendered) return;
      details.dataset.rendered = '1';
      const b = toolBody(ev, cwd);
      details.append(b);
      if (findTerms.length) highlight(b, findTerms);
    };
    details.addEventListener('toggle', () => { if (details.open) details._render(); });
    el.append(details);
    el._details = details;
    return el;
  }
  const label = {
    user: ev.queued ? 'ユーザー（実行中に送信）' : 'ユーザー', assistant: 'Claude', thinking: '思考', system: `システム${ev.subtype ? `: ${ev.subtype}` : ''}`, meta: ev.compact ? '要約（compact）' : 'メタ',
  }[ev.kind] ?? ev.kind;
  el.append(h('div', { class: 'ev-label' }, h('span', {}, label), h('span', {}, fmtTime(ev.ts))));
  const body = h('div', { class: 'body' });
  if (ev.kind === 'assistant') body.innerHTML = renderMarkdown(ev.text);
  else body.textContent = ev.text ?? '';
  el.append(body);
  return el;
}

function renderEvents(container, events, cwd, nested = false) {
  const frag = document.createDocumentFragment();
  const items = [];
  let prompt = -1;
  for (const ev of events) {
    const el = renderEvent(ev, cwd);
    if (ev.kind === 'user' && !nested) {
      prompt++;
      el.id = `p${prompt}`;
    }
    items.push({ ev, el, text: searchableText(ev), prompt });
    frag.append(el);
  }
  container.replaceChildren(frag);
  if (!nested) container._items = items;
}

function renderToc() {
  const items = $('events')._items ?? [];
  const links = items.filter((x) => x.ev.kind === 'user').map((x) => {
    const a = h('a', { href: `#${x.el.id}`, onclick: (e) => { e.preventDefault(); x.el.scrollIntoView({ block: 'start' }); } },
      h('div', { class: 't' }, h('span', {}, fmtTime(x.ev.ts)), h('span', { class: 'hits' })),
      h('div', { class: 'p' }, (x.ev.text ?? '').slice(0, 120)));
    a.dataset.p = x.prompt;
    return a;
  });
  $('toc').replaceChildren(h('h3', {}, `プロンプト ${links.length} 件`), ...links);
}

function updateTocActive() {
  const box = $('events');
  const items = (box._items ?? []).filter((x) => x.ev.kind === 'user');
  const top = box.getBoundingClientRect().top + 40;
  let active = null;
  for (const x of items) {
    if (x.el.getBoundingClientRect().top <= top) active = x.prompt;
    else break;
  }
  for (const a of $('toc').querySelectorAll('a')) a.classList.toggle('active', Number(a.dataset.p) === active);
}

// ---------- セッション内検索 ----------
function clearMarks(root) {
  for (const m of root.querySelectorAll('mark')) {
    const parent = m.parentNode;
    m.replaceWith(document.createTextNode(m.textContent));
    parent.normalize();
  }
}

function highlight(root, terms) {
  if (!terms.length) return;
  const re = new RegExp(terms.map(reEsc).join('|'), 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentNode.nodeName === 'MARK' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const t = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(t)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of t.matchAll(re)) {
      frag.append(t.slice(last, m.index), h('mark', {}, m[0]));
      last = m.index + m[0].length;
    }
    frag.append(t.slice(last));
    node.replaceWith(frag);
  }
}

const OPEN_LIMIT = 400;

function runFind(jump) {
  const box = $('events');
  const items = box._items ?? [];
  findTerms = parseTerms($('find').value);
  clearMarks(box);
  let matched = 0;
  let hidden = 0;
  const perPrompt = new Map();
  for (const x of items) {
    const hit = findTerms.length > 0 && findTerms.some((t) => x.text.includes(t));
    if (!hit) continue;
    matched++;
    if (getComputedStyle(x.el).display === 'none') { hidden++; continue; }
    perPrompt.set(x.prompt, (perPrompt.get(x.prompt) ?? 0) + 1);
    if (x.el._details && !x.el._details.open && matched <= OPEN_LIMIT) openTool(x.el._details);
    highlight(x.el, findTerms);
  }
  marks = [...box.querySelectorAll('mark')].filter((m) => m.offsetParent !== null);
  markIndex = -1;
  for (const a of $('toc').querySelectorAll('a')) {
    const n = perPrompt.get(Number(a.dataset.p));
    a.querySelector('.hits').textContent = n ? `${n} 件` : '';
  }
  const hiddenNote = hidden ? `（非表示の中に ${hidden} 件）` : '';
  $('find-count').textContent = findTerms.length ? `${marks.length} 件${hiddenNote}` : '';
  if (jump && marks.length) moveMark(1);
}

function moveMark(dir) {
  if (!marks.length) return;
  marks[markIndex]?.classList.remove('current');
  markIndex = (markIndex + dir + marks.length) % marks.length;
  const m = marks[markIndex];
  m.classList.add('current');
  m.scrollIntoView({ block: 'center' });
  const hiddenNote = $('find-count').textContent.match(/（.*）/)?.[0] ?? '';
  $('find-count').textContent = `${markIndex + 1} / ${marks.length}${hiddenNote}`;
}

// ---------- 表示切り替え ----------
function loadToggles() {
  try {
    return JSON.parse(localStorage.getItem('toggles')) ?? {};
  } catch {
    return {};
  }
}

const toggleState = { thinking: true, bash: true, tool: true, mcp: true, agent: true, system: false, ...loadToggles() };

function applyToggles() {
  const box = $('events');
  for (const [k] of TOGGLES) box.classList.toggle(`hide-${k}`, !toggleState[k]);
  for (const b of $('toggles').querySelectorAll('.toggle[data-k]')) b.classList.toggle('on', toggleState[b.dataset.k]);
  try {
    localStorage.setItem('toggles', JSON.stringify(toggleState));
  } catch {}
  if (current) runFind(false);
}

function renderToggles() {
  const preset = (vals) => () => { Object.assign(toggleState, vals); applyToggles(); };
  $('toggles').replaceChildren(
    ...TOGGLES.map(([k, label]) => h('button', { class: 'toggle', 'data-k': k, onclick: () => { toggleState[k] = !toggleState[k]; applyToggles(); } }, label)),
    h('button', { class: 'toggle preset', onclick: preset({ thinking: false, bash: false, tool: false, mcp: false, agent: false, system: false }) }, '会話だけ'),
    h('button', { class: 'toggle preset', onclick: preset({ thinking: true, bash: true, tool: true, mcp: true, agent: true, system: true }) }, '全部'),
    h('button', {
      class: 'toggle preset',
      onclick: () => {
        const ds = [...$('events').querySelectorAll('details.tool')].filter((d) => d.offsetParent !== null);
        const open = ds.some((d) => !d.open);
        ds.forEach((d) => { d.open = open; });
      },
    }, 'ツールを開く/閉じる'),
  );
}

// ---------- ペインの大きさ ----------
// sign は、ドラッグした向きと大きさが増える向きが逆のとき -1（目次は左へ引くと広がる）
const PANES = {
  sidebar: { prop: '--sidebar-w', axis: 'x', min: 240, sign: 1, el: () => document.querySelector('.sidebar'), btn: ['‹', '›'], label: '一覧' },
  toc: { prop: '--toc-w', axis: 'x', min: 140, sign: -1, el: () => $('toc'), btn: ['›', '‹'], label: '目次' },
  head: { prop: '--head-h', axis: 'y', min: 48, sign: 1, el: () => $('session-head'), btn: ['▴', '▾'], label: 'ヘッダー' },
};

function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem('layout'));
    return { sizes: v?.sizes ?? {}, collapsed: v?.collapsed ?? {} };
  } catch {
    return { sizes: {}, collapsed: {} };
  }
}

const layout = loadLayout();

function applyLayout() {
  const root = document.documentElement;
  for (const [k, p] of Object.entries(PANES)) {
    if (layout.sizes[k]) root.style.setProperty(p.prop, `${layout.sizes[k]}px`);
    else root.style.removeProperty(p.prop);
    $('app').classList.toggle(`collapsed-${k}`, !!layout.collapsed[k]);
    for (const btn of document.querySelectorAll(`[data-collapse="${k}"]`)) {
      const c = !!layout.collapsed[k];
      btn.textContent = p.btn[c ? 1 : 0];
      btn.title = c ? `${p.label}を開く` : (k === 'head' ? `${p.label}を畳んでツールバーにまとめる` : `${p.label}をたたむ`);
    }
  }
  try {
    localStorage.setItem('layout', JSON.stringify(layout));
  } catch {}
}

function setupPanes() {
  for (const handle of document.querySelectorAll('.handle[data-pane]')) {
    const k = handle.dataset.pane;
    const p = PANES[k];
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.pane-btn')) return;
      e.preventDefault();
      const rect = p.el().getBoundingClientRect();
      const startSize = layout.collapsed[k] ? 0 : (p.axis === 'x' ? rect.width : rect.height);
      const startPos = p.axis === 'x' ? e.clientX : e.clientY;
      const max = (p.axis === 'x' ? window.innerWidth : window.innerHeight) * 0.75;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('active');
      document.body.classList.add('resizing', p.axis);
      const move = (ev) => {
        const raw = startSize + p.sign * ((p.axis === 'x' ? ev.clientX : ev.clientY) - startPos);
        // 最小より半分以上小さくしたら畳む
        if (raw < p.min / 2) {
          layout.collapsed[k] = true;
        } else {
          layout.collapsed[k] = false;
          layout.sizes[k] = Math.round(Math.min(max, Math.max(p.min, raw)));
        }
        applyLayout();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('active');
        document.body.classList.remove('resizing', p.axis);
        updateTocActive();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pane-btn')) return;
      delete layout.sizes[k];
      layout.collapsed[k] = false;
      applyLayout();
    });
  }
  for (const btn of document.querySelectorAll('[data-collapse]')) {
    btn.addEventListener('click', () => {
      const k = btn.dataset.collapse;
      layout.collapsed[k] = !layout.collapsed[k];
      applyLayout();
    });
  }
  applyLayout();
}

// ---------- 起動 ----------
function bind() {
  readHash();
  $('q').value = state.q;
  $('from').value = state.from;
  $('to').value = state.to;
  $('path').value = state.path;
  $('pathMode').value = state.pathMode;
  $('sort').value = state.sort;

  // 左と詳細検索の 2 つの検索欄は同じ条件を指す
  const onQuery = debounce((src) => {
    state.q = src.value;
    for (const id of ['q', 'sv-q']) if ($(id) !== src) $(id).value = state.q;
    loadList();
  }, 250);
  $('q').addEventListener('input', (e) => onQuery(e.target));
  $('sv-q').addEventListener('input', (e) => onQuery(e.target));
  $('open-search').addEventListener('click', () => (state.view === 'search' ? closeSearchView() : openSearchView()));
  $('close-search').addEventListener('click', closeSearchView);
  $('bm-only').addEventListener('click', () => { state.bm = state.bm ? '' : '1'; loadList(); });
  $('sv-bm').addEventListener('change', () => { state.bm = $('sv-bm').checked ? '1' : ''; loadList(); });
  $('sv-empty').addEventListener('change', () => { state.empty = $('sv-empty').checked ? '1' : ''; loadList(); });
  for (const id of ['from', 'to', 'pathMode', 'sort']) {
    $(id).addEventListener('change', () => { state[id] = $(id).value; loadList(); });
  }
  const suggest = debounce(async () => {
    const res = await fetch(`/api/paths?q=${encodeURIComponent($('path').value)}&mode=${state.pathMode}`);
    const items = await res.json();
    $('path-list').replaceChildren(...items.map((x) => h('option', { value: x.value }, `${x.count} セッション`)));
  }, 200);
  $('path').addEventListener('input', () => { suggest(); applyPath(); });
  const applyPath = debounce(() => { state.path = $('path').value.trim(); loadList(); }, 400);

  $('find').addEventListener('input', debounce(() => runFind(true), 250));
  $('find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); moveMark(e.shiftKey ? -1 : 1); }
  });
  $('find-next').addEventListener('click', () => moveMark(1));
  $('find-prev').addEventListener('click', () => moveMark(-1));
  $('events').addEventListener('scroll', () => requestAnimationFrame(updateTocActive), { passive: true });
  $('reload').addEventListener('click', reloadAll);
  $('reload-session').addEventListener('click', reloadAll);
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (e.key === 'r' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      reloadAll();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'f' && current) {
      e.preventDefault();
      $('find').focus();
      $('find').select();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      $(state.view === 'search' ? 'sv-q' : 'q').focus();
    } else if (e.key === 'Escape' && state.view === 'search') {
      closeSearchView();
    }
  });

  setupPanes();
  renderToggles();
  applyToggles();
  const view = state.view;
  showView(view === 'search' ? 'search' : state.s ? 'session' : 'empty');
  if (view === 'search') $('sv-q').value = state.q;
  loadList().then(() => { if (state.s) openSession(state.s); });
}

bind();
