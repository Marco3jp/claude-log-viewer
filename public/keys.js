export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// when は、そのキーで操作できる場所。上にある操作ほど先に判定する
export const ACTIONS = [
  { id: 'composer.send', label: '入力欄の内容をセッションに送る', when: 'composer', keys: ['Enter'] },
  { id: 'composer.newline', label: '入力欄で改行する', when: 'composer', keys: ['Shift+Enter'] },
  { id: 'find.next', label: 'セッション内検索で次の一致へ', when: 'find', keys: ['Enter'] },
  { id: 'find.prev', label: 'セッション内検索で前の一致へ', when: 'find', keys: ['Shift+Enter'] },
  { id: 'find.focus', label: 'セッション内検索へ移る', when: 'any', keys: ['Mod+F'] },
  { id: 'searchView.close', label: '詳細検索を閉じる', when: 'any', keys: ['Escape'] },
  { id: 'view.toggleConversation', label: '「会話だけ」と「全部」を切り替える', when: 'any', keys: ['Ctrl+@'] },
  { id: 'view.conversationOnly', label: '「会話だけ」にする', when: 'any', keys: [] },
  { id: 'view.all', label: '「全部」にする', when: 'any', keys: [] },
  { id: 'runner.interrupt', label: '作業中の Claude を止める（2 回押す）', when: 'any', keys: [] },
  { id: 'session.new', label: '新規チャットを作る', when: 'global', keys: [] },
  { id: 'memo.focus', label: 'メモ欄へ移る', when: 'any', keys: [] },
  { id: 'pane.sidebar', label: '左の一覧を開閉する', when: 'any', keys: [] },
  { id: 'pane.head', label: '上のヘッダーを開閉する', when: 'any', keys: [] },
  { id: 'pane.memo', label: '右のメモを開閉する', when: 'any', keys: [] },
  { id: 'search.focus', label: '検索欄へ移る', when: 'global', keys: ['/'] },
  { id: 'composer.focus', label: '送信の入力欄へ移る', when: 'global', keys: [] },
  { id: 'reload', label: '一覧と表示中のセッションを読み直す', when: 'global', keys: ['R'] },
  { id: 'keys.open', label: '設定を開く', when: 'global', keys: ['?'] },
];

export const WHEN_LABELS = {
  composer: '送信の入力欄',
  find: 'セッション内検索の欄',
  global: '入力欄の外',
  any: 'どこでも',
};

const STORAGE_KEY = 'keybindings';
const KEY_ALIASES = { esc: 'escape', return: 'enter', space: ' ', spacebar: ' ', del: 'delete', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

export function parseCombo(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const s = str.trim();
  // "Ctrl++" のようにキーそのものが + のとき
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const c = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const m of parts.map((x) => x.trim().toLowerCase())) {
    if (m === 'ctrl' || m === 'control') c.ctrl = true;
    else if (m === 'alt' || m === 'option' || m === 'opt') c.alt = true;
    else if (m === 'shift') c.shift = true;
    else if (m === 'meta' || m === 'cmd' || m === 'command') c.meta = true;
    else if (m === 'mod') c[IS_MAC ? 'meta' : 'ctrl'] = true;
    else return null;
  }
  const k = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey.trim().toLowerCase();
  c.key = KEY_ALIASES[k] ?? k;
  return c;
}

// 記号は配列によって Shift を押さないと出せないので、記号のキーでは Shift を比べない
const isSymbol = (key) => key.length === 1 && !/[\p{L}\p{N}\s]/u.test(key);

function codeKey(e) {
  if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code?.startsWith('Digit')) return e.code.slice(5);
  return null;
}

export function matches(e, c) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  // macOS の Option は文字を変える（Option+C が ç になる）ので、Alt のときは物理キーでも比べる
  if (key !== c.key && !(e.altKey && codeKey(e) === c.key)) return false;
  if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.metaKey !== c.meta) return false;
  if (!isSymbol(c.key) && e.shiftKey !== c.shift) return false;
  return true;
}

export function comboFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return '';
  const key = e.altKey && codeKey(e) ? codeKey(e) : e.key;
  const name = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && !isSymbol(key)) mods.push('Shift');
  if (e.metaKey) mods.push(IS_MAC ? 'Cmd' : 'Meta');
  return [...mods, name].join('+');
}

export function loadUserText() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveUserText(text) {
  try {
    if (text.trim()) localStorage.setItem(STORAGE_KEY, text);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// 操作名に配列を書くと置き換え、操作名の先頭に + を付けると既定に足す。空の配列で無効にする
export function resolve(text) {
  const bindings = new Map(ACTIONS.map((a) => [a.id, [...a.keys]]));
  const errors = [];
  if (text.trim()) {
    let user;
    try {
      user = JSON.parse(text);
    } catch (e) {
      return { bindings, errors: [`JSON として読めません: ${e.message}`] };
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      return { bindings, errors: ['{ "操作名": ["キー", …] } の形で書いてください'] };
    }
    for (const [name, keys] of Object.entries(user)) {
      const add = name.startsWith('+');
      const id = add ? name.slice(1) : name;
      if (!bindings.has(id)) { errors.push(`「${id}」という操作はありません`); continue; }
      if (!Array.isArray(keys)) { errors.push(`「${name}」はキーの配列にしてください`); continue; }
      const bad = keys.filter((k) => !parseCombo(k));
      if (bad.length) { errors.push(`「${name}」のキーが読めません: ${bad.map((k) => JSON.stringify(k)).join(', ')}`); continue; }
      bindings.set(id, add ? [...bindings.get(id), ...keys] : [...keys]);
    }
  }
  return { bindings, errors };
}

export function createKeymap({ handlers, where }) {
  let resolved = resolve(loadUserText());
  let parsed = new Map();
  const compile = () => {
    parsed = new Map([...resolved.bindings].map(([id, keys]) => [id, keys.map(parseCombo).filter(Boolean)]));
  };
  compile();

  document.addEventListener('keydown', (e) => {
    // 変換を確定する Enter で操作しないように、IME の入力中は除く（Safari は isComposing が立たず keyCode 229 になる）
    if (e.isComposing || e.keyCode === 229) return;
    // 開いている画面が data-keymap を持つときだけ、その画面の中でもキー操作を受ける
    if (document.querySelector('dialog[open]:not([data-keymap])')) return;
    const places = where();
    for (const a of ACTIONS) {
      if (!places.has(a.when)) continue;
      if (!parsed.get(a.id).some((c) => matches(e, c))) continue;
      // 今の画面で使えない操作なら、ほかの操作やブラウザの既定の動きに回す
      if (handlers[a.id]?.(e) === false) continue;
      e.preventDefault();
      return;
    }
  });

  return {
    get: () => resolved,
    // 書き間違いがあれば保存せず、今の設定のまま使い続ける
    apply(text) {
      const r = resolve(text);
      if (r.errors.length) return r;
      resolved = r;
      saveUserText(text);
      compile();
      return r;
    },
  };
}
