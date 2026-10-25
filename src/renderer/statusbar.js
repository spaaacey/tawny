'use strict';
// Status bar along the bottom of the window. Its Resource Monitor item shows total memory and CPU;
// click it for the Resource Manager: memory and CPU per workspace, then per agent/terminal tab.
(() => {
  const H = window.harbor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const APP = () => window.harborApp;

  const HISTORY = 30;   // keep in sync with HISTORY in src/main/resources.js
  const ICON = {
    chip: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="6" rx="1"/><path d="M4.5 12.5v1.5M8 12.5v1.5M11.5 12.5v1.5M4.5 7.5v0M8 7.5v0M11.5 7.5v0"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/></svg>',
    x: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  const bar = $('#resBtn'), pop = $('#resPop'), list = $('#resList');
  const collapsed = new Set();   // workspace prefixes folded shut
  let snap = null;               // latest sample from the main process
  let sig = '';                  // shape of the rendered rows; unchanged => patch numbers in place
  let cells = new Map();         // row key -> { cpu, mem, spark }

  const fmtMem = b => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
  const fmtCpu = c => `${c.toFixed(1)}%`;

  /** CPU history as a tiny line; scale tops out at 10% so an idle workspace stays flat. */
  function spark(h) {
    if (!h || h.length < 2) return '';
    const W = 60, T = 16, max = Math.max(10, ...h);
    const pts = h.map((v, i) => `${(W - (h.length - 1 - i) * W / (HISTORY - 1)).toFixed(1)},${(T - 1 - v / max * (T - 2)).toFixed(1)}`);
    return `<svg viewBox="0 0 ${W} ${T}" width="${W}" height="${T}"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  }

  const wtLabel = w => w.name || w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.path.split('/').pop());

  /** Samples joined with what the renderer knows: workspace names, tab labels and states. */
  function model() {
    const S = APP().state();
    const wts = new Map([
      ...(S.workspaces || []).map(w => [w.prefix, { ...w, repoName: '' }]),
      ...S.repos.flatMap(r => r.worktrees.map(w => [w.prefix, { ...w, repoName: r.name }])),
    ]);
    const sess = new Map(S.sessions.map(s => [s.id, s]));
    return snap.workspaces.map(w => {
      const wt = wts.get(w.prefix);
      const rows = w.sessions.flatMap(r => {
        if (r.lsp) return [{ ...r, key: `${w.prefix}/${r.id}`, name: r.lsp, state: 'lsp' }];
        const info = sess.get(r.id);   // gone from state: just killed, next sample drops it
        if (!info) return [];
        const state = info.kind === 'terminal' ? 'term' : info.waiting ? 'wait' : info.working ? 'work' : 'idle';
        return [{ ...r, key: `${w.prefix}/${r.id}`, name: window.harborLayout.agentLabel(info), state }];
      });
      return { ...w, key: w.prefix, name: wt ? [wt.repoName, wtLabel(wt)].filter(Boolean).join(' | ') : 'Other sessions', path: wt?.path, rows };
    });
  }

  const indicator = state => ({
    term: '<span class="tglyph">&gt;_</span>', lsp: '<span class="tglyph">LS</span>',
    wait: '<div class="dot wait"></div>', work: '<div class="spin"></div>', idle: '<div class="dot idle"></div>',
  })[state];

  const numCells = (r, extra = '') => `<span class="num cpu">${fmtCpu(r.cpu)}</span><span class="num mem">${fmtMem(r.rss)}</span>${extra}`;

  function rowsHtml(ws) {
    return ws.map(w => `
      <div class="rw ${collapsed.has(w.key) ? 'collapsed' : ''}" data-ws="${esc(w.key)}">
        <div class="rr rw-head" data-k="${esc(w.key)}">
          <span class="rr-name"><span class="rr-chev">${window.harborChevron}</span><span class="rr-label">${esc(w.name)}</span></span>
          <span class="spark">${spark(w.history)}</span>${numCells(w, '<span></span>')}
        </div>
        ${w.rows.map(r => `
        <div class="rr rr-tab ${r.lsp ? 'lsp' : ''}" data-k="${esc(r.key)}" data-id="${esc(r.id)}" data-path="${esc(w.path || '')}">
          <span class="rr-name"><span class="ind">${indicator(r.state)}</span><span class="rr-label">${esc(r.name)}</span></span>
          <span></span>${numCells(r, r.lsp ? '<span></span>' : `<button class="icon-btn danger rr-kill" title="Stop (kills this session)">${ICON.x}</button>`)}
        </div>`).join('')}
      </div>`).join('');
  }

  function render() {
    if (!snap) return;
    bar.querySelector('.sb-text').textContent = `${fmtMem(snap.rss)} · ${fmtCpu(snap.cpu)}`;
    bar.querySelector('.sb-count').textContent = APP().state().sessions.length;
    if (pop.hidden) return;
    $('#resTotal').textContent = `${fmtCpu(snap.cpu)} · ${fmtMem(snap.rss)} Σ Memory`;
    $('#resApp').innerHTML = numCells(snap.app, '<span></span>');

    const ws = model();
    const next = ws.map(w => `${w.key}|${w.name}|${w.rows.map(r => `${r.key}|${r.name}|${r.state}`).join(',')}`).join(';');
    if (next !== sig) {
      sig = next;
      list.innerHTML = rowsHtml(ws) || '<div class="res-empty">No running sessions</div>';
      cells = new Map([...list.querySelectorAll('[data-k]')].map(el => [el.dataset.k, {
        cpu: el.querySelector('.cpu'), mem: el.querySelector('.mem'), spark: el.querySelector('.spark'),
      }]));
      return;
    }
    for (const w of ws) for (const r of [w, ...w.rows]) {
      const c = cells.get(r.key);
      if (!c) continue;
      c.cpu.textContent = fmtCpu(r.cpu);
      c.mem.textContent = fmtMem(r.rss);
      if (c.spark && r === w) c.spark.innerHTML = spark(w.history);
    }
  }

  function onSample(s) { snap = s; render(); }
  const refresh = () => H.resources().then(onSample, () => {});

  function setOpen(open) {
    pop.hidden = !open;
    bar.classList.toggle('on', open);
    bar.setAttribute('aria-expanded', String(open));
    sig = '';
    if (open) { render(); refresh(); }
  }

  bar.onclick = () => setOpen(pop.hidden);
  $('#resRefresh').onclick = refresh;
  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !bar.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) setOpen(false); });

  pop.addEventListener('click', async e => {
    const kill = e.target.closest('.rr-kill');
    const row = e.target.closest('.rr');
    if (kill) {
      row.classList.add('gone');
      try { await APP().stopAgent(row.dataset.id); } catch (err) { row.classList.remove('gone'); APP().toast(err.message); }
    } else if (row && row.classList.contains('rw-head')) {
      const rw = row.parentElement;
      rw.classList.toggle('collapsed');
      rw.classList.contains('collapsed') ? collapsed.add(rw.dataset.ws) : collapsed.delete(rw.dataset.ws);
    } else if (row && !row.classList.contains('lsp') && row.dataset.path) {
      setOpen(false);
      APP().revealSession(row.dataset.path, row.dataset.id);
    }
  });

  bar.querySelector('.sb-icon').innerHTML = ICON.chip;
  $('#resRefresh').innerHTML = ICON.refresh;
  H.onResources(onSample);
  refresh();

  window.harborStatus = { sync: render, toggle: () => setOpen(pop.hidden) };
})();
