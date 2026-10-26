'use strict';
// Find in files: the "Find" view of the secondary sidebar (cmd+option+f opens the palette's '#' mode, which shares this view's options). Search runs in the main process (src/main/search.js);
// this renders the grouped results and drives replace.
(() => {
  const H = window.harbor;
  const E = window.harborEditor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const base = p => p.split('/').pop();
  const toast = msg => window.harborApp && window.harborApp.toast(msg);

  const query = $('#fdQuery'), replace = $('#fdReplace'), inc = $('#fdInc'), exc = $('#fdExc'), results = $('#fdResults');
  const flags = { matchCase: false, wholeWord: false, regex: false };
  let files = [];               // [{ path (abs), rel, matches: [{ l, c, n, t, o }], collapsed }]
  let state = 'idle';           // 'idle' | 'searching' | 'done' | 'replaced'
  let total = 0, truncated = false, note = '', cur = null;   // cur: the keyboard-focused row's key
  let timer, seq = 0, searchedRoot = null, stale = false, visible = false;

  const svg = (d, w = 16) => `<svg viewBox="0 0 16 16" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const ICON = {
    replace: svg('M2.5 5.5h8.5M8.5 3l2.5 2.5L8.5 8M13.5 10.5H5M7.5 8 5 10.5 7.5 13'),
    replaceAll: svg('M2 4h6M2 7h4M2 10h6M2 13h4M9.5 5.5h4.5M12 3.5l2 2-2 2M14 10.5H9.5M11.5 8.5l-2 2 2 2'),
    dismiss: svg('M4 4l8 8M12 4l-8 8'),
    refresh: svg('M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3'),
    clear: svg('M3 4.5h10M3 8h10M3 11.5h6M11 10.5l3 3M14 10.5l-3 3'),
    collapse: svg('M4 6l4-3 4 3M4 10l4 3 4-3'),
  };
  $('#fdRepToggle').innerHTML = window.harborChevron;
  $('#fdReplaceAll').innerHTML = ICON.replaceAll;
  $('#fdRefresh').innerHTML = ICON.refresh;
  $('#fdClear').innerHTML = ICON.clear;
  $('#fdCollapse').innerHTML = ICON.collapse;

  const opts = () => ({ query: query.value, ...flags, include: inc.value, exclude: exc.value });
  const replacing = () => !$('#fdRepField').hidden;

  // ------------------------------------------------------------------ search

  function schedule(ms = 250) { clearTimeout(timer); timer = setTimeout(run, ms); }

  async function run() {
    clearTimeout(timer);
    const root = E.root, id = ++seq;
    stale = false;
    setError('');
    if (!root || !query.value) { files = []; state = 'idle'; note = ''; return render(); }
    state = 'searching';
    searchedRoot = root;
    renderSummary();
    try {
      const r = await H.search(root, opts(), id);
      if (id !== seq || r.cancelled) return;
      files = r.files.map(f => ({ ...f, rel: f.path, path: `${root}/${f.path}`, collapsed: false }));
      total = r.total; truncated = r.truncated; state = 'done'; note = '';
    } catch (e) {
      if (id !== seq) return;
      files = []; state = 'idle';
      setError(String(e.message).replace(/^\/.*\/[a-z]*: /, ''));
    }
    cur = null;
    render();
  }

  function setError(msg) {
    $('#fdErr').hidden = !msg;
    $('#fdErr').textContent = msg;
  }

  // ------------------------------------------------------------------ rendering

  /** What a match turns into, for the inline preview of a pending replace. */
  function replacement(text) {
    const r = replace.value;
    if (!flags.regex) return r;
    try {
      const re = new RegExp(opts().wholeWord ? `\\b(?:${query.value})\\b` : query.value, flags.matchCase ? '' : 'i');
      return text.replace(re, r).replace(/\\n/g, '↵').replace(/\\t/g, '⇥');
    } catch { return r; }
  }

  function matchHtml(m) {
    const n = Math.min(m.n, m.t.length - m.o);
    const pre = m.t.slice(0, m.o), hit = m.t.slice(m.o, m.o + n), post = m.t.slice(m.o + n);
    const mid = replacing() && replace.value !== '' ? `<del>${esc(hit)}</del><ins>${esc(replacement(hit))}</ins>`
      : replacing() ? `<del>${esc(hit)}</del>` : `<mark>${esc(hit)}</mark>`;
    return `${esc(pre)}${mid}${esc(post)}`;
  }

  const actBtn = (act, title) => `<span class="fd-act" data-act="${act}" title="${title}">${ICON[act]}</span>`;

  function renderSummary() {
    const n = files.reduce((s, f) => s + f.matches.length, 0);
    $('#fdCount').textContent = state === 'searching' ? 'Searching…' : state === 'replaced' ? note
      : state === 'done' ? (n ? `${n}${truncated ? '+' : ''} result${n === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${truncated ? ' (limited)' : ''}` : 'No results found') : '';
    $('#fdSummary').hidden = state === 'idle';
  }

  function render() {
    renderSummary();
    const flavor = window.harborTheme.name;
    results.innerHTML = files.map((f, i) => {
      const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
      let h = `<div class="fr${cur === `f${i}` ? ' cur' : ''}" data-f="${i}" title="${esc(f.rel)}"><span class="tw${f.collapsed ? '' : ' open'}">${window.harborChevron}</span>`
        + `<img class="ti" src="fileicons/${flavor}/${E.iconFor(base(f.rel), 'file')}.svg" draggable="false"><span class="fr-name">${esc(base(f.rel))}</span><span class="fr-dir">${esc(dir)}</span>`
        + `<span class="fd-acts">${replacing() ? actBtn('replace', 'Replace All in File') : ''}${actBtn('dismiss', 'Dismiss')}</span><span class="cn-n">${f.matches.length}</span></div>`;
      if (!f.collapsed) {
        h += f.matches.map((m, j) => `<div class="mr${cur === `m${i}:${j}` ? ' cur' : ''}" data-f="${i}" data-m="${j}"><span class="mr-t">${matchHtml(m)}</span>`
          + `<span class="fd-acts">${replacing() ? actBtn('replace', 'Replace') : ''}${actBtn('dismiss', 'Dismiss')}</span></div>`).join('');
      }
      return h;
    }).join('');
  }

  // ------------------------------------------------------------------ actions

  const rangeOf = m => ({ startLineNumber: m.l, startColumn: m.c + 1, endLineNumber: m.l, endColumn: m.c + 1 + m.n });

  function openMatch(f, m, pin) {
    E.openFile(f.path, { selection: rangeOf(m), preview: !pin, pin, focus: !!pin });
  }

  function dismiss(fi, mj) {
    const f = files[fi];
    if (mj === undefined) files.splice(fi, 1);
    else { f.matches.splice(mj, 1); if (!f.matches.length) files.splice(fi, 1); }
    cur = null;
    render();
  }

  /** Replace `ms` (all of the file's matches by default) in file `f`; resolves to the number replaced. */
  async function replaceIn(f, ms = f.matches, o = opts()) {
    const positions = ms.map(m => [m.l, m.c]);
    const text = E.modelText(f.path);   // an open file is edited in its editor (left unsaved), else on disk
    if (text === null) return (await H.replaceInFile(f.path, o, replace.value, positions)).length;
    const edits = await H.replaceEdits(text, o, replace.value, positions);
    E.applyModelEdits(f.path, edits);
    return edits.length;
  }

  async function replaceOne(fi, mj) {
    const f = files[fi], m = f.matches[mj];
    const sameLine = f.matches.some((x, k) => k !== mj && x.l === m.l);
    let n;
    try { n = await replaceIn(f, [m]); } catch (e) { return toast(`Replace failed: ${e.message}`); }
    if (n !== 1 || sameLine) return run();   // the file moved on under the results, or the line's other matches shifted
    dismiss(fi, mj);
  }

  async function replaceFile(fi) {
    const f = files[fi];
    let n;
    try { n = await replaceIn(f); } catch (e) { return toast(`Replace failed: ${e.message}`); }
    if (n !== f.matches.length) return run();
    dismiss(fi);
  }

  async function replaceAll() {
    if (!files.length || !replacing()) return;
    const n = files.reduce((s, f) => s + f.matches.length, 0);
    const where = files.length === 1 ? 'in 1 file' : `across ${files.length} files`;
    if (!confirm(`Replace ${n} occurrence${n === 1 ? '' : 's'} ${where} with '${replace.value}'?`)) return;
    let done = 0, hit = 0;
    for (const f of files) {
      try { const k = await replaceIn(f); done += k; if (k) hit++; }
      catch (e) { toast(`Replace failed in ${base(f.path)}: ${e.message}`); }
    }
    files = []; state = 'replaced';
    note = `Replaced ${done} occurrence${done === 1 ? '' : 's'} in ${hit} file${hit === 1 ? '' : 's'}`;
    render();
  }

  // ------------------------------------------------------------------ events

  results.addEventListener('click', e => {
    const row = e.target.closest('.fr, .mr');
    if (!row) return;
    const fi = +row.dataset.f, mj = row.dataset.m === undefined ? undefined : +row.dataset.m;
    cur = mj === undefined ? `f${fi}` : `m${fi}:${mj}`;
    const act = e.target.closest('.fd-act');
    if (act) {
      if (act.dataset.act === 'dismiss') dismiss(fi, mj);
      else if (mj === undefined) replaceFile(fi);
      else replaceOne(fi, mj);
      return;
    }
    if (mj === undefined) { files[fi].collapsed = !files[fi].collapsed; render(); }
    else { openMatch(files[fi], files[fi].matches[mj], false); results.querySelectorAll('.cur').forEach(n => n.classList.remove('cur')); row.classList.add('cur'); }
  });
  results.addEventListener('dblclick', e => {
    const row = e.target.closest('.mr');
    if (row && !e.target.closest('.fd-act')) openMatch(files[+row.dataset.f], files[+row.dataset.f].matches[+row.dataset.m], true);
  });

  /** Rows in display order as [key, fileIndex, matchIndex|undefined]. */
  function rows() {
    const out = [];
    files.forEach((f, i) => {
      out.push([`f${i}`, i]);
      if (!f.collapsed) f.matches.forEach((_, j) => out.push([`m${i}:${j}`, i, j]));
    });
    return out;
  }

  results.addEventListener('keydown', e => {
    const list = rows();
    let at = list.findIndex(r => r[0] === cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      at = Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      if (e.key === 'ArrowUp' && cur === list[0][0]) { query.focus(); query.select(); e.preventDefault(); return; }
      cur = list[at][0];
      results.querySelectorAll('.cur').forEach(n => n.classList.remove('cur'));
      const [, fi, mj] = list[at];
      const el = results.querySelector(mj === undefined ? `.fr[data-f="${fi}"]` : `.mr[data-f="${fi}"][data-m="${mj}"]`);
      if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'nearest' }); }
    } else if (at >= 0 && ['Enter', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(e.key)) {
      const [, fi, mj] = list[at], f = files[fi];
      if (e.key === 'Delete' || e.key === 'Backspace') dismiss(fi, mj);
      else if (mj === undefined) {
        if (e.key === 'Enter' || (e.key === 'ArrowLeft') === !f.collapsed) { f.collapsed = !f.collapsed; render(); }
      } else if (e.key === 'Enter') openMatch(f, f.matches[mj], e.metaKey || e.shiftKey);
      else return;
    } else return;
    e.preventDefault();
  });

  // No Undo/Select All menu roles (they'd hijack Monaco's own cmd+z / cmd+a), so the inputs handle them themselves.
  function inputKeys(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'a') e.target.select();
    else if (k === 'z') document.execCommand(e.shiftKey ? 'redo' : 'undo');
    else return false;
    e.preventDefault();
    return true;
  }

  function toggleOpt(name) {
    flags[name] = !flags[name];
    document.querySelector(`.fd-opts [data-o="${name}"]`).classList.toggle('on', flags[name]);
    schedule(0);
  }
  const optKeys = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' };
  $('#find').addEventListener('keydown', e => {
    if (e.metaKey && e.altKey && optKeys[e.code]) { toggleOpt(optKeys[e.code]); e.preventDefault(); }
    else if (e.metaKey && e.shiftKey && e.code === 'KeyJ') { toggleDetails(); e.preventDefault(); }
  });
  document.querySelectorAll('.fd-opts [data-o]').forEach(b => b.addEventListener('click', () => { toggleOpt(b.dataset.o); query.focus(); }));

  function toggleDetails() { $('#fdDetails').hidden = !$('#fdDetails').hidden; }
  $('#fdDetailsBtn').addEventListener('click', toggleDetails);

  function setReplace(on) {
    $('#fdRepField').hidden = !on;
    $('#fdRepToggle').classList.toggle('open', on);
    if (files.length) render();
  }
  $('#fdRepToggle').addEventListener('click', () => { setReplace(!replacing()); if (replacing()) replace.focus(); });

  for (const input of [query, inc, exc]) {
    input.addEventListener('input', () => schedule());
    input.addEventListener('keydown', e => {
      if (inputKeys(e)) return;
      if (e.key === 'Enter') run();
      else if (e.key === 'ArrowDown' && files.length) {
        results.focus();
        cur = cur || 'f0';
        render();
        e.preventDefault();
      }
    });
  }
  replace.addEventListener('input', () => { if (files.length) render(); });
  replace.addEventListener('keydown', e => {
    if (inputKeys(e)) return;
    if (e.key === 'Enter') replaceAll();
  });
  $('#fdReplaceAll').addEventListener('click', replaceAll);

  $('#fdRefresh').addEventListener('click', run);
  $('#fdClear').addEventListener('click', () => { query.value = ''; files = []; state = 'idle'; seq++; setError(''); render(); query.focus(); });
  $('#fdCollapse').addEventListener('click', () => { const all = files.every(f => f.collapsed); files.forEach(f => { f.collapsed = !all; }); render(); });

  // ------------------------------------------------------------------ hooks for the editor / app

  window.harborFind = {
    /** Show the view: focus the query, seeded with the editor's selection. */
    open() {
      const sel = E.selectedText();
      if (sel) query.value = sel;
      query.focus();
      query.select();
      if (sel || stale) run();
    },
    shown(on) {
      visible = on;
      if (on && stale && query.value) run();
    },
    // ---- the '#' mode of the command palette (app.js) shares this view's options, replace text and replace logic
    getOpts: () => ({ ...flags, include: inc.value, exclude: exc.value, replace: replace.value, replacing: replacing() }),
    /** Set any of query, matchCase, wholeWord, regex, include, exclude, replace, replacing; results turn stale, nothing runs. */
    setOpts(p) {
      for (const k of Object.keys(flags)) {
        if (!(k in p)) continue;
        flags[k] = !!p[k];
        document.querySelector(`.fd-opts [data-o="${k}"]`).classList.toggle('on', flags[k]);
      }
      if ('query' in p) query.value = p.query;
      if ('include' in p) inc.value = p.include;
      if ('exclude' in p) exc.value = p.exclude;
      if ('replace' in p) replace.value = p.replace;
      if ('replacing' in p && p.replacing !== replacing()) setReplace(p.replacing);
      if (inc.value || exc.value) $('#fdDetails').hidden = false;
      stale = true;
    },
    run,
    /** What `text` (a match of the palette's query) becomes. */
    replacement,
    /** Replace match `m` of workspace-relative file `rel` for `q` → number replaced. */
    replaceMatch: (rel, m, q) => replaceIn({ path: `${E.root}/${rel}` }, [m], { ...opts(), query: q }),
    /** Search `q` without a result limit, then Replace All → the summary, or null if declined. */
    async replaceAll(q) {
      query.value = q;
      await run();
      await replaceAll();
      return state === 'replaced' ? note : null;
    },
    /** The active workspace changed: results belong to the old one. */
    rootChanged() {
      if (E.root === searchedRoot) return;
      files = []; state = 'idle'; seq++; render();
      stale = true;
      if (visible && query.value) run();
    },
  };
})();
