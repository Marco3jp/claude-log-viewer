// ログには HTML がそのまま入っていることがあるので、生の HTML は通さず全部エスケープしてから組み立てる

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function inline(src) {
  const codes = [];
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => {
    codes.push(`<code>${esc(code.trim() ? code.replace(/^ (.*) $/, '$1') : code)}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  s = esc(s)
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[^"=>])(https?:\/\/[^\s<)）」、。]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[i]);
}

// バッククォートの中と \| ではセルを区切らない
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      if (!tick) tick = n;
      else if (tick === n) tick = 0;
      cur += '`'.repeat(n);
      i += n - 1;
      continue;
    }
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function table(header, sep, rows) {
  const align = splitRow(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`;
  const head = splitRow(header);
  const body = rows.map((r) => {
    const cells = splitRow(r);
    return `<tr>${head.map((_, i) => cell('td', cells[i] ?? '', i)).join('')}</tr>`;
  });
  return `<div class="md-table"><table><thead><tr>${head.map((h, i) => cell('th', h, i)).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`;
}

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function list(lines, start) {
  const first = lines[start].match(LIST);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST);
    if (m && indentOf(line) === base && /\d/.test(m[2]) === ordered) {
      items.push({ num: parseInt(m[2], 10), lines: [m[3]] });
      i++;
      continue;
    }
    if (!line.trim()) {
      // 空行の後も字下げが続くなら同じ項目の続き
      const next = lines[i + 1];
      const nm = next?.match(LIST);
      const sameList = nm && indentOf(next) === base && /\d/.test(nm[2]) === ordered;
      if (next !== undefined && next.trim() && (indentOf(next) > base || sameList)) {
        items[items.length - 1].lines.push('');
        items[items.length - 1].loose = true;
        i++;
        continue;
      }
      break;
    }
    if (indentOf(line) > base) {
      items[items.length - 1].lines.push(line.slice(Math.min(indentOf(line), base + 2)));
      i++;
      continue;
    }
    // 字下げの無い続きの行は、前の項目の文の続きとして扱う
    if (!m && !HEADING.test(line) && !FENCE.test(line) && !QUOTE.test(line) && !line.includes('|')) {
      items[items.length - 1].lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const lis = items.map((it) => {
    let text = it.lines.join('\n');
    let check = '';
    const task = text.match(/^\[([ xX])\]\s+/);
    if (task) {
      check = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      text = text.slice(task[0].length);
    }
    let html = blocks(text.split('\n'));
    if (!it.loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    return `<li${task ? ' class="task"' : ''}>${check}${html}</li>`;
  });
  const startAttr = ordered && items[0].num !== 1 ? ` start="${items[0].num}"` : '';
  return { html: ordered ? `<ol${startAttr}>${lis.join('')}</ol>` : `<ul>${lis.join('')}</ul>`, next: i };
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line)
    || (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? ''));
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : '';
      out.push(`<pre${lang}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const head = line.match(HEADING);
    if (head) {
      const level = Math.min(head[1].length + 2, 6);
      out.push(`<h${level}>${inline(head[2])}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) rows.push(lines[j++]);
      out.push(table(line, lines[i + 1], rows));
      i = j;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || body.length)) {
        body.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }

    if (LIST.test(line)) {
      const l = list(lines, i);
      out.push(l.html);
      i = l.next;
      continue;
    }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    // ターミナルで見たときと同じ位置で折り返したいので、段落内の改行は <br> にする
    out.push(`<p>${para.map((p) => inline(p.trim())).join('<br>')}</p>`);
  }
  return out.join('');
}

export function renderMarkdown(text) {
  return blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
