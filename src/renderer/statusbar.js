'use strict';
// Status bar along the bottom of the window. Its Resource Monitor item shows total memory and CPU;
// click it for the Resource Manager: memory and CPU per workspace, then per agent/terminal tab.
// Its Ports item counts the workspaces' listening TCP ports; click it for those, plus everything else listening.
(() => {
  const H = window.harbor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const APP = () => window.harborApp;

  const HISTORY = 30;   // keep in sync with HISTORY in src/main/resources.js
  const ICON = {
    chip: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="6" rx="1"/><path d="M4.5 12.5v1.5M8 12.5v1.5M11.5 12.5v1.5M4.5 7.5v0M8 7.5v0M11.5 7.5v0"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/></svg>',
    plug: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14"/></svg>',
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

  const workspacesByPrefix = S => new Map([
    ...(S.workspaces || []).map(w => [w.prefix, { ...w, repoName: '' }]),
    ...S.repos.flatMap(r => r.worktrees.map(w => [w.prefix, { ...w, repoName: r.name }])),
  ]);
  const wsName = wt => [wt.repoName, wtLabel(wt)].filter(Boolean).join(' | ');

  /** Samples joined with what the renderer knows: workspace names, tab labels and states. */
  function model() {
    const S = APP().state();
    const wts = workspacesByPrefix(S);
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
      return { ...w, key: w.prefix, name: wt ? wsName(wt) : 'Other sessions', path: wt?.path, rows };
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
    if (open) setPortsOpen(false);
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

  // ---- ports

  const portBtn = $('#portBtn'), portPop = $('#portPop'), portList = $('#portList');
  let portSnap = null;
  let externalOpen = false;

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const portRow = p => `
    <div class="pr" data-pid="${p.pid}" data-port="${p.port}">
      <span class="pr-port">${p.port}</span>
      <span class="pr-info"><span class="pr-cmd">${esc(p.command)}</span><span class="pr-addr">${esc(p.addr)}</span></span>
      <button class="icon-btn danger pr-kill" title="Kill ${esc(p.command)} (pid ${p.pid})">${ICON.x}</button>
    </div>`;

  function renderPorts() {
    if (!portSnap) return;
    const nWs = portSnap.workspaces.reduce((a, w) => a + w.ports.length, 0), nExt = portSnap.external.length;
    portBtn.querySelector('.sb-count').textContent = nWs;
    portBtn.title = `Ports — ${plural(nWs, 'workspace port')}, ${nExt} external`;
    if (portPop.hidden) return;
    $('#portSummary').textContent = `${plural(portSnap.workspaces.length, 'workspace')} · ${nExt} external`;
    const wts = workspacesByPrefix(APP().state());
    portList.innerHTML = portSnap.workspaces.map(w => {
      const wt = wts.get(w.prefix);
      return `<div class="pw"><div class="pw-head"><span class="rr-label">${esc(wt ? wsName(wt) : 'Other sessions')}</span><span class="pw-count">${w.ports.length}</span></div>${w.ports.map(portRow).join('')}</div>`;
    }).join('') + (nExt ? `
      <div class="pw ext ${externalOpen ? '' : 'collapsed'}">
        <div class="pw-head ext-head"><span class="rr-chev">${window.harborChevron}</span><span class="rr-label">External ports</span><span class="pw-count">${nExt}</span></div>
        ${portSnap.external.map(portRow).join('')}
      </div>` : '') || '<div class="res-empty">No listening ports</div>';
  }

  const refreshPorts = () => H.ports().then(s => { portSnap = s; renderPorts(); }, () => {});

  function setPortsOpen(open) {
    portPop.hidden = !open;
    portBtn.classList.toggle('on', open);
    portBtn.setAttribute('aria-expanded', String(open));
    if (open) { setOpen(false); renderPorts(); refreshPorts(); }
  }

  portBtn.onclick = () => setPortsOpen(portPop.hidden);
  portList.addEventListener('click', async e => {
    const kill = e.target.closest('.pr-kill');
    if (kill) {
      const row = kill.closest('.pr');
      row.classList.add('gone');
      try { await H.killPort(+row.dataset.pid, +row.dataset.port); setTimeout(refreshPorts, 500); }
      catch (err) { row.classList.remove('gone'); APP().toast(err.message); }
      return;
    }
    if (!e.target.closest('.ext-head')) return;
    externalOpen = !externalOpen;
    e.target.closest('.pw').classList.toggle('collapsed', !externalOpen);
  });
  document.addEventListener('mousedown', e => { if (!portPop.hidden && !portPop.contains(e.target) && !portBtn.contains(e.target)) setPortsOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !portPop.hidden) setPortsOpen(false); });
  portBtn.querySelector('.sb-icon').innerHTML = ICON.plug;
  portPop.querySelector('.sb-icon').innerHTML = ICON.plug;
  H.onPorts(s => { portSnap = s; renderPorts(); });
  refreshPorts();

  window.harborStatus = { sync: () => { render(); renderPorts(); }, toggle: () => setOpen(pop.hidden) };
})();
