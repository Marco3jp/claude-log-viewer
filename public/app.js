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
  q: '', from: '', to: '', path: '', pathMode: 'any', sort: 'end', bm: '', hidden: '', s: null, view: '',
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
  const hiddenParts = [data.hiddenEmpty ? `返答の無い ${data.hiddenEmpty} 件` : '', data.hiddenByUser ? `非表示の ${data.hiddenByUser} 件` : ''].filter(Boolean);
  const hidden = hiddenParts.length ? `・${hiddenParts.join('、')}を隠しています` : '';
  $('count').textContent = `${data.total} 件${shown} / 全 ${data.indexed} セッション${hidden}`;
  $('sv-hidden').checked = !!state.hidden;
  $('side-count').textContent = `${data.total} 件`;
  $('bm-only').classList.toggle('on', !!state.bm);
  $('sv-bm').checked = !!state.bm;
  const terms = parseTerms(state.q);
  listed.clear();
  for (const s of data.sessions) {
    titles.set(s.id, sessionTitle(s));
    listed.set(s.id, s);
  }
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

async function toggleHidden(id, on) {
  const res = await fetch(`/api/hide?id=${encodeURIComponent(id)}&on=${on ? 1 : 0}`, { method: 'POST' });
  if (!res.ok) return;
  loadList();
  if ($('settings-dialog').open) loadHiddenList();
}

// 返答が無いものと設定の文字列で隠れているものは、ここでは戻せない
function hideButton(s) {
  if (s.hidden === 'empty') return h('span', { class: 'hide-btn rule', title: 'Claude の返答が無いので隠れています。設定の「非表示」で出せます', onclick: (e) => e.stopPropagation() }, h('span', {}, '返答なし'));
  if (s.hidden === 'rule') return h('span', { class: 'hide-btn rule', title: '設定の「非表示」の文字列に当たっているので隠れています', onclick: (e) => e.stopPropagation() }, h('span', {}, '条件'));
  return h('button', {
    class: 'hide-btn',
    title: s.hidden ? '一覧に戻す' : '一覧から隠す',
    onclick: (e) => { e.stopPropagation(); toggleHidden(s.id, !s.hidden); },
  }, h('span', {}, s.hidden ? '戻す' : '隠す'));
}

// 隠すボタンはマウスを載せたときだけ、タイトルの右端に重ねて出す
function titleWithHide(s, terms) {
  return h('div', { class: 's-title-wrap' }, h('div', { class: 's-title', html: highlightHtml(sessionTitle(s), terms) }), hideButton(s));
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

// tmux のタブの色と同じ並びで、確認待ち・AI が確認中・作業中・バックグラウンド待ち・未読のどれか 1 つを出す
const ACTIVITY_LABELS = {
  ask: '確認待ち', checking: 'AI が許可の確認の中身を調べています。終わって人に回すと確認待ちになります',
  busy: '作業中', bg: 'バックグラウンドのサブエージェントを待っています', unread: '新しい返事があります',
};

function activity(s) {
  const r = runnerStates.get(s.id);
  const o = otherStates.get(s.id);
  const all = [...(r?.pending ?? []), ...reviewsFor(s.id)];
  if (all.some((p) => p.status !== 'analyzing')) return 'ask';
  // hook が動いている間はターミナルにもダイアログが出て waiting になるので、調べている確認があればそちらを出す
  if (all.length) return 'checking';
  if (o?.status === 'waiting') return 'ask';
  if (r?.running || o?.status === 'busy') return 'busy';
  if (s.agentsRunning) return 'bg';
  return isUnread(s) ? 'unread' : '';
}

function activityTitle(s, a) {
  const o = otherStates.get(s.id);
  return a === 'ask' && o?.waitingFor ? `確認待ち（${o.waitingFor}）` : ACTIVITY_LABELS[a] ?? '';
}

// 印は一覧を描き直さずに付け外しできるように、クラスで出す
function itemClass(s) {
  const a = activity(s);
  return [s.id === state.s ? 'active' : '', a ? `st-${a}` : '', isUnread(s) ? 'unread' : '', s.hidden ? 'is-hidden' : '', s.bookmarked ? 'pinned' : ''].join(' ');
}

function itemMarks(s) {
  return [h('span', { class: 'status-mark', title: activityTitle(s, activity(s)) })];
}

function refreshMarks(id) {
  const s = listed.get(id);
  if (!s) return;
  const a = activity(s);
  for (const li of document.querySelectorAll(`.session-list li[data-id="${CSS.escape(id)}"]`)) {
    for (const k of Object.keys(ACTIVITY_LABELS)) li.classList.toggle(`st-${k}`, k === a);
    li.classList.toggle('unread', isUnread(s));
    const mark = li.querySelector(':scope > .s-line > .status-mark');
    if (mark) mark.title = activityTitle(s, a);
  }
}

function renderCompactItem(s, terms) {
  const li = h('li', {
    class: itemClass(s),
    title: fmtRange(s.start, s.end),
    onclick: () => selectSession(s.id),
  },
  h('div', { class: 's-line' },
    ...itemMarks(s),
    s.bookmarked ? h('span', { class: 'bm-mark' }, '★') : null,
    titleWithHide(s, terms),
    s.subagents ? agentsToggle(s) : null),
  s.snippet ? h('div', { class: 's-snippet', html: highlightHtml(s.snippet, terms) }) : null);
  li.dataset.id = s.id;
  if (s.subagents && agentsOpen.has(s.id)) li.append(agentsTree(s.id));
  return li;
}

// ---------- サブエージェント ----------
const agentsOpen = new Set();
const agentLists = new Map();

function agentsToggle(s) {
  const open = agentsOpen.has(s.id);
  return h('button', {
    class: `agents-toggle${s.agentsRunning ? ' running' : ''}`,
    title: s.agentsRunning ? `サブエージェント ${s.subagents} 件（${s.agentsRunning} 件が動いています）` : `サブエージェント ${s.subagents} 件`,
    onclick: (e) => {
      e.stopPropagation();
      if (open) agentsOpen.delete(s.id);
      else agentsOpen.add(s.id);
      const li = e.currentTarget.closest('li');
      li.querySelector('.agents-tree')?.remove();
      e.currentTarget.replaceWith(agentsToggle(s));
      if (!open) li.append(agentsTree(s.id));
    },
  }, `${open ? '▾' : '▸'} ${s.agentsRunning ? `${s.agentsRunning}/` : ''}${s.subagents}`);
}

function agentsTree(id) {
  const ul = h('ul', { class: 'agents-tree', onclick: (e) => e.stopPropagation() });
  const fill = (list) => ul.replaceChildren(...list.map((a) => h('li', {
    class: a.running ? 'running' : 'done',
    title: `${a.agentType ?? ''}${a.background ? '・バックグラウンド' : ''}・ツール ${a.tools}・${fmtRange(a.start, a.last)}`,
    onclick: () => openAgent(id, a),
  },
  h('span', { class: 'agent-dot' }),
  h('span', { class: 'agent-desc' }, a.description ?? a.agentId),
  h('span', { class: 'agent-meta' }, a.running ? elapsed(a.start) : `ツール ${a.tools}`))));
  if (agentLists.has(id)) fill(agentLists.get(id));
  else ul.append(h('li', { class: 'done' }, '読み込み中…'));
  loadAgents(id).then((list) => { if (list) fill(list); });
  return ul;
}

async function loadAgents(id) {
  try {
    const res = await fetch(`/api/subagents?id=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const list = await res.json();
    agentLists.set(id, list);
    if (id === state.s) renderAgentsBar();
    return list;
  } catch {
    return null;
  }
}

function elapsed(start) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

// 入力欄の上に、動いているサブエージェントを横に並べる
function renderAgentsBar() {
  const bar = $('agents-bar');
  const list = (agentLists.get(state.s) ?? []).filter((a) => a.running);
  bar.hidden = !list.length;
  bar.replaceChildren(...list.map((a) => h('button', { class: 'agent-chip', title: '押すと、このサブエージェントのやり取りを開きます', onclick: () => openAgent(state.s, a) },
    h('div', { class: 'agent-chip-head' }, h('span', { class: 'agent-dot' }), h('span', { class: 'agent-desc' }, a.description ?? a.agentId)),
    h('div', { class: 'agent-meta' }, [a.agentType, a.background ? 'バックグラウンド' : null, `ツール ${a.tools}`, elapsed(a.start)].filter(Boolean).join(' · ')),
    a.lastTool ? h('div', { class: 'agent-last' }, `${toolLabel(a.lastTool.name)}  ${toolSummary(a.lastTool, current?.session.cwd)}`) : null)));
}

function openAgent(id, a) {
  showView('session');
  return openSession(id, { focusTool: a.toolUseId });
}

// Agent の呼び出しを開いて、中のやり取りまで出す
function focusAgentTool(toolUseId) {
  const details = [...$('events').querySelectorAll('details.tool')].find((d) => d.dataset.id === toolUseId);
  if (!details) return null;
  openTool(details);
  details.querySelector('.subagent-open')?.click();
  return details.closest('.ev');
}

function renderCard(s, terms) {
  const li = h('li', {
    class: itemClass(s),
    onclick: () => selectSession(s.id),
  },
  h('div', { class: 's-line' }, ...itemMarks(s), bookmarkButton(s), titleWithHide(s, terms)),
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
    s.refs.slice(0, 6).map((r) => h('span', { class: `badge ref${r.role ? ` ${r.role}` : ''}`, title: REF_ROLE_LABELS[r.role] ?? r.ref },
      `${r.role === 'created' ? '出した ' : r.role === 'prompt' ? '依頼元 ' : ''}${r.kind === 'pr' ? 'PR' : 'Issue'} ${r.ref.split('/')[1]}`)),
    s.refs.length > 6 ? h('span', { class: 'badge' }, `+${s.refs.length - 6}`) : null),
  s.snippet ? h('div', { class: 's-snippet', html: highlightHtml(s.snippet, terms) }) : null);
  li.dataset.id = s.id;
  return li;
}

const REF_ROLE_LABELS = { created: 'このセッションで出したもの', prompt: '最初のプロンプトにあったもの' };

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
async function openSession(id, { reload = false, focusUuid = null, focusTool = null } = {}) {
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
  loadStatus(id);
  for (const li of document.querySelectorAll('.session-list li')) li.classList.toggle('active', li.dataset.id === id);
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const data = await res.json();
  const box = $('events');
  const scroll = box.scrollTop;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const prevMark = markIndex;
  const openIds = new Set([...box.querySelectorAll('details.tool[open]')].map((d) => d.dataset.id));
  const openAgents = new Set([...box.querySelectorAll('.subagent.loaded')].map((b) => b.dataset.agentId));
  current = data;
  renderHead(data);
  renderCwdNow();
  renderEvents(box, data.events, data.session.cwd);
  if (!decisions.has(id)) loadDecisions(id);
  settleOutgoing(id, data.events);
  if (data.session.subagents) loadAgents(id);
  else renderAgentsBar();
  if (reload) {
    // 開いていたツールの中身を先に描いておかないと、高さが変わって読んでいた位置からずれる
    for (const d of box.querySelectorAll('details.tool')) if (openIds.has(d.dataset.id)) openTool(d);
    // 開いていたサブエージェントのやり取りも、書き足された分を含めて開き直す
    for (const b of box.querySelectorAll('.subagent')) if (openAgents.has(b.dataset.agentId)) b.parentNode.querySelector('.subagent-open')?.click();
    runFind(false);
    if (prevMark >= 0 && marks.length) {
      markIndex = Math.min(prevMark, marks.length - 1);
      marks[markIndex].classList.add('current');
      $('find-count').textContent = `${markIndex + 1} / ${marks.length}${$('find-count').textContent.match(/（.*）/)?.[0] ?? ''}`;
    }
    // 末尾を読んでいたら、書き込み中のセッションの続きを追えるように末尾に付いていく
    box.scrollTop = atBottom ? box.scrollHeight : scroll;
    markSeen();
    return;
  }
  box.scrollTop = 0;
  $('find').value = state.q.replace(/(^|\s)-("[^"]+"|\S+)/g, ' ').trim();
  // 通知から開いたときはその返事、未読があれば前に読んだところの続き、検索語があれば最初の一致。それ以外は末尾で開く
  const target = focusTool ? focusAgentTool(focusTool) : focusUuid ? eventEl(focusUuid) : isUnread(data.session) ? firstAfter(readAt(id)) : null;
  runFind(!target);
  if (target) jumpTo(target);
  else if (!marks.length) box.scrollTop = box.scrollHeight;
  markSeen();
}

function eventEl(uuid) {
  const els = [...$('events').querySelectorAll('.ev')].filter((el) => el.dataset.uuid === uuid);
  return els.find((el) => el.classList.contains('ev-assistant')) ?? els[0] ?? null;
}

function firstAfter(ts) {
  const x = ($('events')._items ?? []).find((it) => it.ev.ts > ts && !['meta', 'system', 'cwd', 'rewind'].includes(it.ev.kind) && it.el.offsetParent !== null);
  return x?.el ?? null;
}

function jumpTo(el) {
  el.scrollIntoView({ block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

function openAt(id, uuid) {
  showView('session');
  return openSession(id, { focusUuid: uuid });
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
    const { ids, replies = [] } = JSON.parse(e.data);
    live.list = true;
    if (state.s && ids.includes(state.s)) live.session = true;
    runLive();
    for (const r of replies) {
      announce({ kind: '返事', title: r.title, body: r.reply.text, tag: `reply-${r.id}`, open: () => openAt(r.id, r.reply.uuid) });
    }
  });
  es.addEventListener('runner', (e) => {
    const s = JSON.parse(e.data);
    // AI が調べている間は通知せず、人に回ったときに通知する
    const before = new Set((runnerStates.get(s.id)?.pending ?? []).filter((p) => p.status !== 'analyzing').map((p) => p.requestId));
    runnerStates.set(s.id, s);
    refreshMarks(s.id);
    const fresh = s.pending.filter((p) => p.status !== 'analyzing' && !before.has(p.requestId));
    if (fresh.length && !s.muted) {
      const p = fresh[fresh.length - 1];
      const what = p.toolName === 'AskUserQuestion' ? 'Claude から質問が来ています' : `${toolLabel(p.toolName)} の許可を待っています`;
      announce({ kind: '確認待ち', title: titles.get(s.id) ?? 'セッション', body: what, tag: `waiting-${s.id}`, open: () => openAt(s.id) });
    }
    if (s.id === state.s && !s.running) loadStatus(s.id);
    setRunner(s);
  });
  // ターミナルなどで動いているセッションの状態。変わったときと、つないだときに全部届く
  es.addEventListener('others', (e) => {
    const next = JSON.parse(e.data);
    const ids = new Set([...otherStates.keys(), ...Object.keys(next)]);
    otherStates.clear();
    for (const [id, v] of Object.entries(next)) otherStates.set(id, v);
    for (const id of ids) refreshMarks(id);
  });
  // hook から届いた許可の確認。変わったときと、つないだときに全部届く
  es.addEventListener('reviews', (e) => setReviews(JSON.parse(e.data)));
  // つなぎ直す間に届かなかった変化があるかもしれない
  es.addEventListener('open', () => { if (state.s) loadRunner(state.s); });
  document.addEventListener('visibilitychange', () => {
    runLive();
    markSeen();
  });
}

// ---------- 未読と通知 ----------
const READ_KEY = 'read-state';
const NOTIFY_KEY = 'notify';
const titles = new Map();
const runnerStates = new Map();
const otherStates = new Map();
const listed = new Map(); // 一覧に出ているセッション

// 初めて使ったときより前の返事は、未読にしない
function loadRead() {
  try {
    const v = JSON.parse(localStorage.getItem(READ_KEY));
    if (v?.since) return { since: v.since, at: v.at ?? {} };
  } catch {}
  return { since: new Date().toISOString(), at: {} };
}

const readState = loadRead();

function saveRead() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(readState));
  } catch {}
}

function readAt(id) {
  return readState.at[id] ?? readState.since;
}

function isUnread(s) {
  return !!s.lastReply && s.lastReply.ts > readAt(s.id);
}

// 開いていて画面が表に出ているセッションは、最後の返事まで読んだことにする
function markSeen() {
  const s = current?.session;
  if (!s || document.hidden || state.view === 'search' || !s.lastReply || s.lastReply.ts <= readAt(s.id)) return;
  readState.at[s.id] = s.lastReply.ts;
  saveRead();
  refreshMarks(s.id);
}

function notifyOn() {
  try {
    return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

function renderNotifyButton() {
  const on = notifyOn();
  $('notify').classList.toggle('on', on);
  $('notify').textContent = on ? 'OS 通知 オン' : 'OS 通知 オフ';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notify-state').textContent = {
    granted: 'ブラウザの許可は出ています',
    denied: 'ブラウザの設定で、このページの通知が許可されていません。アドレスバーのサイト設定から許可してください',
    default: 'オンにするときに、ブラウザが通知の許可を求めます',
    unsupported: 'このブラウザは通知に対応していません',
  }[perm];
}

async function toggleNotify() {
  if (!('Notification' in window)) {
    $('notify').title = 'このブラウザは通知に対応していません';
    return;
  }
  try {
    if (notifyOn()) {
      localStorage.removeItem(NOTIFY_KEY);
    } else if ((await Notification.requestPermission()) === 'granted') {
      localStorage.setItem(NOTIFY_KEY, '1');
    } else {
      $('notify').title = 'ブラウザの設定で、このページの通知が許可されていません';
    }
  } catch {}
  renderNotifyButton();
}

// 一覧の印とは別に、オンのときだけ OS に通知する。押すとそのセッションを開く
function announce({ kind, title, body, tag, open }) {
  if (!notifyOn()) return;
  // tag が同じ通知を差し替えるときも音を鳴らす。席を離れていても気づけるように
  const n = new Notification(`${kind}: ${title}`, { body, tag, renotify: true });
  n.onclick = () => {
    window.focus();
    n.close();
    open();
  };
}

// ---------- hook から届いた許可の確認 ----------
let reviews = { pending: [], recent: [] };
const EFFECT_LABELS = { read: '読むだけ', local_write: '手元を書き換える', remote_write: '外に書き込む' };

function setReviews(next) {
  const before = new Set(reviews.pending.filter((p) => p.status === 'waiting').map((p) => p.id));
  const touched = new Set([...reviews.pending, ...next.pending].map((p) => p.sessionId));
  reviews = next;
  for (const p of next.pending.filter((x) => x.status === 'waiting' && !before.has(x.id) && !x.muted)) {
    announce({
      kind: '確認待ち',
      title: titles.get(p.sessionId) ?? 'セッション',
      body: p.analysis?.llm?.summary ?? String(p.input?.command ?? toolLabel(p.toolName)),
      tag: `review-${p.id}`,
      open: () => openAt(p.sessionId),
    });
  }
  for (const id of touched) refreshMarks(id);
  // 新しく決まったものを、チャットの画面の印にも足す
  for (const r of next.recent) {
    const list = decisions.get(r.sessionId);
    if (!list || !DECISION_BADGES[r.by] || list.some((x) => x.id === r.id)) continue;
    list.push(r);
    if (r.sessionId === state.s) applyDecisionBadges();
  }
  renderPending();
  renderRecentReviews();
}

// ---------- チャットの画面に出す、承認の判定の印 ----------
// 判定の記録はセッションごとに持つ。ターミナルで答えたものと時間切れには印を付けない
const decisions = new Map();
const DECISION_BADGES = { 'intelligence-auto-approve': 'AI が自動で許可', allow: 'ビュワーで許可', deny: 'ビュワーで拒否' };
// ツールを呼ぶと決めてから許可の確認が届くまでの間に、時刻の記録が前後することがある
const DECISION_SLACK_MS = 5000;
// 判定の記録はコマンドをこの長さで切って残すので、ちょうどこの長さのものだけは先頭で突き合わせる
const DECISION_COMMAND_MAX = 4000;

function sameCommand(toolCommand, recorded) {
  const c = String(toolCommand);
  return recorded.length === DECISION_COMMAND_MAX ? c.startsWith(recorded) : c === recorded;
}

async function loadDecisions(id) {
  try {
    const res = await fetch(`/api/reviews/decisions?session=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    decisions.set(id, await res.json());
  } catch {
    return;
  }
  if (id === state.s) applyDecisionBadges();
}

// hook の入力にはどのツール呼び出しへの確認かを示す ID が無いので、同じコマンドで、判定より前に出た呼び出しのうち一番近いものに付ける
function applyDecisionBadges() {
  const list = decisions.get(state.s);
  if (!list?.length) return;
  const tools = [...$('events').querySelectorAll('details.tool')].filter((d) => d._ev?.name === 'Bash' && d._ev.input?.command);
  const used = new Set();
  for (const d of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
    const limit = Date.parse(d.at) + DECISION_SLACK_MS;
    let best = null;
    for (const el of tools) {
      if (used.has(el) || !sameCommand(el._ev.input.command, d.command)) continue;
      const t = Date.parse(el._ev.ts);
      if (t > limit) continue;
      if (!best || t > Date.parse(best._ev.ts)) best = el;
    }
    if (!best) continue;
    used.add(best);
    setDecisionBadge(best, d);
  }
}

function setDecisionBadge(details, d) {
  if (details._decision?.id === d.id) return;
  details._decision = d;
  details.querySelector(':scope > summary > .decision-badge')?.remove();
  const label = details.querySelector(':scope > summary > .ev-label');
  label.before(h('span', { class: `decision-badge by-${d.by}`, title: d.summary ?? '' }, DECISION_BADGES[d.by]));
  if (details.dataset.rendered) {
    details.querySelector(':scope > .decision-block')?.remove();
    details.querySelector(':scope > summary').after(decisionBlock(d));
  }
}

function decisionBlock(d) {
  return h('div', { class: `decision-block by-${d.by}` },
    h('div', { class: 'req-label' }, `${DECISION_BADGES[d.by]}・${fmtTime(d.at, false)}${d.agentType ? `・サブエージェント（${d.agentType}）` : ''}`),
    d.llm ? h('div', { class: 'req-desc' }, d.llm.summary) : null,
    reviewFacts(d.llm),
    d.llm?.concerns ? h('div', { class: 'review-concerns' }, `確かめること: ${d.llm.concerns}`) : null,
    d.by !== 'intelligence-auto-approve' && d.hold?.length ? h('ul', { class: 'review-hold' }, d.hold.map((x) => h('li', {}, x))) : null,
    d.by === 'deny' && d.message ? h('div', { class: 'review-concerns' }, `拒否の理由: ${d.message}`) : null);
}

function reviewsFor(id) {
  return reviews.pending.filter((p) => p.sessionId === id);
}

// 色の段階はサーバーが決める。調べている間は、人の答えを待つものと見分けられるように一覧の印と同じ色にする
function reviewLevel(p) {
  return p.status === 'waiting' ? p.level : 'checking';
}

function reviewSource(p) {
  const who = p.agentType ? `サブエージェント（${p.agentType}）` : 'メインの会話';
  return h('div', { class: 'review-source' }, `ターミナルから・${who}${p.cwd ? `・${p.cwd}` : ''}`);
}

function reviewFacts(llm) {
  if (!llm) return null;
  const tags = [
    [EFFECT_LABELS[llm.effect] ?? llm.effect, llm.effect === 'read' ? 'ok' : llm.effect === 'remote_write' ? 'ng' : ''],
    [llm.reversible ? '元に戻せる' : '元に戻せない', llm.reversible ? 'ok' : 'ng'],
    [llm.heavy ? '重い' : '軽い', llm.heavy ? 'ng' : 'ok'],
  ];
  return h('div', { class: 'review-facts' },
    tags.map(([label, cls]) => h('span', { class: `review-tag ${cls}` }, label)),
    h('span', { class: 'review-dest' }, `接続先: ${llm.destinations.length ? llm.destinations.join('、') : '手元だけ'}`));
}

async function answerReview(p, body, card) {
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  try {
    setReviews(await postJson('/api/reviews/answer', { id: p.id, ...body }));
  } catch (e) {
    for (const b of card.querySelectorAll('button')) b.disabled = false;
    card.querySelector('.review-error')?.remove();
    card.append(h('div', { class: 'review-error' }, e.message));
  }
}

function reviewCard(p) {
  const reason = h('input', { type: 'text', class: 'deny-reason', 'data-review': p.id, placeholder: '拒否の理由（Claude に伝わります・省略可）' });
  const a = p.analysis;
  const llm = a?.llm;
  const card = h('div', { class: `req-card review-card ${reviewLevel(p)}` },
    h('div', { class: 'req-head' },
      h('span', { class: 'req-kind' }, p.status === 'analyzing' ? '許可の確認・AI が確認中' : '許可の確認・あなたの答えを待っています'),
      h('span', { class: 'name' }, toolLabel(p.toolName)),
      h('span', { class: 'review-time' }, fmtTime(p.at, false))),
    reviewSource(p),
    llm ? h('div', { class: 'req-desc' }, llm.summary) : null,
    p.status === 'analyzing'
      ? h('div', { class: 'review-loading', role: 'status' }, h('span', { class: 'review-spinner' }), 'モデルで中身を調べています。自動で許可できなければ、要約・接続先・自動で許可しなかった理由がここに出ます。待たずに答えることもできます')
      : null,
    reviewFacts(llm),
    p.hold?.length ? h('ul', { class: 'review-hold' }, p.hold.map((x) => h('li', {}, x))) : null,
    llm?.concerns ? h('div', { class: 'review-concerns' }, `確かめること: ${llm.concerns}`) : null,
    p.input?.description ? h('div', { class: 'req-label' }, `Claude による説明: ${p.input.description}`) : null,
    h('pre', { class: 'req-code' }, p.toolName === 'Bash' ? String(p.input?.command ?? '') : JSON.stringify(p.input, null, 2)),
    (a?.scripts ?? []).map((s) => h('details', {}, h('summary', {}, `スクリプトの中身: ${s.path}`), pre(s.text))),
    h('div', { class: 'req-actions' },
      h('button', { class: 'send', onclick: () => answerReview(p, { behavior: 'allow' }, card) }, '許可'),
      reason,
      h('button', { onclick: () => answerReview(p, { behavior: 'deny', message: reason.value.trim() }, card) }, '拒否')));
  return card;
}

function renderRecentReviews() {
  $('reviews-recent-list').replaceChildren(...reviews.recent.map((r) => h('li', { class: `review-by-${r.by}` },
    h('span', { class: 'review-time' }, fmtTime(r.at, false)),
    h('span', { class: 'review-by' }, r.byLabel),
    h('span', { class: 'review-session' }, titles.get(r.sessionId) ?? ''),
    h('span', { class: 'review-line', title: [r.command, ...(r.hold ?? [])].join('\n') }, r.summary ?? r.command))));
}

// ---------- ステータスライン ----------
const ANSI_BASIC = 16;

function ansi256(n) {
  if (n < 16) return null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

// SGR（\x1b[...m）だけを色や太字に置き換え、ほかの制御シーケンスは捨てる
function ansiToNodes(text) {
  const clean = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\d;?]*[A-Za-ln-z]/g, '');
  const out = [];
  let st = {};
  const push = (t) => {
    if (!t) return;
    const cls = [st.bold && 'a-bold', st.dim && 'a-dim', st.italic && 'a-italic', st.underline && 'a-underline',
      typeof st.fg === 'number' && st.fg < ANSI_BASIC && `a-fg${st.fg}`, typeof st.bg === 'number' && st.bg < ANSI_BASIC && `a-bg${st.bg}`].filter(Boolean).join(' ');
    const style = [typeof st.fg === 'string' && `color:${st.fg}`, typeof st.bg === 'string' && `background:${st.bg}`].filter(Boolean).join(';');
    out.push(cls || style ? h('span', { class: cls || null, style: style || null }, t) : document.createTextNode(t));
  };
  const color = (codes, i) => {
    if (codes[i + 1] === 5) return [codes[i + 2] < 16 ? codes[i + 2] : ansi256(codes[i + 2]), i + 2];
    if (codes[i + 1] === 2) return [`rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`, i + 4];
    return [undefined, i];
  };
  const re = /\x1b\[([\d;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(clean))) {
    push(clean.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c === 39) st.fg = undefined;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 49) st.bg = undefined;
      else if (c === 38) [st.fg, i] = color(codes, i);
      else if (c === 48) [st.bg, i] = color(codes, i);
    }
  }
  push(clean.slice(last));
  return out;
}

// ステータスラインのコマンドが設定されていないときに出す 1 行
function fallbackStatus(x) {
  const parts = [];
  if (x.model) parts.push(`${x.model.display_name}${x.effort ? `(${x.effort.level})` : ''}`);
  const rl = x.rate_limits;
  if (rl?.five_hour) parts.push(`5h:${Math.round(rl.five_hour.used_percentage)}%${rl.seven_day ? ` 7d:${Math.round(rl.seven_day.used_percentage)}%` : ''}`);
  const cw = x.context_window;
  if (cw) parts.push(`${Math.round(cw.total_input_tokens / 1000)}k/${Math.round(cw.context_window_size / 1000)}k ${Math.round(cw.used_percentage)}%`);
  if (x.cost?.total_lines_added != null) parts.push(`+${x.cost.total_lines_added} -${x.cost.total_lines_removed ?? 0}`);
  return parts.join(' │ ');
}

let statusSeq = 0;
async function loadStatus(id) {
  const seq = ++statusSeq;
  try {
    const res = await fetch(`/api/statusline?id=${encodeURIComponent(id)}`);
    if (!res.ok || seq !== statusSeq || state.s !== id) return;
    const d = await res.json();
    const box = $('statusline');
    if (d.mode === 'off') {
      box.replaceChildren();
      return;
    }
    box.title = d.command ? 'ステータスラインのコマンドの出力' : 'ビュワーが組み立てた 1 行';
    box.replaceChildren(...(d.command ? ansiToNodes((d.text ?? '').split('\n')[0]) : [fallbackStatus(d.input)]));
  } catch {}
}

function renderHead(d) {
  const s = d.session;
  const resume = `cd ${JSON.stringify(s.cwd ?? '.')} && claude --resume ${s.id}`;
  const btn = h('button', { onclick: (e) => copy(resume, e.currentTarget) }, 'コピー');
  const rows = [
    ['再開', h('code', {}, `claude --resume ${s.id}`), btn],
    ['期間', `${fmtRange(s.start, s.end)}　プロンプト ${s.prompts}・応答 ${s.turns}`],
    ['場所', h('code', {}, s.cwd ?? ''),
      s.lastCwd && s.lastCwd !== s.cwd ? [h('span', { class: 'cwd-now-label' }, '今は'), h('code', { class: 'cwd-now-path' }, cwdLabel(s.lastCwd, s.cwd))] : null],
  ];
  if (s.repos.length || s.branches.length) {
    rows.push(['リポジトリ',
      s.repos.map((r) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); addFilter('repo', r); } }, r.replace(/^local:/, ''))),
      s.branches.map((b) => h('span', { class: 'badge' }, b))]);
  }
  // このセッションで出したものと、最初のプロンプトにあった依頼元は、ほかに触れたものと分けて出す
  const refLinks = (list) => list.map((r) => h('a', { href: refUrl(r.ref, r.kind), target: '_blank', rel: 'noreferrer' },
    `${r.kind === 'pr' ? 'PR' : 'Issue'} ${r.ref}`));
  const created = s.refs.filter((r) => r.role === 'created');
  const prompted = s.refs.filter((r) => r.role === 'prompt');
  const others = s.refs.filter((r) => !r.role);
  if (created.length) rows.push(['出した', refLinks(created)]);
  if (prompted.length) rows.push(['依頼元', refLinks(prompted)]);
  if (others.length) rows.push([created.length || prompted.length ? 'ほかの Issue・PR' : 'Issue・PR', refLinks(others)]);
  const files = d.files.write.length + d.files.read.length;
  if (files) {
    const fileItem = (f, cls) => h('li', { class: cls }, h('a', { href: '#', title: 'ビュワーで開く', onclick: (e) => { e.preventDefault(); openFile(f); } }, f));
    const ul = h('ul', {},
      d.files.write.map((f) => fileItem(f, 'w')),
      d.files.read.filter((f) => !d.files.write.includes(f)).map((f) => fileItem(f, 'r')));
    rows.push(['ファイル', h('details', { class: 'files' }, h('summary', {}, `書いた ${d.files.write.length}・読んだ ${d.files.read.length}`), ul)]);
  }
  const title = s.title || s.firstPrompt?.slice(0, 80) || s.id;
  const titleEl = h('span', { class: 'head-title', title: TITLE_BY_LABELS[s.titleBy] ?? '' }, title);
  $('session-head').replaceChildren(
    h('h2', {}, h('button', { class: 'bm-btn', id: 'head-bm' }), titleEl, titleTools(s, titleEl)),
    h('dl', { class: 'head-grid' }, rows.flatMap(([k, ...v]) => [h('dt', {}, k), h('dd', {}, ...v)])),
  );
  $('tb-title-text').textContent = title;
  $('tb-title-text').title = title;
  renderBookmarkButtons();
}

// ---------- タイトルの書き換え ----------
const TITLE_BY_LABELS = { viewer: 'ビュワーで付けたタイトル', custom: '/rename などで付けたタイトル', ai: 'Claude Code が付けたタイトル' };

async function saveTitle(id, url, body, tools) {
  for (const b of tools.querySelectorAll('button')) b.disabled = true;
  tools.querySelector('.title-error')?.remove();
  try {
    const d = await postJson(url, { id, ...body });
    if (current?.session.id === id) {
      current.session.title = d.title;
      current.session.titleBy = d.titleBy;
      renderHead(current);
    }
    titles.set(id, d.title || current?.session.firstPrompt || 'セッション');
    loadList();
  } catch (e) {
    if (current?.session.id !== id) return;
    renderHead(current);
    document.querySelector('#session-head .title-tools')?.append(h('span', { class: 'title-error' }, e.message));
  }
}

function editTitle(s, titleEl, tools) {
  const input = h('input', { type: 'text', class: 'title-input', value: s.title ?? '', placeholder: '空にすると Claude Code のタイトルに戻します', maxlength: 200 });
  const done = () => renderHead(current);
  const save = () => saveTitle(s.id, '/api/title', { title: input.value }, tools);
  // 文書全体のキー操作（Esc で送信を取り消すなど）に渡さない
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    e.stopPropagation();
  });
  titleEl.replaceWith(input);
  tools.replaceChildren(
    h('button', { class: 'send', onclick: save }, '保存'),
    h('button', { onclick: done }, '取り消す'));
  input.focus();
  input.select();
}

function titleTools(s, titleEl) {
  const tools = h('span', { class: 'title-tools' });
  tools.append(
    h('button', { title: 'タイトルを書き換える。ビュワーの中だけで使い、Claude Code の会話ログには書きません', onclick: () => editTitle(s, titleEl, tools) }, '書き換える'),
    h('button', {
      title: '会話の中身からモデル（haiku）にタイトルを付け直させます',
      onclick: (e) => {
        e.currentTarget.textContent = '付け直しています…';
        saveTitle(s.id, '/api/title/generate', {}, tools);
      },
    }, 'AI で付け直す'),
    s.titleBy === 'viewer' ? h('button', { title: 'ビュワーで付けたタイトルを消して、Claude Code のタイトルに戻します', onclick: () => saveTitle(s.id, '/api/title', { title: '' }, tools) }, '元に戻す') : null);
  return tools;
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

// cd で移った先を、始めたディレクトリからの相対で出す
function cwdLabel(p, base) {
  if (base && p === base) return `${p}（始めたディレクトリ）`;
  return base && p.startsWith(`${base}/`) ? `./${p.slice(base.length + 1)}` : p;
}

// 送る前に、Claude が最後にいたディレクトリが始めたディレクトリと違うことに気づけるようにする
function renderCwdNow() {
  const s = current?.session;
  const moved = !!(s?.lastCwd && s.cwd && s.lastCwd !== s.cwd);
  $('cwd-now').hidden = !moved;
  $('cwd-now').replaceChildren(...(moved ? ['作業ディレクトリ: ', h('code', {}, cwdLabel(s.lastCwd, s.cwd)), `（始めたのは ${s.cwd}）`] : []));
  $('cwd-now').title = moved ? 'Bash の cd で移っています。ビュワーから続きを送ると、Claude は始めたディレクトリで動き出します' : '';
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

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function toolBody(ev, cwd) {
  const i = ev.input ?? {};
  const body = h('div', { class: 'tool-body' });
  const filePath = FILE_TOOLS.has(ev.name) ? i.file_path ?? i.notebook_path : null;
  if (filePath) {
    // Edit なら書き換えた後の文字列のところを開く
    const find = ev.name === 'Edit' ? i.new_string : ev.name === 'MultiEdit' ? i.edits?.[0]?.new_string : null;
    // 消すだけの Edit は書いた文字列が空なので、印を付けずに開く
    body.append(h('button', { class: 'open-file', onclick: () => openFile(filePath, find || null) }, 'ファイルの今の中身を開く'));
  }
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
      // 動いている途中は結果が無く agentId も無いので、サブエージェントのログの meta.json から引く
      const agentId = ev.agentId ?? current?.agents?.find((a) => a.toolUseId === ev.id)?.agentId;
      if (agentId && current) {
        const box = h('div', { class: 'subagent' });
        box.dataset.agentId = agentId;
        const btn = h('button', {
          class: 'subagent-open',
          onclick: async () => {
            btn.disabled = true;
            const res = await fetch(`/api/agent?session=${encodeURIComponent(current.session.id)}&agent=${encodeURIComponent(agentId)}`);
            if (!res.ok) { btn.textContent = 'ログが見つかりません'; return; }
            const d = await res.json();
            btn.remove();
            box.classList.add('loaded');
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

function renderEvent(ev, cwd, nested = false) {
  const cat = eventCategory(ev);
  const el = h('div', { class: `ev ev-${cat}` });
  if (ev.uuid) el.dataset.uuid = ev.uuid;
  if (ev.kind === 'rewind') {
    const n = ev.dropped.filter((e) => e.kind === 'user').length;
    const box = h('div', { class: 'rewind-dropped' });
    const details = h('details', {}, h('summary', {}, `取り消したやり取りを見る（発言 ${n} 件）`), box);
    details.addEventListener('toggle', () => {
      if (details.open && !box.childElementCount) renderEvents(box, ev.dropped, cwd, true);
    });
    el.append(h('div', { class: 'ev-label' }, h('span', {}, '巻き戻し'), h('span', {}, fmtTime(ev.ts))),
      h('div', { class: 'body' }, `「${ev.text.split('\n')[0].slice(0, 80)}」から先を巻き戻しました。Claude にはここより後のやり取りが見えていません`),
      details);
    return el;
  }
  if (ev.kind === 'cwd') {
    el.title = `${ev.from} から移りました`;
    el.append(h('span', { class: 'cwd-label' }, '作業ディレクトリ →'), h('code', {}, cwdLabel(ev.text, cwd)), h('span', { class: 'ev-label' }, fmtTime(ev.ts, false)));
    return el;
  }
  if (ev.kind === 'tool') {
    const name = ev.category === 'mcp' ? `${ev.server} / ${ev.name.split('__').slice(2).join('__')}` : ev.name;
    const details = h('details', { class: 'tool' },
      h('summary', {},
        h('span', { class: 'name' }, name),
        h('span', { class: 'sum' }, toolSummary(ev, cwd)),
        ev.isError ? h('span', { class: 'err' }, 'エラー') : null,
        h('span', { class: 'ev-label' }, fmtTime(ev.ts, false))));
    if (ev.id) details.dataset.id = ev.id;
    details._ev = ev;
    details._render = () => {
      if (details.dataset.rendered) return;
      details.dataset.rendered = '1';
      const b = toolBody(ev, cwd);
      if (details._decision) details.append(decisionBlock(details._decision));
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
  // 巻き戻せるのは本体の会話の、ユーザーが送った発言だけ
  const canRewind = !nested && ev.kind === 'user' && !ev.queued && ev.uuid;
  el.append(h('div', { class: 'ev-label' }, h('span', {}, label), h('span', {}, fmtTime(ev.ts)),
    canRewind ? h('button', { class: 'rewind-btn', title: 'この発言より前に会話を戻し、この発言を入力欄に戻します', onclick: () => openRewind(ev) }, 'ここから巻き戻す') : null));
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
    const el = renderEvent(ev, cwd, nested);
    items.push({ ev, el, text: searchableText(ev) });
    frag.append(el);
  }
  container.replaceChildren(frag);
  if (!nested) container._items = items;
  applyDecisionBadges();
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
const drafts = new Map();

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function loadRunner(id) {
  const res = await fetch(`/api/runner?id=${encodeURIComponent(id)}`);
  if (!res.ok || state.s !== id) return;
  runner = await res.json();
  if (sendErrors.has(id)) {
    runner.error = sendErrors.get(id);
    sendErrors.delete(id);
  }
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

function viaTmuxFor(r) {
  return !!(r?.elsewhere?.tmux && !r.alive);
}

function renderRunner() {
  const r = runner ?? { pending: [] };
  // ターミナルの tmux の中で開いているセッションには、tmux のキー入力として送れる（試験中）
  const viaTmux = viaTmuxFor(r);
  const blocked = !!r.elsewhere && !r.alive && !viaTmux;
  $('composer').classList.toggle('via-tmux', viaTmux);
  $('runner-note').hidden = !viaTmux;
  $('runner-note').textContent = viaTmux
    ? 'ターミナルの tmux で開いているセッションです（試験中）。送った文はターミナルの入力欄に貼り付けて送ります。確認や質問にはターミナルで答えてください。止めるも使えません'
    : '';
  const o = outgoings.get(state.s);
  $('send').disabled = !!(o && o.phase !== 'sent') || r.running || r.pending.length > 0 || blocked;
  const working = !!(r.alive && (r.running || r.pending.length));
  $('stop').disabled = !working;
  $('wake').hidden = !!r.alive || viaTmux || blocked || !current;
  if (!working) disarmStop();
  // プロセスがまだ無いときは、次に起動するときのモード（会話ログから引き継ぐもの）を出す
  const mode = r.mode ?? current?.session.permissionMode ?? 'default';
  const asking = r.pending.some((p) => p.status !== 'analyzing');
  const status = viaTmux ? 'ターミナル（tmux）' : asking ? '確認待ち' : r.pending.length ? 'AI が確認中' : r.running ? 'Claude が作業中…' : r.alive ? '待機中' : '停止中';
  $('runner-state').textContent = `${status}・${mode}`;
  $('runner-state').title = `権限モード: ${mode}`;
  $('runner-state').classList.toggle('busy', !!r.running);
  const error = blocked
    ? `このセッションは別のプロセス（PID ${r.elsewhere.pid}${r.elsewhere.kind ? `・${r.elsewhere.kind}` : ''}）で開かれているので、ここからは送れません。そちらを閉じると送れるようになります`
    : r.error;
  $('runner-error').hidden = !error;
  $('runner-error').textContent = error ?? '';
  renderPending();
}

// ビュワーで動かしている claude の確認と、ターミナルから hook で届いた確認を同じ場所に出す
function renderPending() {
  const box = $('pending');
  const list = runner?.pending ?? [];
  const fromHook = state.s ? reviewsFor(state.s) : [];
  // 答えを入力している途中のカードを作り直さないように、確認の組み合わせか状態が変わったときだけ描き直す
  const key = [...list.map((p) => `${p.requestId}:${p.status}`), ...fromHook.map((p) => `${p.id}:${p.status}`)].join(',');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  // 調べ終わるとカードを作り直すので、それまでに打っていた拒否の理由と入力中の位置を引き継ぐ
  const typed = new Map([...box.querySelectorAll('input[data-review]')].map((el) => [el.dataset.review, el.value]));
  const focused = document.activeElement?.dataset?.review;
  box.replaceChildren(
    ...list.map((p) => (p.toolName === 'AskUserQuestion' ? questionCard(p) : permissionCard(p))),
    ...fromHook.map(reviewCard));
  for (const el of box.querySelectorAll('input[data-review]')) {
    el.value = typed.get(el.dataset.review) ?? '';
    if (el.dataset.review === focused) el.focus();
  }
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
  const reason = h('input', { type: 'text', class: 'deny-reason', 'data-review': p.requestId, placeholder: '拒否の理由（Claude に伝わります・省略可）' });
  const d = requestDetail(p);
  const llm = p.analysis?.llm;
  // AI の判定にかけたものは、hook から届いた確認と同じ見た目にする
  const judged = p.status === 'analyzing' || p.analysis || p.hold;
  const kind = p.status === 'analyzing' ? '許可の確認・AI が確認中' : judged ? '許可の確認・あなたの答えを待っています' : '許可の確認';
  const card = h('div', { class: `req-card${judged ? ` review-card ${p.status === 'analyzing' ? 'checking' : p.level || 'caution'}` : ''}` },
    h('div', { class: 'req-head' }, h('span', { class: 'req-kind' }, kind), h('span', { class: 'name' }, toolLabel(p.toolName))),
    llm ? h('div', { class: 'req-desc' }, llm.summary) : null,
    p.status === 'analyzing'
      ? h('div', { class: 'review-loading', role: 'status' }, h('span', { class: 'review-spinner' }), 'モデルで中身を調べています。人に回すものだけ、ここに理由が出ます。待たずに答えることもできます')
      : null,
    reviewFacts(llm),
    p.hold?.length ? h('ul', { class: 'review-hold' }, p.hold.map((x) => h('li', {}, x))) : null,
    llm?.concerns ? h('div', { class: 'review-concerns' }, `確かめること: ${llm.concerns}`) : null,
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

// ---------- 送信を待つ ----------
// 送ったメッセージは会話ログに書かれた時点で取り消せないので、送る前に少し待って取り消せるようにする
const SEND_DELAY_KEY = 'send-delay';
const SEND_DELAY_DEFAULT = 2;
const SEND_DELAY_MAX = 30;
// 会話ログに書かれないまま反映待ちの表示が残り続けないように、ここで諦める
const SETTLE_GIVE_UP_MS = 60000;
// 送信待ちの間に別のセッションへ移っても送れるように、セッションごとに持つ
const outgoings = new Map(); // id → { id, text, phase: 'waiting' | 'sending' | 'sent', until, timer, sentAt }
// 開いていないセッションへの送信に失敗したときは、そのセッションを開いたときに出す
const sendErrors = new Map();
let outgoingTick = null;

function sendDelay() {
  try {
    const raw = localStorage.getItem(SEND_DELAY_KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? Math.min(SEND_DELAY_MAX, Math.max(0, v)) : SEND_DELAY_DEFAULT;
  } catch {
    return SEND_DELAY_DEFAULT;
  }
}

function sendMessage() {
  const text = $('msg').value.trim();
  if (!text || !state.s || $('send').disabled) return;
  const id = state.s;
  const delay = sendDelay() * 1000;
  $('msg').value = '';
  drafts.delete(id);
  const o = { id, text, phase: 'waiting', until: Date.now() + delay };
  o.timer = setTimeout(() => postOutgoing(o), delay);
  outgoings.set(id, o);
  renderOutgoing();
  renderRunner();
  const box = $('events');
  box.scrollTop = box.scrollHeight;
}

// tmux で送るかどうかは、送る先のセッションの状態で決める。表示中のセッションの状態で決めると、移った先によって送り方を間違える
async function runnerFor(id) {
  if (id === state.s && runner) return runner;
  const res = await fetch(`/api/runner?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postOutgoing(o) {
  if (outgoings.get(o.id) !== o || o.phase !== 'waiting') return;
  o.phase = 'sending';
  renderOutgoing();
  try {
    const viaTmux = viaTmuxFor(await runnerFor(o.id));
    const s = await postJson(viaTmux ? '/api/runner/send-tmux' : '/api/runner/send', { id: o.id, text: o.text });
    o.phase = 'sent';
    o.sentAt = Date.now();
    setTimeout(() => { if (outgoings.get(o.id) === o) { outgoings.delete(o.id); renderOutgoing(); } }, SETTLE_GIVE_UP_MS);
    setRunner(s);
  } catch (e) {
    if (outgoings.get(o.id) === o) outgoings.delete(o.id);
    restoreText(o);
    const message = e.data?.screen ? `${e.message}\n\nターミナルの画面:\n${e.data.screen}` : e.message;
    if (o.id === state.s) showRunnerError(message);
    else sendErrors.set(o.id, `送れませんでした。文面は入力欄に戻しています: ${message}`);
  }
  renderOutgoing();
  renderRunner();
}

// 取り消した文面は入力欄に戻す。書きかけがあれば、その前に置く
function restoreText(o) {
  if (state.s === o.id) {
    const cur = $('msg').value.trim();
    $('msg').value = cur ? `${o.text}\n${cur}` : o.text;
  } else {
    drafts.set(o.id, o.text);
  }
}

// 取り消せるのは、表示中のセッションの吹き出しだけ。見えていないものを Esc で取り消さない
function cancelOutgoing() {
  const o = outgoings.get(state.s);
  if (!o || o.phase !== 'waiting') return false;
  clearTimeout(o.timer);
  outgoings.delete(o.id);
  restoreText(o);
  renderOutgoing();
  renderRunner();
  if (state.s === o.id) $('msg').focus();
  return true;
}

// 会話ログに同じメッセージが書かれたら、仮の表示を本物に任せる
function settleOutgoing(id, events) {
  const o = outgoings.get(id);
  if (o?.phase === 'sent' && events.some((e) => e.kind === 'user' && Date.parse(e.ts) >= o.sentAt - 5000 && (e.text ?? '').trim() === o.text)) {
    outgoings.delete(id);
  }
  renderOutgoing();
}

function renderOutgoing() {
  $('events').querySelector('.ev-outgoing')?.remove();
  clearInterval(outgoingTick);
  const o = outgoings.get(state.s);
  if (!o) return;
  const label = h('span', {});
  const cancel = o.phase === 'waiting' ? h('button', { class: 'outgoing-cancel', onclick: cancelOutgoing }, '取り消す') : null;
  const el = h('div', { class: `ev ev-user ev-outgoing ${o.phase}` },
    h('div', { class: 'ev-label' }, label, cancel),
    h('div', { class: 'body' }, o.text));
  const tick = () => {
    if (o.phase === 'waiting') label.textContent = `ユーザー（送信待ち・あと ${Math.max(0, (o.until - Date.now()) / 1000).toFixed(1)} 秒）`;
    else label.textContent = o.phase === 'sending' ? 'ユーザー（送信中…）' : 'ユーザー（送信済み・反映待ち）';
  };
  tick();
  if (o.phase === 'waiting') outgoingTick = setInterval(tick, 100);
  $('events').append(el);
}

// 割り込みは作業を打ち切るので、1 回目は構えるだけにして、続けてもう 1 回押したときだけ送る
const STOP_ARM_MS = 3000;
let stopArmed = null;

function disarmStop() {
  clearTimeout(stopArmed);
  stopArmed = null;
  $('stop').classList.remove('armed');
  $('stop').textContent = '止める';
}

async function stopRunner() {
  if ($('stop').disabled) return;
  if (!stopArmed) {
    $('stop').classList.add('armed');
    $('stop').textContent = 'もう一度で中断';
    stopArmed = setTimeout(disarmStop, STOP_ARM_MS);
    return;
  }
  disarmStop();
  try {
    setRunner(await postJson('/api/runner/interrupt', { id: state.s }));
  } catch (e) {
    showRunnerError(e.message);
  }
}

// ---------- ファイルを開く ----------
// セッションで読み書きしたファイルの今の中身を出す。find があれば、そこまで送って印を付ける
let fileSeq = 0;

async function openFile(p, find = null) {
  const id = current?.session.id;
  if (!id) return;
  const seq = ++fileSeq;
  $('file-path').textContent = p;
  $('file-meta').textContent = '読み込み中…';
  $('file-body').replaceChildren();
  $('file-copy').onclick = (e) => copy(p, e.currentTarget);
  if (!$('file-dialog').open) $('file-dialog').showModal();
  let f;
  try {
    const res = await fetch(`/api/file?session=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`);
    f = await res.json();
    if (!res.ok) throw new Error(f.error ?? `HTTP ${res.status}`);
  } catch (e) {
    if (seq === fileSeq) $('file-meta').textContent = e.message;
    return;
  }
  if (seq !== fileSeq) return;
  const lines = f.text == null ? 0 : f.text.split('\n').length;
  $('file-meta').textContent = [`${f.size.toLocaleString()} バイト`, f.text != null ? `${lines.toLocaleString()} 行` : null, `${fmtTime(f.mtime)} に更新`,
    f.truncated ? '長いので先頭 1MB だけ出しています' : null].filter(Boolean).join('・');
  if (f.binary) {
    $('file-body').replaceChildren(h('div', { class: 'empty-note' }, 'テキストではないファイルなので、中身は出しません'));
    return;
  }
  const at = find ? f.text.indexOf(find) : -1;
  const code = h('pre', { class: 'file-code' }, ...(at < 0 ? [f.text] : [f.text.slice(0, at), h('mark', {}, find), f.text.slice(at + find.length)]));
  const gutter = h('pre', { class: 'file-gutter', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, n) => n + 1).join('\n'));
  $('file-body').replaceChildren(gutter, code);
  if (at >= 0) code.querySelector('mark').scrollIntoView({ block: 'center' });
  else if (find) $('file-meta').textContent += '・Edit で書いた文字列は、今の中身には見つかりません';
}

// ---------- 巻き戻し ----------
let rewindTarget = null; // { id, uuid }

async function openRewind(ev) {
  if (!state.s) return;
  const target = { id: state.s, uuid: ev.uuid };
  rewindTarget = target;
  $('rewind-prompt').textContent = ev.text ?? '';
  $('rewind-files').replaceChildren('ファイルの記録を調べています…（claude を起動します）');
  $('rewind-error').hidden = true;
  $('rewind-conv').disabled = false;
  $('rewind-all').disabled = true;
  $('rewind-dialog').showModal();
  try {
    const d = await postJson('/api/runner/rewind', { ...target, dryRun: true });
    if (rewindTarget === target) renderRewindFiles(d.files);
  } catch (e) {
    if (rewindTarget !== target) return;
    $('rewind-files').replaceChildren();
    showRewindError(e.message);
  }
}

function renderRewindFiles(f) {
  const box = $('rewind-files');
  if (!f?.canRewind) return box.replaceChildren(`ファイルは戻せません（${f?.error ?? '理由が分かりません'}）。会話だけ戻せます`);
  const list = f.filesChanged ?? [];
  if (!list.length) return box.replaceChildren('この発言より後に Claude が変えたファイルはありません');
  box.replaceChildren(
    h('div', {}, `「会話とファイルを戻す」では、次の ${list.length} 個のファイルをこの発言の時点に戻します（+${f.insertions ?? 0} -${f.deletions ?? 0} 行）。Claude 以外が変えた分も上書きします`),
    h('ul', {}, list.map((x) => h('li', {}, shortPath(x, current?.session.cwd)))));
  $('rewind-all').disabled = false;
}

function showRewindError(message) {
  $('rewind-error').hidden = false;
  $('rewind-error').textContent = message;
}

async function runRewind(files) {
  const target = rewindTarget;
  if (!target) return;
  for (const id of ['rewind-conv', 'rewind-all']) $(id).disabled = true;
  try {
    const d = await postJson('/api/runner/rewind', { ...target, files });
    $('rewind-dialog').close();
    rewindTarget = null;
    // Claude Code と同じく、巻き戻した発言を入力欄に戻す。書きかけがあれば後ろに残す
    if (state.s === target.id) {
      const cur = $('msg').value.trim();
      $('msg').value = cur ? `${d.prefillText}\n${cur}` : d.prefillText;
      $('msg').focus();
    } else {
      drafts.set(target.id, d.prefillText);
    }
    if (state.s === target.id) await openSession(target.id, { reload: true });
  } catch (e) {
    showRewindError(e.message);
    $('rewind-conv').disabled = false;
  }
}

async function wakeRunner() {
  if (!state.s || $('wake').disabled) return;
  $('wake').disabled = true;
  try {
    setRunner(await postJson('/api/runner/wake', { id: state.s }));
  } catch (e) {
    showRunnerError(e.message);
  }
  renderRunner();
}

// ---------- / と @ の候補 ----------
// 先頭の / はコマンド、空白の後ろの @ はファイル。カーソルの前にある書きかけの語を見る
const suggestState = { kind: null, start: 0, items: [], index: 0, seq: 0 };

function suggestTarget(el) {
  const before = el.value.slice(0, el.selectionStart);
  if (el.selectionStart !== el.selectionEnd) return null;
  const slash = before.match(/^\/(\S*)$/);
  if (slash) return { kind: 'slash', start: 0, q: slash[1] };
  const at = before.match(/(^|\s)@(\S*)$/);
  if (at) return { kind: 'at', start: before.length - at[2].length - 1, q: at[2] };
  return null;
}

function closeSuggest() {
  suggestState.kind = null;
  suggestState.seq++;
  $('suggest').hidden = true;
}

const updateSuggest = debounce(async () => {
  const el = $('msg');
  const t = state.s && document.activeElement === el ? suggestTarget(el) : null;
  if (!t) return closeSuggest();
  const seq = ++suggestState.seq;
  let d;
  try {
    d = await (await fetch(`/api/suggest?id=${encodeURIComponent(state.s)}&kind=${t.kind}&q=${encodeURIComponent(t.q)}`)).json();
  } catch {
    return;
  }
  if (seq !== suggestState.seq) return;
  if (!d.items?.length) return closeSuggest();
  Object.assign(suggestState, { kind: t.kind, start: t.start, items: d.items, index: 0, source: d.source });
  renderSuggest();
}, 120);

function renderSuggest() {
  const box = $('suggest');
  box.hidden = false;
  const note = suggestState.kind === 'slash' && suggestState.source === 'files'
    ? h('li', { class: 'suggest-note' }, 'ビュワーから一度送ると、組み込みのコマンドとプラグインのものも出ます')
    : null;
  box.replaceChildren(...suggestState.items.map((x, i) => h('li', {
    class: i === suggestState.index ? 'on' : '',
    // 入力欄からフォーカスを外さずに選ぶ
    onmousedown: (e) => { e.preventDefault(); acceptSuggest(i); },
  },
  h('span', { class: 'suggest-name' }, `${suggestState.kind === 'slash' ? '/' : '@'}${x.name}`),
  x.argumentHint ? h('span', { class: 'suggest-hint' }, x.argumentHint) : null,
  x.description ? h('span', { class: 'suggest-desc' }, x.description) : null)), ...(note ? [note] : []));
  box.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
}

function acceptSuggest(i = suggestState.index) {
  const x = suggestState.items[i];
  const el = $('msg');
  if (!x) return;
  const word = `${suggestState.kind === 'slash' ? '/' : '@'}${x.name}`;
  // ディレクトリを選んだときは、続けてその中を選べるように空白を足さない
  const insert = suggestState.kind === 'at' && x.name.endsWith('/') ? word : `${word} `;
  el.setRangeText(insert, suggestState.start, el.selectionStart, 'end');
  closeSuggest();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// 候補が出ている間の上下・Enter・Tab・Esc は、文書全体のキー操作（送信など）より先に受ける
function onSuggestKey(e) {
  if ($('suggest').hidden || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = suggestState.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    suggestState.index = (suggestState.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSuggest();
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    acceptSuggest();
  } else if (e.key === 'Escape') {
    closeSuggest();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ---------- 新規チャット ----------
const NEW_PREFS = 'new-session';

function loadNewPrefs() {
  try {
    return JSON.parse(localStorage.getItem(NEW_PREFS)) ?? {};
  } catch {
    return {};
  }
}

async function openNew() {
  const prefs = loadNewPrefs();
  // 開いているセッションがあれば、その作業ディレクトリを初めから入れておく
  $('new-cwd').value = current?.session.cwd ?? prefs.cwd ?? '';
  $('new-mode').value = prefs.mode ?? 'default';
  $('new-error').hidden = true;
  $('new-create').disabled = false;
  $('new-dialog').showModal();
  $('new-text').focus();
  try {
    const cwds = await (await fetch('/api/cwds')).json();
    $('cwd-list').replaceChildren(...cwds.map((c) => h('option', { value: c })));
  } catch {}
}

async function createSession() {
  const cwd = $('new-cwd').value.trim();
  const text = $('new-text').value.trim();
  const mode = $('new-mode').value;
  if (!cwd || !text || $('new-create').disabled) return;
  $('new-create').disabled = true;
  try {
    const s = await postJson('/api/runner/new', { cwd, text, permissionMode: mode });
    try {
      localStorage.setItem(NEW_PREFS, JSON.stringify({ cwd, mode }));
    } catch {}
    $('new-text').value = '';
    $('new-dialog').close();
    showNewSession(s, cwd);
  } catch (e) {
    $('new-error').hidden = false;
    $('new-error').textContent = e.message;
    $('new-create').disabled = false;
  }
}

// 会話ログが書かれるまでは一覧に無いので、仮の表示を出して書かれるのを待つ
async function showNewSession(s, cwd) {
  if (state.s) drafts.set(state.s, $('msg').value);
  $('msg').value = '';
  current = null;
  renderCwdNow();
  state.s = s.id;
  writeHash();
  showView('session');
  $('session-head').replaceChildren(h('h2', {}, h('span', {}, '新しいセッション')), h('dl', { class: 'head-grid' }, h('dt', {}, '場所'), h('dd', {}, h('code', {}, cwd))));
  $('tb-title-text').textContent = '新しいセッション';
  $('events').replaceChildren(h('div', { class: 'empty-note' }, 'Claude が会話ログを書き始めると、ここに表示されます'));
  runner = s;
  renderRunner();
  loadMemo(s.id);
  for (let i = 0; i < 60 && state.s === s.id; i++) {
    const res = await fetch(`/api/session?id=${encodeURIComponent(s.id)}`);
    if (res.ok) {
      await openSession(s.id);
      loadList();
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
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
      // 新規チャットの画面では、メッセージ欄での送信と改行だけを受ける
      if ($('new-dialog').open) return new Set(el === $('new-text') ? ['composer'] : []);
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName);
      const places = new Set(['any']);
      if (!typing) places.add('global');
      if (el === $('msg')) places.add('composer');
      if (el === $('find')) places.add('find');
      return places;
    },
    handlers: {
      'composer.send': () => { if ($('new-dialog').open) createSession(); else sendMessage(); },
      'composer.newline': () => { insertNewline(document.activeElement); },
      'session.new': () => { openNew(); },
      'runner.interrupt': () => {
        if ($('stop').disabled) return false;
        stopRunner();
      },
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
      'composer.cancelSend': () => {
        if (!cancelOutgoing()) return false;
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
      'keys.open': () => { openSettings(); },
    },
  });
  renderKeyHints();
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  for (const b of document.querySelectorAll('.settings-tabs [data-tab]')) b.addEventListener('click', () => showSettingsTab(b.dataset.tab));
  $('sl-save').addEventListener('click', saveStatusSettings);
  $('hide-save').addEventListener('click', saveHideSettings);
  $('review-save').addEventListener('click', saveReviewSettings);
  $('send-delay').addEventListener('change', () => {
    const v = Number($('send-delay').value);
    if (!Number.isFinite(v)) return;
    try {
      localStorage.setItem(SEND_DELAY_KEY, String(Math.min(SEND_DELAY_MAX, Math.max(0, v))));
    } catch {}
    $('send-delay').value = sendDelay();
  });
  $('sl-command').addEventListener('input', () => { document.querySelector('input[name="sl-mode"][value="command"]').checked = true; });
  $('open-new').addEventListener('click', openNew);
  $('notify').addEventListener('click', toggleNotify);
  renderNotifyButton();
  saveRead();
  // 残り時間などが進むので、表に出ている間はときどき出し直す
  setInterval(() => { if (state.s && !document.hidden) loadStatus(state.s); }, 30000);
  // 経過時間を進める。書き足しが無くても、10 分たって止まったものは終わった扱いになるので取り直す
  setInterval(() => { if (state.s && !document.hidden && !$('agents-bar').hidden) loadAgents(state.s); }, 5000);
  $('new-close').addEventListener('click', () => $('new-dialog').close());
  $('new-create').addEventListener('click', createSession);
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
  $('open-settings').title = title('キー操作・通知・ステータスライン・非表示の設定', 'keys.open');
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

// ---------- 設定画面 ----------
const SETTINGS_TAB = 'settings-tab';

function showSettingsTab(tab) {
  for (const b of document.querySelectorAll('.settings-tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll('.settings-panel')) p.hidden = p.dataset.panel !== tab;
  try {
    localStorage.setItem(SETTINGS_TAB, tab);
  } catch {}
}

function openSettings() {
  $('keys-text').value = loadUserText();
  showKeyErrors(keymap.get().errors);
  renderKeyRows();
  renderNotifyButton();
  loadStatusSettings();
  loadHideSettings();
  loadHiddenList();
  loadReviewSettings();
  $('send-delay').value = sendDelay();
  let tab = 'keys';
  try {
    tab = localStorage.getItem(SETTINGS_TAB) ?? 'keys';
  } catch {}
  showSettingsTab(tab);
  $('settings-dialog').showModal();
}

function renderStatusSettings(d) {
  for (const r of document.querySelectorAll('input[name="sl-mode"]')) r.checked = r.value === d.statusLine.mode;
  $('sl-command').value = d.statusLine.command ?? '';
  $('sl-claude').textContent = d.claudeStatusCommand ?? '（~/.claude/settings.json に statusLine がありません）';
}

async function loadStatusSettings() {
  try {
    renderStatusSettings(await (await fetch('/api/settings')).json());
  } catch {}
}

function renderHideSettings(d) {
  $('hide-title').value = d.hideRules.title.join('\n');
  $('hide-text').value = d.hideRules.text.join('\n');
  $('hide-dirs').value = (d.hideRules.dirs ?? []).join('\n');
  $('hide-empty').checked = d.hideRules.empty;
}

async function loadHideSettings() {
  try {
    renderHideSettings(await (await fetch('/api/settings')).json());
  } catch {}
}

async function loadHiddenList() {
  let list;
  try {
    list = await (await fetch('/api/hidden')).json();
  } catch {
    return;
  }
  if (!list.length) {
    $('hidden-list').replaceChildren(h('li', { class: 'none' }, '「隠す」で隠したセッションはありません'));
    return;
  }
  $('hidden-list').replaceChildren(...list.map((x) => h('li', {},
    x.exists
      ? h('button', { class: 'hidden-title', title: '開く', onclick: () => { $('settings-dialog').close(); selectSession(x.id); } }, x.title ?? '(プロンプトなし)')
      : h('span', { class: 'hidden-title gone', title: x.id }, '（会話ログが見つかりません）'),
    h('span', { class: 'hidden-at', title: x.end ? `最後の更新 ${fmtTime(x.end)}` : '' }, x.at ? `${fmtTime(x.at)} に隠した` : ''),
    h('button', { class: 'side-btn', onclick: () => toggleHidden(x.id, false) }, '戻す'))));
}

const CONDITION_GROUPS = [['command', 'コマンドの中身で決める'], ['host', 'つなぐ先で決める'], ['model', 'モデルの判定で決める']];

function renderReviewSettings(d) {
  const r = d.review;
  $('review-hook').textContent = d.hookCommand;
  $('review-enabled').checked = r.enabled;
  $('review-auto').checked = r.autoAllow;
  $('review-model').value = r.model;
  $('review-conditions').replaceChildren(...CONDITION_GROUPS.map(([group, title]) => h('fieldset', { class: 'review-conditions' },
    h('legend', {}, title),
    d.reviewConditions.filter((c) => c.group === group).map((c) => h('label', { class: 'settings-check' },
      h('input', { type: 'checkbox', 'data-condition': c.id, checked: r.conditions[c.id] ?? c.on }),
      ` ${c.label}`)))));
}

async function loadReviewSettings() {
  renderRecentReviews();
  try {
    renderReviewSettings(await (await fetch('/api/settings')).json());
  } catch {}
}

async function saveReviewSettings() {
  const conditions = {};
  for (const el of document.querySelectorAll('#review-conditions [data-condition]')) conditions[el.dataset.condition] = el.checked;
  $('review-error').hidden = true;
  try {
    renderReviewSettings(await postJson('/api/settings', {
      review: { enabled: $('review-enabled').checked, autoAllow: $('review-auto').checked, model: $('review-model').value, conditions },
    }));
  } catch (e) {
    $('review-error').hidden = false;
    $('review-error').textContent = e.message;
  }
}

async function saveHideSettings() {
  const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
  $('hide-error').hidden = true;
  try {
    renderHideSettings(await postJson('/api/settings', { hideRules: { title: lines('hide-title'), text: lines('hide-text'), dirs: lines('hide-dirs'), empty: $('hide-empty').checked } }));
    loadList();
  } catch (e) {
    $('hide-error').hidden = false;
    $('hide-error').textContent = e.message;
  }
}

async function saveStatusSettings() {
  const mode = document.querySelector('input[name="sl-mode"]:checked')?.value ?? 'claude';
  $('sl-error').hidden = true;
  try {
    renderStatusSettings(await postJson('/api/settings', { statusLine: { mode, command: $('sl-command').value } }));
    if (state.s) loadStatus(state.s);
  } catch (e) {
    $('sl-error').hidden = false;
    $('sl-error').textContent = e.message;
  }
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
  $('sv-hidden').addEventListener('change', () => { state.hidden = $('sv-hidden').checked ? '1' : ''; loadList(); });
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
  $('msg').addEventListener('keydown', onSuggestKey);
  $('msg').addEventListener('input', updateSuggest);
  $('msg').addEventListener('click', updateSuggest);
  $('msg').addEventListener('blur', closeSuggest);
  $('memo-text').addEventListener('input', onMemoInput);
  $('memo-to-msg').addEventListener('click', memoToComposer);
  window.addEventListener('pagehide', () => flushMemo({ keepalive: true }));
  $('stop').addEventListener('click', stopRunner);
  $('wake').addEventListener('click', wakeRunner);
  $('file-close').addEventListener('click', () => $('file-dialog').close());
  $('rewind-conv').addEventListener('click', () => runRewind(false));
  $('rewind-all').addEventListener('click', () => runRewind(true));
  $('rewind-close').addEventListener('click', () => { rewindTarget = null; $('rewind-dialog').close(); });
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
