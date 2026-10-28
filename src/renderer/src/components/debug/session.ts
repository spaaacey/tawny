import { create } from 'zustand';
import { toast } from '../../lib/actions';
import { H } from '../../lib/harbor';
import { currentRoot } from '../../lsp/models';
import { openFile } from '../editor/api';
import { currentEditor } from '../editor/host';
import { activeFile as activeFilePath } from '../workspace/layoutStore';
import {
  allBreakpoints,
  applyResults,
  attach,
  bpIds,
  clearLine,
  editBreakpoint,
  expressionAt,
  listFor,
  markLine,
  modelCreated,
  removeAll,
  restore,
  setChangedHook,
  setVerified,
  syncOnSave,
  toggleBreakpoint,
} from './breakpoints';

// biome-ignore lint/suspicious/noExplicitAny: DAP payloads are adapter-defined
type Any = any;

export type SessionState = 'starting' | 'running' | 'stopped' | 'ended';
export interface Config {
  name: string;
}
export interface Frame {
  id: number;
  name: string;
  line?: number;
  column?: number;
  presentationHint?: string;
  source?: { path?: string; name?: string };
}
export interface Variable {
  name: string;
  value?: string;
  variablesReference?: number;
}
export interface Scope {
  name: string;
  variablesReference: number;
}
export interface Kids {
  loading?: boolean;
  error?: string;
  vars?: Variable[];
}
export interface Line {
  id: number;
  text: string;
  cls: string;
}

interface Sess {
  sid: number | null;
  name: string;
  root: string;
  state: SessionState;
  focus: { cid: number; threadId: number } | null;
  reason?: string;
  frames: Frame[];
  frameId: number | null;
  frameIdx: number;
  snapshot: ReturnType<typeof allBreakpoints>;
  threads: Map<number, Set<number>>;
}

interface DbgStore {
  open: boolean;
  height?: string;
  configs: Config[];
  chosen: string | null;
  state: SessionState;
  reason?: string;
  frames: Frame[];
  frameIdx: number;
  scopes: Scope[];
  scopeError?: string;
  /** expanded variable paths, kept across steps */
  openVars: Set<string>;
  kids: Record<string, Kids>;
  lines: Line[];
}

export const useDbg = create<DbgStore>(() => ({
  open: false,
  configs: [],
  chosen: null,
  state: 'ended',
  frames: [],
  frameIdx: 0,
  scopes: [],
  openVars: new Set(),
  kids: {},
  lines: [],
}));
const set = useDbg.setState;
const get = useDbg.getState;

const activeFile = () => activeFilePath() ?? undefined;
const editor = () => currentEditor() as Any;

let sess: Sess | null = null;
let early: Any[] = [];
let lineId = 0;
let openLine: { id: number; cls: string } | null = null;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

// ---------------------------------------------------------------- console

export function out(text: string, cls = '') {
  const parts = String(text).split('\n');
  const lines = get().lines.slice();
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (last && p === '' && i > 0) {
      openLine = null;
      return;
    }
    const cur = openLine && openLine.cls === cls ? lines.findIndex((l) => l.id === openLine?.id) : -1;
    if (cur >= 0) lines[cur] = { ...lines[cur], text: lines[cur].text + p };
    else {
      lineId += 1;
      lines.push({ id: lineId, text: p, cls });
      openLine = { id: lineId, cls };
    }
    if (!last) openLine = null;
  });
  if (lines.length > 3000) lines.splice(0, lines.length - 3000);
  set({ lines });
}
export function clearConsole() {
  openLine = null;
  set({ lines: [] });
}

// ---------------------------------------------------------------- panel

export async function loadConfigs() {
  const root = currentRoot();
  if (!root) return;
  let configs: Config[];
  try {
    configs = ((await H.dapConfigs(root, activeFile())) as Config[]) || [];
  } catch {
    configs = [];
  }
  const chosen = configs.some((c) => c.name === get().chosen) ? get().chosen : configs[0]?.name || null;
  set({ configs, chosen });
}
export function showPanel(on: boolean) {
  set({ open: on });
  if (on) loadConfigs();
}
export const setChosen = (chosen: string) => set({ chosen });
export function setHeight(height: string) {
  set({ height });
  H.saveUi({ dbgHeight: height });
}

// ---------------------------------------------------------------- session

const dap = (command: string, args: unknown, cid?: number): Promise<Any> => {
  const s = sess as Sess;
  return H.dapRequest(s.sid as number, cid ?? s.focus?.cid ?? 0, command, args);
};
export const evaluate = (expression: string, context: 'repl' | 'hover') =>
  dap('evaluate', { expression, frameId: sess?.frameId, context });

function sync(state: SessionState) {
  if (!sess) return;
  sess.state = state;
  set({ state, reason: state === 'stopped' ? sess.reason : undefined });
}

export async function start() {
  if (sess && sess.state !== 'ended') return;
  const root = currentRoot();
  if (!root) return;
  early = [];
  showPanel(true);
  const file = activeFile();
  await loadConfigs();
  const cfg = get().configs.find((c) => c.name === get().chosen) || get().configs[0];
  if (!cfg) {
    out('No launch configuration. Open a .js or .rb file, or add one to .vscode/launch.json.', 'err');
    return;
  }
  clearConsole();
  bpIds.clear();
  const s: Sess = {
    sid: null,
    name: cfg.name,
    root,
    state: 'starting',
    focus: null,
    frames: [],
    frameId: null,
    frameIdx: 0,
    snapshot: allBreakpoints(),
    threads: new Map(),
  };
  sess = s;
  set({ state: 'starting', reason: undefined, frames: [], scopes: [], kids: {} });
  try {
    const r = (await H.dapStart(root, cfg as Parameters<typeof H.dapStart>[1], { file }, s.snapshot)) as Any;
    s.sid = r.sid;
    const queued = early;
    early = [];
    for (const ev of queued) if (ev.sid === r.sid) onEvent(ev);
  } catch (e) {
    out(`Failed to start: ${(e as Error).message}`, 'err');
    sync('ended');
  }
}

export function stop() {
  if (!sess || sess.state === 'ended') return;
  if (sess.sid !== null) H.dapStop(sess.sid).catch(() => {});
}

function markRunning() {
  if (!sess) return;
  sess.frames = [];
  sess.frameId = null;
  clearLine();
  sess.state = 'running';
  set({ state: 'running', reason: undefined, frames: [], scopes: [], kids: {} });
}

export async function cont() {
  if (sess?.state !== 'stopped' || !sess.focus) return;
  const threadId = sess.focus.threadId;
  markRunning();
  try {
    await dap('continue', { threadId });
  } catch {
    /* ended */
  }
}
export async function step(kind: 'next' | 'stepIn' | 'stepOut') {
  if (sess?.state !== 'stopped' || !sess.focus) return;
  const threadId = sess.focus.threadId;
  markRunning();
  try {
    await dap(kind, { threadId });
  } catch {
    /* ended */
  }
}
export async function pause() {
  if (sess?.state !== 'running') return;
  const cid = [...sess.threads.keys()][0];
  const tid = cid !== undefined ? [...(sess.threads.get(cid) as Set<number>)][0] : 1;
  try {
    await dap('pause', { threadId: tid ?? 1 }, cid);
  } catch (e) {
    out(`Pause failed: ${(e as Error).message}`, 'err');
  }
}

function endSession() {
  if (!sess) return;
  sess.frames = [];
  sess.frameId = null;
  clearLine();
  out(`— ${sess.name} ended —`, 'dim');
  sess.state = 'ended';
  set({ state: 'ended', reason: undefined, frames: [], scopes: [], kids: {} });
}

function onEvent({ cid, event, body }: Any) {
  const s = sess as Sess;
  body = body || {};
  switch (event) {
    case 'harbor:started':
      if (body.root && s.state === 'starting') sync('running');
      break;
    case 'harbor:breakpoints':
      for (const [path, results] of Object.entries(body.results || {})) {
        const snap = s.snapshot[path];
        const cur = listFor(path);
        if (snap && snap.length === cur.length && snap.every((b, i) => b.line === cur[i].line))
          applyResults(path, cur, results as Any);
      }
      break;
    case 'harbor:error':
      out(body.message, 'err');
      toast(`Debugger: ${body.message}`);
      break;
    case 'harbor:ended':
      endSession();
      break;
    case 'harbor:connClosed':
      s.threads.delete(cid);
      break;
    case 'thread': {
      const threads = s.threads.get(cid) || new Set<number>();
      if (body.reason === 'exited') threads.delete(body.threadId);
      else threads.add(body.threadId);
      s.threads.set(cid, threads);
      break;
    }
    case 'stopped':
      onStopped(cid, body);
      break;
    case 'continued':
      if (s.state === 'stopped' && s.focus && s.focus.cid === cid) markRunning();
      break;
    case 'output': {
      if (body.category === 'telemetry') break;
      const text = String(body.output || '').replace(ANSI, '');
      if (cid === 0 && /^DEBUGGER: /.test(text)) break; // rdbg's own banner
      out(text, body.category === 'stderr' ? 'err' : body.category === 'console' ? 'dim' : '');
      break;
    }
    case 'breakpoint':
      if (body.breakpoint) setVerified(body.breakpoint.id, body.breakpoint.verified !== false);
      break;
  }
}

H.onDapEvent((ev: Any) => {
  if (!sess || sess.sid === null) {
    early.push(ev);
    return;
  }
  if (ev.sid !== sess.sid) return;
  onEvent(ev);
});

async function onStopped(cid: number, body: Any) {
  const s = sess as Sess;
  const threadId = body.threadId ?? 1;
  s.state = 'stopped';
  s.focus = { cid, threadId };
  s.reason = body.reason;
  set({ state: 'stopped', reason: body.reason });
  showPanel(true);
  try {
    const r = await dap('stackTrace', { threadId, levels: 60 }, cid);
    if (sess !== s || s.state !== 'stopped' || s.focus?.threadId !== threadId || s.focus.cid !== cid) return;
    s.frames = r.stackFrames || [];
    set({ frames: s.frames });
    let first = s.frames.findIndex(
      (f) => f.source?.path && f.presentationHint !== 'subtle' && f.presentationHint !== 'label',
    );
    if (first < 0) first = s.frames.findIndex((f) => f.source?.path);
    await selectFrame(Math.max(0, first));
  } catch (e) {
    out(`Stack trace failed: ${(e as Error).message}`, 'err');
  }
}

export async function selectFrame(i: number) {
  const s = sess;
  const f = s?.frames[i];
  if (!s || !f) return;
  s.frameId = f.id;
  s.frameIdx = i;
  set({ frameIdx: i });
  const path = f.source?.path;
  if (path && f.line) {
    await openFile(path, {
      selection: { lineNumber: f.line, column: f.column || 1 },
      recordHistory: false,
      focus: false,
    });
    markLine(path, f.line);
  } else clearLine();
  await loadScopes(f);
}

// ---------------------------------------------------------------- variables

async function loadScopes(frame: Frame) {
  const s = sess;
  if (!s) return;
  try {
    const { scopes } = (await dap('scopes', { frameId: frame.id })) as { scopes: Scope[] };
    if (sess !== s || s.frameId !== frame.id) return;
    const openVars = new Set(get().openVars);
    set({ scopes, scopeError: undefined, kids: {} });
    for (const [i, sc] of scopes.entries()) {
      if (i === 0) openVars.add(sc.name);
      if (openVars.has(sc.name)) await expand(sc.name, sc.variablesReference);
    }
    set({ openVars });
  } catch (e) {
    set({ scopes: [], scopeError: (e as Error).message });
  }
}

async function expand(key: string, ref: number) {
  set((st) => ({ openVars: new Set(st.openVars).add(key), kids: { ...st.kids, [key]: { loading: true } } }));
  let vars: Variable[];
  try {
    vars = ((await dap('variables', { variablesReference: ref })) as Any).variables || [];
  } catch (e) {
    set((st) => ({ kids: { ...st.kids, [key]: { error: (e as Error).message } } }));
    return;
  }
  set((st) => ({ kids: { ...st.kids, [key]: { vars } } }));
  for (const v of vars) {
    const k = `${key}/${v.name}`;
    if ((v.variablesReference || 0) > 0 && get().openVars.has(k)) await expand(k, v.variablesReference as number);
  }
}

export function toggleVar(key: string, ref: number) {
  if (!ref) return;
  if (get().openVars.has(key)) {
    set((st) => {
      const openVars = new Set(st.openVars);
      openVars.delete(key);
      return { openVars };
    });
  } else expand(key, ref);
}

// ---------------------------------------------------------------- repl

const hist: string[] = [];
let hi = 0;
export function historyStep(dir: -1 | 1) {
  hi = Math.max(0, Math.min(hist.length, hi + dir));
  return hist[hi] || '';
}
export async function submitExpr(expr: string) {
  hist.push(expr);
  hi = hist.length;
  out(`› ${expr}`, 'in');
  if (sess?.state !== 'stopped') {
    out('Not paused — expressions are evaluated at a breakpoint.', 'dim');
    return;
  }
  try {
    const r = await evaluate(expr, 'repl');
    out(String(r.result ?? ''), 'res');
    if (sess.state === 'stopped') loadScopes(sess.frames[sess.frameIdx]); // evaluation may have changed state
  } catch (err) {
    out((err as Error).message, 'err');
  }
}

// ---------------------------------------------------------------- hooks

setChangedHook(async (path) => {
  if (!path || !sess || sess.state === 'ended') return;
  const list = listFor(path);
  try {
    applyResults(path, list, (await H.dapBreakpoints(sess.sid as number, path, list)) as Any);
  } catch {
    /* session ended */
  }
});

function registerHover() {
  window.monaco.languages.registerHoverProvider(['javascript', 'typescript', 'ruby'], {
    async provideHover(model, pos) {
      if (sess?.state !== 'stopped' || sess.frameId == null) return null;
      const sel = editor()?.getSelection();
      const inSel = sel && !sel.isEmpty() && sel.containsPosition(pos) && sel.startLineNumber === sel.endLineNumber;
      const target = inSel ? { expr: model.getValueInRange(sel), range: sel } : expressionAt(model, pos);
      if (!target) return null;
      try {
        const r = await evaluate(target.expr, 'hover');
        if (r.result === undefined || r.result === '') return null;
        return {
          range: target.range,
          contents: [{ value: `\`\`\`text\n${target.expr} = ${String(r.result).slice(0, 1000)}\n\`\`\`` }],
        };
      } catch {
        return null;
      }
    },
  });
}

/** F5/F9/F10/F11 are claimed by Monaco in some contexts and by nothing in others; take them globally. */
window.addEventListener(
  'keydown',
  (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idle = !sess || sess.state === 'ended';
    let handled = true;
    switch (e.key) {
      case 'F5':
        if (e.shiftKey) stop();
        else if (idle) start();
        else cont();
        break;
      case 'F9':
        toggleAtCursor();
        break;
      case 'F10':
        step('next');
        break;
      case 'F11':
        step(e.shiftKey ? 'stepOut' : 'stepIn');
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

function toggleAtCursor() {
  const ed = editor();
  if (ed?.getModel() && ed.getPosition()) toggleBreakpoint(ed.getModel().uri.path, ed.getPosition().lineNumber);
}

function init(ui?: { breakpoints?: Any; dbgHeight?: string }) {
  restore(ui);
  if (ui?.dbgHeight) set({ height: ui.dbgHeight });
  registerHover();
}

/** What the editor, the command palette and the menu call. */
export const harborDebug = {
  init,
  attach,
  modelCreated,
  saved: syncOnSave,
  start,
  stop,
  cont,
  pause,
  step,
  toggleBreakpoint: toggleAtCursor,
  removeAll: () => removeAll(!!sess && sess.state !== 'ended'),
  togglePanel: () => showPanel(!get().open),
  showPanel: () => showPanel(true),
  condBreakpoint: (field: 'condition' | 'logMessage') => {
    const ed = editor();
    if (ed?.getModel() && ed.getPosition()) editBreakpoint(ed.getModel().uri.path, ed.getPosition().lineNumber, field);
  },
  get active() {
    return !!sess && sess.state !== 'ended';
  },
};
