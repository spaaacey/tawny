import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { tawnyChat } from '../components/chat';
import { openFile } from '../components/editor/api';
import { getApp } from '../store';
import { activeWorkspace, allWorkspaces } from './selectors';
import { H } from './tawny';
import { theme } from './theme';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ready: boolean;
  /** output that arrived before the replayed scrollback finished writing */
  pending: string[];
}

const terms = new Map<string, TermEntry>();

const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*(?::\d+){0,2}/g;

/** The xterm for session `id`, created on first use inside the hidden #termHold (the layout moves it into a pane). */
export function getTerm(id: string): TermEntry {
  const existing = terms.get(id);
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  document.getElementById('termHold')?.appendChild(el);
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
    fontSize: 13,
    theme: theme.xterm(),
    cursorBlink: true,
    scrollback: 10000,
    minimumContrastRatio: 4.5, // TUIs that paint their own selection bg (Claude Code) otherwise leave light text on light blue
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    /* falls back to the DOM renderer */
  }
  // replayed scrollback holds old terminal queries (DA1/DA2/DECRQM from tmux); answering
  // them again would leak the replies into the shell as typed text
  let replaying = true;
  term.onData((d) => {
    if (!replaying) H.writeAgent(id, d);
  });
  term.onResize(({ cols, rows }) => H.resizeAgent(id, cols, rows));
  // cmd+arrows / backspace edit the line like a normal mac terminal
  // xterm.js: returning false means "handled, skip default"
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.metaKey && e.altKey) return false; // app shortcuts (menu accelerators), not terminal input
    if (e.metaKey && e.key === 'k') return false; // tab switcher (menu accelerator)
    if (e.metaKey && e.key === 'ArrowLeft') {
      H.writeAgent(id, '\x01');
      return false;
    }
    if (e.metaKey && e.key === 'ArrowRight') {
      H.writeAgent(id, '\x05');
      return false;
    }
    if (e.metaKey && e.key === 'Backspace') {
      H.writeAgent(id, '\x15');
      return false;
    }
    return true;
  });
  // cmd+click a file path in the output (optionally :line:col) to open it in the editor
  const cwdOf = () => {
    const app = getApp();
    const prefix = app.sessions.find((x) => x.id === id)?.prefix;
    return allWorkspaces(app).find((w) => w.prefix === prefix)?.path || activeWorkspace(app)?.path || '';
  };
  const resolved = new Map<string, Promise<string | null>>(); // "cwd\0text" -> absolute path | null
  const resolve = (text: string) => {
    const cwd = cwdOf();
    const key = `${cwd}\0${text}`;
    if (!resolved.has(key)) {
      if (resolved.size > 500) resolved.clear();
      resolved.set(
        key,
        H.resolveFile(cwd, text).catch(() => null),
      );
    }
    return resolved.get(key) as Promise<string | null>;
  };
  term.registerLinkProvider({
    async provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true);
      if (!line) return cb(undefined);
      const links = [];
      for (const m of line.matchAll(PATH_RE)) {
        const text = m[0].replace(/[.,;:)\]]+$/, '');
        if (!text.includes('/') && !/\.\w+$/.test(text)) continue;
        const parsed = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(text);
        if (!parsed) continue;
        const [, file, ln, col] = parsed;
        const abs = await resolve(file);
        if (!abs) continue;
        const at = m.index ?? 0;
        links.push({
          range: { start: { x: at + 1, y }, end: { x: at + text.length + 1, y } },
          text,
          activate: (e: MouseEvent) => {
            if (!e.metaKey) return;
            openFile(abs, ln ? { selection: { lineNumber: +ln, column: +(col || 1) } } : {});
          },
        });
      }
      cb(links.length ? links : undefined);
    },
  });
  const entry: TermEntry = { term, fit, el, ready: false, pending: [] };
  terms.set(id, entry);
  new ResizeObserver(() => fitTerm(entry)).observe(el);
  H.agentBuffer(id).then((buf) => {
    const live = () => {
      replaying = false;
      for (const d of entry.pending) term.write(d);
      entry.pending = [];
      entry.ready = true;
    };
    if (buf) term.write(buf, live);
    else live();
  });
  // drop files from Finder/editor -> paste their paths
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => H.pathFor(f)).filter(Boolean);
    const txt = files.length
      ? files.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
      : (e.dataTransfer?.getData('text/plain') ?? '');
    if (txt) H.writeAgent(id, `${txt} `);
    term.focus();
  });
  return entry;
}

export function fitTerm(t: TermEntry | undefined) {
  if (!t || t.el.hidden || !t.el.offsetWidth) return;
  try {
    t.fit.fit();
  } catch {
    /* not ready */
  }
}

export function fitAll() {
  for (const t of terms.values()) fitTerm(t);
}

export function focusTermNow(id: string) {
  requestAnimationFrame(() => terms.get(id)?.term.focus());
}

export function retheme() {
  for (const t of terms.values()) t.term.options.theme = theme.xterm();
}

/** Wire the main process's pty output / exit events into the terminals. */
export function listenTerminals() {
  const offData = H.onAgentData((id, d) => {
    const t = terms.get(id);
    if (!t) return;
    if (t.ready) t.term.write(d);
    else t.pending.push(d);
  });
  const offExit = H.onAgentExit((id) => {
    const t = terms.get(id);
    if (t) {
      t.term.dispose();
      t.el.remove();
      terms.delete(id);
    }
    tawnyChat.dispose(id);
  });
  return () => {
    offData();
    offExit();
  };
}
