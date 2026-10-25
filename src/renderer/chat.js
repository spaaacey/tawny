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
        <div class="chat-box">
          <textarea rows="1" spellcheck="false" placeholder="Message Claude…" aria-label="Message"></textarea>
          <button class="chat-go" type="button"></button>
        </div>
        <div class="chat-foot"><span class="chat-title"></span><span class="chat-usage"></span></div>
      </div>`;
    const v = {
      id, el, model: M.emptyModel(), seq: 0, ready: false, buf: [], doneReqs: new Set(),
      status: 'starting', error: null, state: 'idle', running: false, queue: [], open: {}, raf: 0, stick: true, top: 0,
      scroll: el.querySelector('.chat-scroll'), list: el.querySelector('.chat-list'), tail: el.querySelector('.chat-tail'),
      banner: el.querySelector('.chat-banner'), ta: el.querySelector('textarea'), go: el.querySelector('.chat-go'),
      queueEl: el.querySelector('.chat-queue'), title: el.querySelector('.chat-title'), usage: el.querySelector('.chat-usage'),
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
    ta.addEventListener('input', () => autosize(v));
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(v); }
      else if (e.key === 'Escape' && busy(v)) { e.preventDefault(); stop(v); }
      else if (/^[1-9]$/.test(e.key) && !ta.value && !e.metaKey && !e.ctrlKey && !e.altKey && answerKey(v, +e.key)) e.preventDefault();
    });
    go.addEventListener('click', () => (busy(v) && !ta.value.trim() ? stop(v) : send(v)));
    el.addEventListener('click', e => {
      const opt = e.target.closest('[data-opt]');
      if (opt) return answer(v, +opt.dataset.req, opt.dataset.opt);
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
    if (!text || v.status !== 'ready') return;
    v.ta.value = '';
    autosize(v);
    v.stick = true;
    if (busy(v)) { v.queue.push(text); schedule(v); return; }
    run(v, text);
  }

  async function run(v, text) {
    v.running = true;
    schedule(v);
    try { await H.chatPrompt(v.id, [{ type: 'text', text }]); }
    catch (e) { v.banner.textContent = e.message; v.banner.hidden = false; }
    v.running = false;
    const next = v.queue.shift();
    if (next && v.status === 'ready') run(v, next); else schedule(v);
  }

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
      const sig = it.type === 'tool' ? JSON.stringify([m.tools[it.id], req, v.open[it.id]]) : it.text;
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
    for (const l of t.locations || []) h += `<a class="tloc" href="#" data-path="${esc(l.path)}"${l.line ? ` data-line="${l.line}"` : ''}>${esc(baseName(l.path))}${l.line ? `:${l.line}` : ''}</a> `;
    const cmd = t.kind === 'execute' && t.rawInput && t.rawInput.command;
    if (cmd) h += `<pre class="tcmd">$ ${esc(cmd)}</pre>`;
    for (const c of t.content || []) {
      if (c.type === 'diff') h += diffHtml(c);
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

  /** Changed lines of a `diff` content item with 2 lines of context (Monaco diff tabs come in phase 3). */
  function diffHtml(c) {
    const a = c.oldText == null ? [] : String(c.oldText).split('\n');
    const b = String(c.newText == null ? '' : c.newText).split('\n');
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const ctx = 2;
    const row = (cls, sign, line) => `<div class="dl ${cls}"><span>${sign}</span>${esc(line)}</div>`;
    let h = `<div class="tdiff-path">${esc(c.path || '')}</div><div class="tdiff">`;
    for (let i = Math.max(0, s - ctx); i < s; i++) h += row('', ' ', a[i]);
    for (const line of a.slice(s, a.length - e)) h += row('del', '-', line);
    for (const line of b.slice(s, b.length - e)) h += row('add', '+', line);
    for (let i = a.length - e; i < Math.min(a.length, a.length - e + ctx); i++) h += row('', ' ', a[i]);
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
      disconnected: `Disconnected${v.error ? `: ${esc(v.error)}` : ''}`,
      error: `Couldn't start the chat${v.error ? `: ${esc(v.error)}` : ''}`,
    };
    const html = msgs[v.status] || '';
    if (v.banner._html !== html) { v.banner._html = html; v.banner.innerHTML = html; }
    if (html || !v.banner._manual) v.banner.hidden = !html;
  }

  function renderComposer(v) {
    const b = busy(v);
    const usable = v.status === 'ready' || v.status === 'starting';
    v.ta.disabled = !usable;
    v.ta.placeholder = v.status === 'starting' ? 'Starting…' : b ? 'Queue a message… (Esc to stop)' : 'Message Claude…';
    const label = b && !v.ta.value.trim() ? 'Stop' : 'Send';
    if (v.go.textContent !== label) { v.go.textContent = label; v.go.classList.toggle('stop', label === 'Stop'); }
    v.go.disabled = !usable || (label === 'Send' && !v.ta.value.trim()) ;
    v.queueEl.hidden = !v.queue.length;
    if (v.queue.length) v.queueEl.textContent = `${v.queue.length} queued: ${v.queue[0].slice(0, 60)}`;
    const m = v.model;
    v.title.textContent = m.title || '';
    const u = m.usage;
    v.usage.textContent = u && u.size ? `${Math.round((u.used / u.size) * 100)}% context${u.cost ? ` · $${Number(u.cost.amount != null ? u.cost.amount : u.cost).toFixed(2)}` : ''}` : '';
  }

  window.harborChat = {
    el(id) { return (chats.get(id) || create(id)).el; },
    focus(id) { requestAnimationFrame(() => { const v = chats.get(id); if (v && !v.ta.disabled) v.ta.focus(); }); },
    dispose(id) { const v = chats.get(id); if (v) { v.el.remove(); chats.delete(id); } },
    /** Session state (working/waiting) changed in main. */
    refresh() { for (const v of chats.values()) schedule(v); },
  };
})();
