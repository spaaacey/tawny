'use strict';
// Chat tabs (ACP): transcript, tool cards, permission cards and composer for a session of kind 'chat'.
// Main keeps the authoritative transcript model; this folds the live updates onto the history it fetched (chat-model.js is shared).
// See docs/chat-tabs-plan.md.
(() => {
  const H = window.harbor;
  const M = window.harborChatModel;
  const chats = new Map(); // session id -> view

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
  const KIND_GLYPH = { read: '≡', edit: '✎', delete: '✕', move: '→', search: '⌕', execute: '$', think: '…', fetch: '↓', switch_mode: '⇄', other: '•' };
  const MAX_TEXT = 20000;
  const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

  const clip = s => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters)` : s);
  const baseName = p => String(p).split('/').pop();

  function create(id) {
    const el = document.createElement('div');
    el.className = 'chat';
    el.hidden = true;
    el.innerHTML = `
      <div class="chat-scroll"><div class="chat-col"><div class="chat-list"></div><div class="chat-tail"></div></div></div>
      <div class="chat-banner" hidden></div>
      <div class="chat-compose">
        <div class="chat-queue" hidden></div>
        <div class="chat-mention" hidden></div>
        <div class="chat-thumbs" hidden></div>
        <div class="chat-box">
          <textarea rows="1" spellcheck="false" placeholder="Message Claude…" aria-label="Message"></textarea>
          <button class="chat-go" type="button"></button>
        </div>
        <div class="chat-foot"><span class="chat-title"></span><button class="chat-term" type="button" hidden title="Continue this conversation with claude --resume in a terminal tab">Open in terminal</button><span class="chat-usage"></span></div>
      </div>`;
    const v = {
      id, el, model: M.emptyModel(), seq: 0, ready: false, buf: [], doneReqs: new Set(),
      status: 'starting', error: null, state: 'idle', running: false, queue: [], open: {}, raf: 0, stick: true, top: 0,
      scroll: el.querySelector('.chat-scroll'), list: el.querySelector('.chat-list'), tail: el.querySelector('.chat-tail'),
      banner: el.querySelector('.chat-banner'), ta: el.querySelector('textarea'), go: el.querySelector('.chat-go'),
      queueEl: el.querySelector('.chat-queue'), mentionEl: el.querySelector('.chat-mention'), thumbs: el.querySelector('.chat-thumbs'),
      mentions: new Map(), images: [], pick: null, note: '', term: el.querySelector('.chat-term'), title: el.querySelector('.chat-title'), usage: el.querySelector('.chat-usage'),
    };
    chats.set(id, v);
    wire(v);
    H.chatHistory(id).then(h => {
      v.seq = h.seq; v.model = h.model; v.status = h.status; v.error = h.error; v.state = h.state;
      v.ready = true;
      for (const e of v.buf) applyEvent(v, e);
      v.buf = [];
      schedule(v);
    }).catch(e => { v.status = 'error'; v.error = e.message; v.ready = true; schedule(v); });
    schedule(v);
    return v;
  }

  function wire(v) {
    const { el, ta, go, scroll } = v;
    scroll.addEventListener('scroll', () => {
      if (!el.offsetHeight) return;
      v.top = scroll.scrollTop;
      v.stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    });
    // a tab that was hidden or re-parented loses its scroll position: restore it when it shows again
    new ResizeObserver(() => {
      if (!el.offsetHeight) return;
      scroll.scrollTop = v.stick ? scroll.scrollHeight : v.top;
    }).observe(el);
    ta.addEventListener('input', () => { autosize(v); updateMention(v); });
    ta.addEventListener('click', () => updateMention(v));
    ta.addEventListener('blur', () => closeMention(v));
    ta.addEventListener('paste', e => {
      const imgs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); addImages(v, imgs); }
    });
    el.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    el.addEventListener('drop', e => {
      const imgs = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); addImages(v, imgs); }
    });
    v.thumbs.addEventListener('click', e => {
      const x = e.target.closest('[data-rm]');
      if (x) { v.images.splice(+x.dataset.rm, 1); schedule(v); }
    });
    v.mentionEl.addEventListener('mousedown', e => {
      const row = e.target.closest('[data-i]');
      if (row) { e.preventDefault(); chooseMention(v, +row.dataset.i); }
    });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (v.pick && v.pick.items.length && !e.isComposing) {
        const n = v.pick.items.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); v.pick.sel = (v.pick.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderMention(v); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseMention(v, v.pick.sel); return; }
        if (e.key === 'Escape') { e.preventDefault(); closeMention(v); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(v); }
      else if (e.key === 'Escape' && busy(v)) { e.preventDefault(); stop(v); }
      else if (/^[1-9]$/.test(e.key) && !ta.value && !e.metaKey && !e.ctrlKey && !e.altKey && answerKey(v, +e.key)) e.preventDefault();
    });
    go.addEventListener('click', () => (busy(v) && !ta.value.trim() && !v.images.length ? stop(v) : send(v)));
    el.addEventListener('click', e => {
      if (e.target.closest('[data-reconnect]')) return H.chatReconnect(v.id).catch(err => flash(v, err.message));
      if (e.target.closest('.chat-term')) return window.harborApp.chatToTerminal(v.id).catch(err => flash(v, err.message));
      const opt = e.target.closest('[data-opt]');
      if (opt) return answer(v, +opt.dataset.req, opt.dataset.opt);
      const od = e.target.closest('[data-diff]');
      if (od) {
        const c = (v.model.tools[od.dataset.diff].content || []).filter(x => x.type === 'diff')[+od.dataset.i];
        if (c) window.harborEditor.openTextDiff(c.path, c.oldText, c.newText);
        return;
      }
      const loc = e.target.closest('[data-path]');
      if (loc) {
        e.preventDefault();
        return window.harborEditor.openFile(loc.dataset.path, loc.dataset.line ? { selection: { lineNumber: +loc.dataset.line, column: 1 } } : {});
      }
      const a = e.target.closest('.chat-md a');
      if (a) { e.preventDefault(); if (/^https?:/.test(a.href)) window.open(a.href); }
    });
    el.addEventListener('toggle', e => { if (e.target.dataset && e.target.dataset.id) v.open[e.target.dataset.id] = e.target.open; }, true);
  }

  function autosize(v) {
    v.ta.style.height = 'auto';
    v.ta.style.height = `${Math.min(v.ta.scrollHeight, 220)}px`;
  }

  const info = v => (window.harborApp && window.harborApp.agentInfo(v.id)) || {};
  const busy = v => v.running || v.state !== 'idle' || !!info(v).working || !!info(v).waiting;

  // ---------------------------------------------------------------- actions

  function send(v) {
    const text = v.ta.value.trim();
    if ((!text && !v.images.length) || v.status !== 'ready') return;
    const msg = { text, blocks: promptBlocks(v, text) };
    v.note = '';
    v.ta.value = '';
    v.images = [];
    v.mentions.clear();
    closeMention(v);
    autosize(v);
    v.stick = true;
    if (busy(v)) { v.queue.push(msg); schedule(v); return; }
    run(v, msg);
  }

  /** Text with each known `@path` as a resource_link between the text parts, then the pasted images. */
  function promptBlocks(v, text) {
    const blocks = [];
    let last = 0;
    const flush = to => { if (to > last) blocks.push({ type: 'text', text: text.slice(last, to) }); };
    for (const m of text.matchAll(/@\S+/g)) {
      const hit = v.mentions.has(m[0]) ? m[0] : m[0].replace(/[,.;:)!?]+$/, '');
      if (!v.mentions.has(hit)) continue;
      flush(m.index);
      const abs = v.mentions.get(hit);
      blocks.push({ type: 'resource_link', name: hit.slice(1), uri: `file://${encodeURI(abs)}` });
      last = m.index + hit.length;
    }
    flush(text.length);
    for (const im of v.images) blocks.push({ type: 'image', data: im.data, mimeType: im.mimeType });
    return blocks;
  }

  async function run(v, msg) {
    v.running = true;
    schedule(v);
    try { await H.chatPrompt(v.id, msg.blocks); }
    catch (e) { flash(v, e.message); }
    v.running = false;
    const next = v.queue.shift();
    if (next && v.status === 'ready') run(v, next); else schedule(v);
  }

  /** A one-off message in the banner, until the next send. */
  function flash(v, msg) { v.note = msg; schedule(v); }

  function stop(v) {
    v.queue = [];
    H.chatCancel(v.id);
    schedule(v);
  }

  function answer(v, reqId, optionId) {
    v.model.pending = v.model.pending.filter(r => r.reqId !== reqId);
    v.doneReqs.add(reqId);
    H.chatAnswer(v.id, reqId, optionId || null);
    schedule(v);
    v.ta.focus();
  }

  /** Number keys pick the n-th option of the oldest pending permission. */
  function answerKey(v, n) {
    const req = v.model.pending[0];
    const opt = req && req.options[n - 1];
    if (!opt) return false;
    answer(v, req.reqId, opt.optionId);
    return true;
  }

  // ---------------------------------------------------------------- mentions and images

  function addImages(v, files) {
    for (const f of files) {
      const r = new FileReader();
      r.onload = () => { v.images.push({ mimeType: f.type, data: String(r.result).split(',')[1] }); schedule(v); };
      r.readAsDataURL(f);
    }
  }

  function updateMention(v) {
    const ta = v.ta;
    const m = /(^|\s)@([^\s@]*)$/.exec(ta.value.slice(0, ta.selectionStart));
    if (!m) return closeMention(v);
    const E = window.harborEditor;
    E.loadFileIndex().then(() => {
      if (!v.pick && v.mentionEl.hidden === false) return;
      const q = m[2];
      const items = E.fileMatches(q).slice(0, 8);
      if (!items.length) return closeMention(v);
      const start = ta.selectionStart - q.length - 1;
      v.pick = { items, sel: 0, start, end: ta.selectionStart };
      renderMention(v);
    });
  }

  function renderMention(v) {
    const p = v.pick;
    v.mentionEl.hidden = !p;
    if (!p) return;
    v.mentionEl.innerHTML = p.items.map((r, i) => `<div class="mi${i === p.sel ? ' on' : ''}" data-i="${i}">${window.harborEditor.fileRowHtml(r)}</div>`).join('');
  }

  function closeMention(v) {
    v.pick = null;
    v.mentionEl.hidden = true;
  }

  function chooseMention(v, i) {
    const p = v.pick;
    const r = p && p.items[i];
    if (!r) return;
    const token = `@${r.f}`;
    v.mentions.set(token, window.harborEditor.absPath(r.f));
    v.ta.setRangeText(`${token} `, p.start, p.end, 'end');
    closeMention(v);
    autosize(v);
    schedule(v);
  }

  // ---------------------------------------------------------------- events

  function applyEvent(v, e) {
    if (e.k === 'u') {
      if (e.seq <= v.seq) return;
      v.seq = e.seq;
      M.fold(v.model, e.update);
    } else if (e.k === 'p') {
      if (!v.doneReqs.has(e.req.reqId) && !v.model.pending.some(r => r.reqId === e.req.reqId)) v.model.pending.push(e.req);
    } else if (e.k === 'd') {
      v.doneReqs.add(e.reqId);
      v.model.pending = v.model.pending.filter(r => r.reqId !== e.reqId);
    } else if (e.k === 's') {
      v.status = e.status; v.error = e.error;
    }
    schedule(v);
  }
  function dispatch(id, e) {
    const v = chats.get(id);
    if (!v) return;
    if (v.ready) applyEvent(v, e); else v.buf.push(e);
  }
  H.onChatUpdate((id, e) => dispatch(id, { k: 'u', seq: e.seq, update: e.update }));
  H.onChatPermission((id, req) => dispatch(id, { k: 'p', req }));
  H.onChatPermissionDone((id, reqId) => dispatch(id, { k: 'd', reqId }));
  // the agent reads a file it doesn't run itself: answer with the editor's unsaved text when there is any
  H.onChatReadFile((id, req) => H.chatFileReply(id, req.reqId, window.harborEditor.dirtyText(req.path)));
  H.onChatStatus((id, st) => dispatch(id, { k: 's', status: st.status, error: st.error }));

  // ---------------------------------------------------------------- rendering

  function schedule(v) { if (!v.raf) v.raf = requestAnimationFrame(() => { v.raf = 0; render(v); }); }

  function render(v) {
    const m = v.model;
    const items = m.items;
    const near = v.stick;
    const pendingBy = {};
    for (const r of m.pending) pendingBy[r.toolCall.toolCallId] = r;
    const placed = new Set();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const req = it.type === 'tool' ? pendingBy[it.id] : null;
      if (req) placed.add(req.reqId);
      const sig = it.type === 'tool' ? JSON.stringify([m.tools[it.id], req, v.open[it.id], colorVer]) : it.text;
      let node = v.list.children[i];
      if (!node) { node = document.createElement('div'); v.list.appendChild(node); }
      if (node._sig === sig && node._type === it.type) continue;
      if (node._type !== it.type) { node.className = ''; node._type = it.type; }
      node._sig = sig;
      fill(v, node, it, req);
    }
    while (v.list.children.length > items.length) v.list.lastChild.remove();

    // permission requests whose tool call isn't in the transcript yet
    const loose = m.pending.filter(r => !placed.has(r.reqId));
    const tailHtml = loose.map(r => `<div class="tool pending open-card">${toolHead(r.toolCall)}<div class="tb">${toolBody(r.toolCall)}${permHtml(r)}</div></div>`).join('')
      + (v.state === 'working' || (busy(v) && !m.pending.length) ? '<div class="chat-working"><span class="spin"></span>Working…</div>' : '');
    if (v.tail._sig !== tailHtml) { v.tail._sig = tailHtml; v.tail.innerHTML = tailHtml; }

    renderBanner(v);
    renderComposer(v);
    if (near) v.scroll.scrollTop = v.scroll.scrollHeight;
  }

  function fill(v, node, it, req) {
    if (it.type === 'user') { node.className = 'msg user'; node.textContent = it.text; }
    else if (it.type === 'agent') { node.className = 'msg agent chat-md'; node.innerHTML = window.harborChatMd ? window.harborChatMd.render(it.text) : esc(it.text); }
    else if (it.type === 'thought') {
      node.className = 'msg thought';
      node.innerHTML = `<details data-id="thought-${esc(it.id || '')}"><summary>Thinking</summary><div class="thought-body">${esc(it.text)}</div></details>`;
    } else if (it.type === 'notice') { node.className = it.kind === 'compaction_update' ? 'msg divider' : 'msg notice'; node.textContent = it.text; }
    else if (it.type === 'tool') {
      const t = v.model.tools[it.id];
      const open = v.open[it.id] !== undefined ? v.open[it.id] : t.status === 'failed' || !!req;
      node.className = `tool k-${esc(t.kind || 'other')} s-${esc(t.status || 'pending')}${req ? ' pending' : ''}`;
      node.innerHTML = `<details data-id="${esc(it.id)}"${open ? ' open' : ''}>${toolHead(t)}<div class="tb">${toolBody(t)}${req ? permHtml(req) : ''}</div></details>`;
    }
  }

  function toolHead(t) {
    const st = t.status || 'pending';
    const mark = st === 'completed' ? '<span class="ok">✓</span>' : st === 'failed' ? '<span class="bad">✗</span>' : '<span class="spin"></span>';
    const title = String(t.title || 'Tool').split('\n')[0];
    return `<summary><span class="ti">${KIND_GLYPH[t.kind] || KIND_GLYPH.other}</span><span class="tt">${esc(title)}</span><span class="ts">${mark}</span></summary>`;
  }

  function toolBody(t) {
    let h = '';
    let di = 0;
    for (const l of t.locations || []) h += `<a class="tloc" href="#" data-path="${esc(l.path)}"${l.line ? ` data-line="${l.line}"` : ''}>${esc(baseName(l.path))}${l.line ? `:${l.line}` : ''}</a> `;
    const cmd = t.kind === 'execute' && t.rawInput && t.rawInput.command;
    if (cmd) h += `<pre class="tcmd">$ ${esc(cmd)}</pre>`;
    for (const c of t.content || []) {
      if (c.type === 'diff') h += diffHtml(c, t.toolCallId, di++);
      else if (c.type === 'content' && c.content && c.content.type === 'text' && !(t.terminal && t.kind === 'execute')) h += `<pre class="tout">${esc(clip(c.content.text))}</pre>`;
      else if (c.type === 'text') h += `<pre class="tout">${esc(clip(c.text))}</pre>`;
    }
    if (t.terminal) {
      const out = t.terminal.output.replace(ANSI_RE, '');
      if (out) h += `<pre class="tout">${esc(clip(out))}</pre>`;
      if (t.terminal.exit && t.terminal.exit.code) h += `<div class="texit">exit ${esc(t.terminal.exit.code)}</div>`;
    }
    return h;
  }

  // Syntax-highlighted lines per (path, text), filled in by Monaco's colorizer; colorVer bumps when one lands so cards re-render.
  const colored = new Map();
  let colorVer = 0;
  function coloredLines(text, path) {
    const key = `${path}\0${text}`;
    if (!colored.has(key)) {
      colored.set(key, null);
      window.harborEditor.colorizeLines(text, path).then(lines => {
        colored.set(key, lines);
        if (lines) { colorVer++; for (const v of chats.values()) schedule(v); }
      });
      if (colored.size > 200) colored.delete(colored.keys().next().value);
    }
    return colored.get(key);
  }

  /** Changed lines of a `diff` content item with 2 lines of context; "Open diff" shows it in a Monaco diff tab. */
  function diffHtml(c, toolId, di) {
    const oldText = c.oldText == null ? '' : String(c.oldText);
    const newText = c.newText == null ? '' : String(c.newText);
    const a = c.oldText == null ? [] : oldText.split('\n');
    const b = newText.split('\n');
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const ctx = 2;
    const ca = coloredLines(oldText, c.path || '');
    const cb = coloredLines(newText, c.path || '');
    const code = (html, lines, i) => (html && html[i] != null ? html[i] : esc(lines[i]));
    const row = (cls, sign, html) => `<div class="dl ${cls}"><span>${sign}</span>${html}</div>`;
    let h = `<div class="tdiff-path"><span>${esc(c.path || '')}</span><button type="button" class="tdiff-open" data-diff="${esc(toolId)}" data-i="${di}">Open diff</button></div><div class="tdiff">`;
    for (let i = Math.max(0, s - ctx); i < s; i++) h += row('', ' ', code(ca, a, i));
    for (let i = s; i < a.length - e; i++) h += row('del', '-', code(ca, a, i));
    for (let i = s; i < b.length - e; i++) h += row('add', '+', code(cb, b, i));
    for (let i = a.length - e; i < Math.min(a.length, a.length - e + ctx); i++) h += row('', ' ', code(ca, a, i));
    return `${h}</div>`;
  }

  function permHtml(r) {
    return `<div class="perm">${r.options.map((o, i) => `<button type="button" class="perm-btn ${esc(String(o.kind || '').split('_')[0])}" data-req="${r.reqId}" data-opt="${esc(o.optionId)}"><kbd>${i + 1}</kbd>${esc(o.name)}</button>`).join('')}</div>`;
  }

  function renderBanner(v) {
    const msgs = {
      starting: '',
      'no-claude': `Claude Code isn't installed. Install it with <code>${esc(INSTALL)}</code>, then open a new chat.`,
      'auth-required': 'Not signed in. Run <code>claude</code> in a terminal tab and use <code>/login</code>, then open a new chat.',
      disconnected: `Disconnected${v.error ? `: ${esc(v.error)}` : ''} <button type="button" class="chat-reconnect" data-reconnect>Reconnect</button>`,
      error: `Couldn't start the chat${v.error ? `: ${esc(v.error)}` : ''} <button type="button" class="chat-reconnect" data-reconnect>Retry</button>`,
    };
    const html = msgs[v.status] || (v.note ? esc(v.note) : '');
    if (v.banner._html !== html) { v.banner._html = html; v.banner.innerHTML = html; }
    v.banner.hidden = !html;
  }

  function renderComposer(v) {
    const b = busy(v);
    const usable = v.status === 'ready' || v.status === 'starting';
    v.ta.disabled = !usable;
    v.ta.placeholder = v.status === 'starting' ? 'Starting…' : b ? 'Queue a message… (Esc to stop)' : 'Message Claude…';
    const label = b && !v.ta.value.trim() && !v.images.length ? 'Stop' : 'Send';
    if (v.go.textContent !== label) { v.go.textContent = label; v.go.classList.toggle('stop', label === 'Stop'); }
    v.go.disabled = !usable || (label === 'Send' && !v.ta.value.trim() && !v.images.length);
    v.thumbs.hidden = !v.images.length;
    const th = v.images.map((im, i) => `<span class="thumb"><img src="data:${esc(im.mimeType)};base64,${im.data}" alt=""><button type="button" data-rm="${i}" aria-label="Remove image">×</button></span>`).join('');
    if (v.thumbs._html !== th) { v.thumbs._html = th; v.thumbs.innerHTML = th; }
    v.queueEl.hidden = !v.queue.length;
    if (v.queue.length) v.queueEl.textContent = `${v.queue.length} queued: ${(v.queue[0].text || '[image]').slice(0, 60)}`;
    const m = v.model;
    v.term.hidden = !(v.status === 'ready' && m.items.length && !b);
    v.title.textContent = m.title || '';
    const u = m.usage;
    v.usage.textContent = u && u.size ? `${Math.round((u.used / u.size) * 100)}% context${u.cost ? ` · $${Number(u.cost.amount != null ? u.cost.amount : u.cost).toFixed(2)}` : ''}` : '';
  }

  window.harborChat = {
    el(id) { return (chats.get(id) || create(id)).el; },
    focus(id) { requestAnimationFrame(() => { const v = chats.get(id); if (v && !v.ta.disabled) v.ta.focus(); }); },
    dispose(id) { const v = chats.get(id); if (v) { v.el.remove(); chats.delete(id); } },
    /** Put `text` (e.g. an @file#L3-5 reference) in the composer. */
    insert(id, text) {
      const v = chats.get(id) || (this.el(id), chats.get(id));
      const ref = /^@(\S+?)(#L\d+(-\d+)?)?\s*$/.exec(text.trim());
      if (ref) {
        const token = text.trim();
        v.mentions.set(token, window.harborEditor.absPath(ref[1]));
      }
      const sep = v.ta.value && !/\s$/.test(v.ta.value) ? ' ' : '';
      v.ta.value += `${sep}${text}${/\s$/.test(text) ? '' : ' '}`;
      autosize(v);
      schedule(v);
    },
    /** Send-selection target: reference alone fills the composer, with a message it sends at once. */
    ask(id, ref, msg) {
      const v = chats.get(id) || (this.el(id), chats.get(id));
      if (!msg) return this.insert(id, ref);
      this.insert(id, ref);
      v.ta.value += msg;
      autosize(v);
      send(v);
    },
    /** Session state (working/waiting) changed in main. */
    refresh() { for (const v of chats.values()) schedule(v); },
  };
})();
