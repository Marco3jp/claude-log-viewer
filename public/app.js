import { renderMarkdown } from './markdown.js';
import { ACTIONS, WHEN_LABELS, createKeymap, comboFromEvent, loadUserText } from './keys.js';

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
  if (!reload && state.s !== id) {
    if (state.s) drafts.set(state.s, $('msg').value);
    $('msg').value = drafts.get(id) ?? '';
    runner = null;
    renderRunner();
  }
  if (!reload && memo.id !== id) loadMemo(id);
  state.s = id;
  writeHash();
  loadRunner(id);
  for (const li of document.querySelectorAll('.session-list li')) li.classList.toggle('active', li.dataset.id === id);
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const data = await res.json();
  const box = $('events');
  const scroll = box.scrollTop;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const prevMark = markIndex;
  const openIds = new Set([...box.querySelectorAll('details.tool[open]')].map((d) => d.dataset.id));
  current = data;
  renderHead(data);
  renderEvents(box, data.events, data.session.cwd);
  if (reload) {
    // 開いていたツールの中身を先に描いておかないと、高さが変わって読んでいた位置からずれる
    for (const d of box.querySelectorAll('details.tool')) if (openIds.has(d.dataset.id)) openTool(d);
    runFind(false);
    if (prevMark >= 0 && marks.length) {
      markIndex = Math.min(prevMark, marks.length - 1);
      marks[markIndex].classList.add('current');
      $('find-count').textContent = `${markIndex + 1} / ${marks.length}${$('find-count').textContent.match(/（.*）/)?.[0] ?? ''}`;
    }
    // 末尾を読んでいたら、書き込み中のセッションの続きを追えるように末尾に付いていく
    box.scrollTop = atBottom ? box.scrollHeight : scroll;
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

// ---------- 自動の読み直し ----------
const live = { list: false, session: false, busy: false };

async function runLive() {
  if (live.busy || document.hidden || !(live.list || live.session)) return;
  live.busy = true;
  const { list, session } = live;
  live.list = false;
  live.session = false;
  try {
    if (list) await loadList();
    if (session && state.s) await openSession(state.s, { reload: true });
  } catch (e) {
    console.error(e);
  } finally {
    live.busy = false;
    runLive();
  }
}

function watchChanges() {
  const es = new EventSource('/api/events');
  es.addEventListener('message', (e) => {
    const { ids } = JSON.parse(e.data);
    live.list = true;
    if (state.s && ids.includes(state.s)) live.session = true;
    runLive();
  });
  es.addEventListener('runner', (e) => setRunner(JSON.parse(e.data)));
  // つなぎ直す間に届かなかった変化があるかもしれない
  es.addEventListener('open', () => { if (state.s) loadRunner(state.s); });
  document.addEventListener('visibilitychange', runLive);
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
  for (const ev of events) {
    const el = renderEvent(ev, cwd);
    items.push({ ev, el, text: searchableText(ev) });
    frag.append(el);
  }
  container.replaceChildren(frag);
  if (!nested) container._items = items;
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
  for (const x of items) {
    const hit = findTerms.length > 0 && findTerms.some((t) => x.text.includes(t));
    if (!hit) continue;
    matched++;
    if (getComputedStyle(x.el).display === 'none') { hidden++; continue; }
    if (x.el._details && !x.el._details.open && matched <= OPEN_LIMIT) openTool(x.el._details);
    highlight(x.el, findTerms);
  }
  marks = [...box.querySelectorAll('mark')].filter((m) => m.offsetParent !== null);
  markIndex = -1;
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

// ---------- 続きを送る ----------
let runner = null; // 表示中のセッションで動かしている claude の状態
let sending = false;
const drafts = new Map();

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function loadRunner(id) {
  const res = await fetch(`/api/runner?id=${encodeURIComponent(id)}`);
  if (!res.ok || state.s !== id) return;
  runner = await res.json();
  renderRunner();
}

function setRunner(s) {
  if (s.id !== state.s) return;
  runner = { ...runner, ...s };
  renderRunner();
}

function showRunnerError(message) {
  runner = { pending: [], ...runner, error: message };
  renderRunner();
}

function renderRunner() {
  const r = runner ?? { pending: [] };
  const blocked = !!r.elsewhere && !r.alive;
  $('send').disabled = sending || r.running || r.pending.length > 0 || blocked;
  $('stop').hidden = !r.alive;
  const status = r.pending.length ? '確認待ち' : r.running ? 'Claude が作業中…' : r.alive ? '待機中' : '';
  $('runner-state').textContent = status && r.mode ? `${status}・${r.mode}` : status;
  $('runner-state').title = r.mode ? `権限モード: ${r.mode}` : '';
  $('runner-state').classList.toggle('busy', !!r.running);
  const error = blocked
    ? `このセッションは別のプロセス（PID ${r.elsewhere.pid}${r.elsewhere.kind ? `・${r.elsewhere.kind}` : ''}）で開かれているので、ここからは送れません。そちらを閉じると送れるようになります`
    : r.error;
  $('runner-error').hidden = !error;
  $('runner-error').textContent = error ?? '';
  renderPending(r.pending);
}

function renderPending(list) {
  const box = $('pending');
  // 答えを入力している途中のカードを作り直さないように、確認の組み合わせが変わったときだけ描き直す
  const key = list.map((p) => p.requestId).join(',');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...list.map((p) => (p.toolName === 'AskUserQuestion' ? questionCard(p) : permissionCard(p))));
}

async function answerRequest(p, body, card) {
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  try {
    setRunner(await postJson('/api/runner/answer', { id: state.s, requestId: p.requestId, ...body }));
  } catch (e) {
    for (const b of card.querySelectorAll('button')) b.disabled = false;
    showRunnerError(e.message);
  }
}

function toolLabel(name) {
  return name.startsWith('mcp__') ? `${name.split('__')[1]} / ${name.split('__').slice(2).join('__')}` : name;
}

// 何を許可するのかが一目で分かるように、ツールごとに説明と中身を選んで出す
function requestDetail(p) {
  const i = p.input ?? {};
  const file = shortPath(i.file_path ?? i.notebook_path, current?.session.cwd);
  switch (p.toolName) {
    case 'Bash': return { desc: i.description, blocks: [[null, i.command]] };
    case 'Edit': return { desc: file, blocks: [['変更前', i.old_string, 'diff-old'], ['変更後', i.new_string, 'diff-new']] };
    case 'MultiEdit':
      return { desc: file, blocks: (i.edits ?? []).flatMap((e, n) => [[`変更前 ${n + 1}`, e.old_string, 'diff-old'], [`変更後 ${n + 1}`, e.new_string, 'diff-new']]) };
    case 'Write': return { desc: file, blocks: [['内容', i.content, 'diff-new']] };
    case 'NotebookEdit': return { desc: file, blocks: [['内容', i.new_source, 'diff-new']] };
    case 'WebFetch': return { desc: i.prompt, blocks: [[null, i.url]] };
    case 'WebSearch': return { desc: null, blocks: [[null, i.query]] };
    default: return { desc: null, blocks: [[null, JSON.stringify(i, null, 2)]], whole: true };
  }
}

function permissionCard(p) {
  const reason = h('input', { type: 'text', class: 'deny-reason', placeholder: '拒否の理由（Claude に伝わります・省略可）' });
  const d = requestDetail(p);
  const card = h('div', { class: 'req-card' },
    h('div', { class: 'req-head' }, h('span', { class: 'req-kind' }, '許可の確認'), h('span', { class: 'name' }, toolLabel(p.toolName))),
    d.desc ? h('div', { class: 'req-desc' }, d.desc) : null,
    d.blocks.filter(([, text]) => text != null).flatMap(([label, text, cls]) => [
      label ? h('div', { class: 'req-label' }, label) : null,
      h('pre', { class: `req-code ${cls ?? ''}` }, text),
    ]),
    d.whole ? null : h('details', {}, h('summary', {}, '入力をすべて見る'), pre(JSON.stringify(p.input, null, 2))),
    h('div', { class: 'req-actions' },
      h('button', { class: 'send', onclick: () => answerRequest(p, { behavior: 'allow' }, card) }, '許可'),
      reason,
      h('button', { onclick: () => answerRequest(p, { behavior: 'deny', message: reason.value.trim() }, card) }, '拒否')));
  return card;
}

function questionCard(p) {
  const questions = Array.isArray(p.input.questions) ? p.input.questions : [];
  const fields = questions.map((q, qi) => {
    const name = `${p.requestId}-${qi}`;
    const other = h('input', { type: 'text', class: 'other', placeholder: 'その他（自由に入力）' });
    const opts = (q.options ?? []).map((o) => h('label', { class: 'opt' },
      h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: o.label }),
      h('span', {}, h('b', {}, o.label), o.description ? h('span', { class: 'desc' }, o.description) : null)));
    const el = h('fieldset', {}, h('legend', {}, q.header ? `${q.header}　` : '', h('span', {}, q.question)), ...opts, other);
    el._value = () => {
      const picked = [...el.querySelectorAll('input:checked')].map((i) => i.value);
      if (other.value.trim()) picked.push(other.value.trim());
      return picked.join(', ');
    };
    return { q, el };
  });
  const card = h('div', { class: 'req-card' },
    h('div', { class: 'req-head' }, h('span', { class: 'req-kind' }, 'Claude からの質問')),
    ...fields.map((f) => f.el),
    h('div', { class: 'req-actions' },
      h('button', {
        class: 'send',
        onclick: () => {
          const answers = {};
          for (const f of fields) {
            const v = f.el._value();
            f.el.classList.toggle('missing', !v);
            if (v) answers[f.q.question] = v;
          }
          if (Object.keys(answers).length < fields.length) return;
          answerRequest(p, { behavior: 'allow', answers }, card);
        },
      }, '回答する'),
      h('button', { onclick: () => answerRequest(p, { behavior: 'deny', message: 'ユーザーは質問に答えずに断りました' }, card) }, '答えずに断る')));
  return card;
}

async function sendMessage() {
  const text = $('msg').value.trim();
  if (!text || !state.s || $('send').disabled) return;
  const id = state.s;
  sending = true;
  renderRunner();
  try {
    setRunner(await postJson('/api/runner/send', { id, text }));
    drafts.delete(id);
    if (state.s === id) $('msg').value = '';
    const box = $('events');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    showRunnerError(e.message);
  } finally {
    sending = false;
    renderRunner();
  }
}

async function stopRunner() {
  try {
    setRunner(await postJson('/api/runner/stop', { id: state.s }));
  } catch (e) {
    showRunnerError(e.message);
  }
}

// ---------- メモ ----------
const MEMO_SAVE_MS = 800;
const memo = { id: null, timer: null, seq: 0 };

function memoStatus(text) {
  $('memo-status').textContent = text;
}

async function saveMemo(id, text) {
  clearTimeout(memo.timer);
  memo.timer = null;
  try {
    const m = await postJson('/api/memo', { id, text });
    if (memo.id === id) memoStatus(m.updatedAt ? `${fmtTime(m.updatedAt, false)} に保存` : '');
  } catch (e) {
    if (memo.id === id) memoStatus(`保存できませんでした: ${e.message}`);
  }
}

function flushMemo({ keepalive = false } = {}) {
  if (!memo.timer || !memo.id) return;
  clearTimeout(memo.timer);
  memo.timer = null;
  const body = JSON.stringify({ id: memo.id, text: $('memo-text').value });
  // ページを閉じるときは、閉じたあとも送り終えられるように keepalive で送る
  if (keepalive) fetch('/api/memo', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body });
  else saveMemo(memo.id, $('memo-text').value);
}

async function loadMemo(id) {
  flushMemo();
  memo.id = id;
  const seq = ++memo.seq;
  const box = $('memo-text');
  box.value = '';
  box.disabled = true;
  memoStatus('読み込み中…');
  try {
    const res = await fetch(`/api/memo?id=${encodeURIComponent(id)}`);
    if (seq !== memo.seq) return;
    const m = await res.json();
    if (!res.ok) throw new Error(m.error ?? `HTTP ${res.status}`);
    box.value = m.text;
    memoStatus(m.updatedAt ? `${fmtTime(m.updatedAt)} に保存` : '');
  } catch (e) {
    if (seq === memo.seq) memoStatus(`読み込めませんでした: ${e.message}`);
  } finally {
    if (seq === memo.seq) box.disabled = false;
  }
}

function onMemoInput() {
  if (!memo.id) return;
  const id = memo.id;
  memoStatus('未保存');
  clearTimeout(memo.timer);
  memo.timer = setTimeout(() => saveMemo(id, $('memo-text').value), MEMO_SAVE_MS);
}

// 選択した部分、選択が無ければ全部を、送信の入力欄の末尾に写す
function memoToComposer() {
  const t = $('memo-text');
  const picked = (t.selectionStart !== t.selectionEnd ? t.value.slice(t.selectionStart, t.selectionEnd) : t.value).trim();
  if (!picked) return;
  const msg = $('msg');
  msg.value = msg.value.trim() ? `${msg.value.trimEnd()}\n${picked}` : picked;
  msg.focus();
  msg.setSelectionRange(msg.value.length, msg.value.length);
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

const setAllToggles = (on) => {
  for (const [k] of TOGGLES) toggleState[k] = on;
  applyToggles();
};
const conversationOnly = () => setAllToggles(false);
const showAll = () => setAllToggles(true);
// どれか 1 つでも出ていれば「会話だけ」に、全部隠れていれば「全部」にする
const toggleConversation = () => (TOGGLES.some(([k]) => toggleState[k]) ? conversationOnly() : showAll());

function renderToggles() {
  $('toggles').replaceChildren(
    ...TOGGLES.map(([k, label]) => h('button', { class: 'toggle', 'data-k': k, onclick: () => { toggleState[k] = !toggleState[k]; applyToggles(); } }, label)),
    h('button', { class: 'toggle preset', onclick: conversationOnly }, '会話だけ'),
    h('button', { class: 'toggle preset', onclick: showAll }, '全部'),
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
// sign は、ドラッグした向きと大きさが増える向きが逆のとき -1（メモは左へ引くと広がる）
const PANES = {
  sidebar: { prop: '--sidebar-w', axis: 'x', min: 240, sign: 1, el: () => document.querySelector('.sidebar'), btn: ['‹', '›'], label: '一覧' },
  memo: { prop: '--memo-w', axis: 'x', min: 180, sign: -1, el: () => $('memo'), btn: ['›', '‹'], label: 'メモ' },
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

function togglePane(k, open = layout.collapsed[k]) {
  layout.collapsed[k] = !open;
  applyLayout();
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
    btn.addEventListener('click', () => togglePane(btn.dataset.collapse));
  }
  applyLayout();
}

// ---------- キー操作 ----------
let keymap = null;

function insertNewline(el) {
  el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setupKeys() {
  keymap = createKeymap({
    where: () => {
      const el = document.activeElement;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName);
      const places = new Set(['any']);
      if (!typing) places.add('global');
      if (el === $('msg')) places.add('composer');
      if (el === $('find')) places.add('find');
      return places;
    },
    handlers: {
      'composer.send': () => { sendMessage(); },
      'composer.newline': () => { insertNewline($('msg')); },
      'composer.focus': () => {
        if (!current) return false;
        $('msg').focus();
      },
      'find.next': () => { moveMark(1); },
      'find.prev': () => { moveMark(-1); },
      'find.focus': () => {
        if (!current) return false;
        $('find').focus();
        $('find').select();
      },
      'searchView.close': () => {
        if (state.view !== 'search') return false;
        closeSearchView();
      },
      'memo.focus': () => {
        if (!current) return false;
        togglePane('memo', true);
        $('memo-text').focus();
      },
      'pane.sidebar': () => { togglePane('sidebar'); },
      'pane.head': () => { togglePane('head'); },
      'pane.memo': () => { togglePane('memo'); },
      'view.toggleConversation': toggleConversation,
      'view.conversationOnly': conversationOnly,
      'view.all': showAll,
      'search.focus': () => { $(state.view === 'search' ? 'sv-q' : 'q').focus(); },
      reload: () => { reloadAll(); },
      'keys.open': () => { openKeys(); },
    },
  });
  renderKeyHints();
  $('open-keys').addEventListener('click', openKeys);
  $('keys-close').addEventListener('click', () => $('keys-dialog').close());
  $('keys-save').addEventListener('click', () => {
    const r = keymap.apply($('keys-text').value);
    showKeyErrors(r.errors);
    if (!r.errors.length) { renderKeyRows(); renderKeyHints(); }
  });
  $('keys-reset').addEventListener('click', () => {
    $('keys-text').value = '';
    keymap.apply('');
    showKeyErrors([]);
    renderKeyRows();
    renderKeyHints();
  });
  $('keys-probe').addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (!combo || combo === 'Escape' || combo === 'Tab' || combo === 'Shift+Tab') return;
    e.preventDefault();
    $('keys-probe').value = JSON.stringify(combo);
  });
}

// ボタンの説明や入力欄の案内に、今の設定のキーを出す
function renderKeyHints() {
  const key = (id) => keymap.get().bindings.get(id)[0];
  const title = (base, id) => (key(id) ? `${base} (${key(id)})` : base);
  for (const id of ['reload', 'reload-session']) $(id).title = title('一覧と表示中のセッションを読み直す', 'reload');
  $('find-prev').title = title('前へ', 'find.prev');
  $('find-next').title = title('次へ', 'find.next');
  $('open-keys').title = title('キー操作の設定', 'keys.open');
  const send = key('composer.send');
  const newline = key('composer.newline');
  const hint = [send && `${send} で送信`, newline && `${newline} で改行`].filter(Boolean).join('・');
  $('msg').placeholder = `このセッションに続きを送る${hint ? `（${hint}）` : ''}`;
}

function showKeyErrors(errors) {
  $('keys-error').hidden = !errors.length;
  $('keys-error').textContent = errors.join('\n');
}

function renderKeyRows() {
  const { bindings } = keymap.get();
  $('keys-rows').replaceChildren(...ACTIONS.map((a) => {
    const keys = bindings.get(a.id);
    return h('tr', {},
      h('td', {}, a.label),
      h('td', { class: 'when' }, WHEN_LABELS[a.when]),
      h('td', {}, keys.length ? keys.map((k) => h('kbd', {}, k)) : h('span', { class: 'none' }, 'なし')),
      h('td', {}, h('code', {}, a.id)));
  }));
}

function openKeys() {
  $('keys-text').value = loadUserText();
  showKeyErrors(keymap.get().errors);
  renderKeyRows();
  $('keys-dialog').showModal();
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
  $('find-next').addEventListener('click', () => moveMark(1));
  $('find-prev').addEventListener('click', () => moveMark(-1));
  $('reload').addEventListener('click', reloadAll);
  $('reload-session').addEventListener('click', reloadAll);
  $('send').addEventListener('click', sendMessage);
  $('memo-text').addEventListener('input', onMemoInput);
  $('memo-to-msg').addEventListener('click', memoToComposer);
  window.addEventListener('pagehide', () => flushMemo({ keepalive: true }));
  $('stop').addEventListener('click', stopRunner);
  setupKeys();

  setupPanes();
  renderToggles();
  applyToggles();
  const view = state.view;
  showView(view === 'search' ? 'search' : state.s ? 'session' : 'empty');
  if (view === 'search') $('sv-q').value = state.q;
  loadList().then(() => { if (state.s) openSession(state.s); });
  watchChanges();
}

bind();
