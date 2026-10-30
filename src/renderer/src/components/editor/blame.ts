// git blame in Monaco: faded text after the cursor line (inline), a per-line column in the line-decorations margin
// (gutter) and a hover card for both. The blame is of the editor buffer (unsaved lines show as uncommitted); the
// decorations ride Monaco's own range tracking between re-blames.
import type * as Monaco from 'monaco-editor';
import { H } from '../../lib/tawny';
import { metaOf, rootFor } from '../../lsp/models';
import { sep } from '../../lsp/protocol';

declare const monaco: typeof Monaco;
type Ed = Monaco.editor.IStandaloneCodeEditor;
type Model = Monaco.editor.ITextModel;

export interface BlameSettings {
  blameInline?: boolean;
  blameGutter?: boolean;
  blameInlineFormat?: string;
  blameGutterFormat?: string;
}
interface Info {
  sha: string;
  author: string;
  time: number;
  summary: string;
  you: boolean;
  uncommitted: boolean;
}
interface Data {
  root: string;
  lines: (Info | undefined)[];
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: user-facing template syntax
const DEFAULT_INLINE = '${author}, ${ago} • ${subject}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: user-facing template syntax
const DEFAULT_GUTTER = '${author} • ${ago}';
const DEBOUNCE = 500;
const GUTTER_MIN_CH = 10;
const GUTTER_MAX_CH = 36;

// ------------------------------------------------------------------ formatting

const UNITS: [string, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];
function ago(time: number) {
  const s = Math.max(0, Date.now() / 1000 - time);
  for (const [name, n] of UNITS) {
    if (s >= n) {
      const v = Math.floor(s / n);
      return `${v} ${name}${v > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}
const dateOf = (time: number) =>
  new Date(time * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const ageBucket = (time: number) => {
  const d = (Date.now() / 1000 - time) / 86400;
  return d < 7 ? 0 : d < 30 ? 1 : d < 180 ? 2 : d < 365 ? 3 : 4;
};

function fmt(template: string, i: Info) {
  const tokens: Record<string, string> = i.uncommitted
    ? { author: 'You', ago: 'Uncommitted', date: 'Uncommitted', sha: '', subject: '' }
    : {
        author: i.you ? 'You' : i.author,
        ago: ago(i.time),
        date: dateOf(i.time),
        sha: i.sha.slice(0, 7),
        subject: i.summary,
      };
  return template.replace(/\$\{(\w+)\}/g, (_, k) => tokens[k] ?? '');
}
/** Trim the separators a blank token (uncommitted lines have no sha / subject) leaves behind. */
const INLINE_MAX = 80;
const clip = (s: string) => (s.length > INLINE_MAX ? `${s.slice(0, INLINE_MAX - 1)}\u2026` : s);
const clean = (s: string) => s.replace(/\s*[•,\-|]\s*$/, '').trim();

// ------------------------------------------------------------------ data

const cache = new Map<string, { vid: number; p: Promise<Data | null> }>(); // path -> blame of that model version

function blameOf(model: Model, path: string): Promise<Data | null> {
  const root = rootFor(path);
  const hit = cache.get(path);
  if (hit && hit.vid === model.getVersionId()) return hit.p;
  const vid = model.getVersionId();
  const p = (async (): Promise<Data | null> => {
    if (!root || !path.startsWith(root + sep)) return null;
    const res = await H.gitBlame(root, path.slice(root.length + 1), model.getValue()).catch(() => null);
    if (!res) return null;
    const lines = res.lines.map((sha) => {
      const c = res.commits[sha];
      return c ? { sha, ...c, uncommitted: /^0+$/.test(sha) } : undefined;
    });
    return { root, lines };
  })();
  cache.set(path, { vid, p });
  return p;
}

// ------------------------------------------------------------------ gutter text: one CSS class per distinct text

const sheet = (() => {
  const el = document.createElement('style');
  document.head.append(el);
  return el;
})();
const textClasses = new Map<string, string>();
function textClass(text: string) {
  let c = textClasses.get(text);
  if (!c) {
    c = `blame-t${textClasses.size}`;
    textClasses.set(text, c);
    sheet.append(`.monaco-editor .${c}::before { content: ${JSON.stringify(text)}; }\n`);
  }
  return c;
}

// ------------------------------------------------------------------ hover card

let card: HTMLElement | null = null;
let cardSha = '';
const messages = new Map<string, string>();
function hideCard() {
  if (card) card.hidden = true;
  cardSha = '';
}
async function showCard(info: Info, root: string, x: number, y: number) {
  if (!card) {
    card = document.createElement('div');
    card.className = 'blame-card';
    document.body.append(card);
  }
  const key = info.sha + info.uncommitted;
  cardSha = key;
  const head = document.createElement('div');
  head.className = 'blame-card-head';
  if (info.uncommitted) head.textContent = 'You • Uncommitted changes';
  else {
    const who = document.createElement('b');
    who.textContent = info.you ? 'You' : info.author;
    head.append(who, ` • ${ago(info.time)} (${new Date(info.time * 1000).toLocaleString()})`);
  }
  const body = document.createElement('div');
  body.className = 'blame-card-body';
  body.textContent = info.uncommitted ? '' : messages.get(info.sha) || info.summary;
  card.replaceChildren(head, body);
  if (!info.uncommitted) {
    const sha = document.createElement('code');
    sha.className = 'blame-card-sha';
    sha.textContent = info.sha.slice(0, 7);
    card.append(sha);
  }
  card.hidden = false;
  const r = card.getBoundingClientRect();
  card.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  card.style.top = `${y + r.height + 24 > window.innerHeight ? Math.max(4, y - r.height - 8) : y + 20}px`;
  if (!info.uncommitted && !messages.has(info.sha)) {
    const msg = await H.gitCommitMessage(root, info.sha).catch(() => '');
    if (msg) messages.set(info.sha, msg);
    if (cardSha === key && msg) body.textContent = msg;
  }
}

// ------------------------------------------------------------------ per-editor controller

const controllers = new WeakMap<Ed, { refresh(): void }>();
const live = new Set<{ path(): string | null; refresh(): void }>();

/** Wire blame into a code editor, or the modified side of a diff editor (only a model backed by a real file blames). */
export function attachBlame(ed: Ed, settings: () => BlameSettings) {
  if (controllers.has(ed)) return;
  const deco = ed.createDecorationsCollection();
  const baseDecoWidth = ed.getOption(monaco.editor.EditorOption.lineDecorationsWidth);
  let data: Data | null = null;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gutterOn = false;
  let content: Monaco.IDisposable | null = null;

  const pathOf = () => metaOf(ed.getModel())?.path ?? null;

  function render() {
    const model = ed.getModel();
    const s = settings();
    const gutter = s.blameGutter !== false;
    const inline = s.blameInline !== false;
    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    let width = 0;
    if (model && data) {
      const n = model.getLineCount();
      if (gutter) {
        const tpl = s.blameGutterFormat || DEFAULT_GUTTER;
        let prev: string | undefined;
        for (let ln = 1; ln <= n; ln++) {
          const info = data.lines[ln - 1];
          if (!info) {
            prev = undefined;
            continue;
          }
          const first = info.sha !== prev;
          prev = info.sha;
          const text = first ? clean(fmt(tpl, info)) : '';
          width = Math.max(width, text.length);
          decos.push({
            range: new monaco.Range(ln, 1, ln, 1),
            options: {
              isWholeLine: true,
              linesDecorationsClassName: `blame-g blame-a${info.uncommitted ? 'u' : ageBucket(info.time)}${text ? ` ${textClass(text)}` : ''}`,
            },
          });
        }
      }
      if (inline) {
        const pos = ed.getPosition();
        const info = pos && data.lines[pos.lineNumber - 1];
        if (pos && info && pos.lineNumber <= n) {
          const text = clip(clean(fmt(s.blameInlineFormat || DEFAULT_INLINE, info)));
          decos.push({
            range: new monaco.Range(
              pos.lineNumber,
              model.getLineMaxColumn(pos.lineNumber),
              pos.lineNumber,
              model.getLineMaxColumn(pos.lineNumber),
            ),
            options: {
              showIfCollapsed: true,
              after: {
                content: text,
                inlineClassName: 'blame-inline',
                cursorStops: monaco.editor.InjectedTextCursorStops.None,
              },
            },
          });
        }
      }
    }
    deco.set(decos);
    const want = gutter && decos.length ? Math.min(GUTTER_MAX_CH, Math.max(GUTTER_MIN_CH, width)) : 0;
    if (want || gutterOn) {
      gutterOn = want > 0;
      ed.updateOptions({ lineDecorationsWidth: want ? `${want + 2}ch` : baseDecoWidth });
    }
  }

  async function load() {
    const model = ed.getModel();
    const path = pathOf();
    const my = ++seq;
    if (!model || !path) {
      data = null;
      render();
      return;
    }
    const d = await blameOf(model, path);
    if (my !== seq || ed.getModel() !== model) return;
    data = d;
    render();
  }

  function schedule(ms = DEBOUNCE) {
    clearTimeout(timer);
    timer = setTimeout(load, ms);
  }

  function watchContent() {
    content?.dispose();
    content = ed.getModel()?.onDidChangeContent(() => schedule()) ?? null;
  }

  ed.onDidChangeModel(() => {
    data = null;
    watchContent();
    render();
    schedule(0);
  });
  let cursorLine = 0;
  ed.onDidChangeCursorPosition((e) => {
    if (e.position.lineNumber === cursorLine) return;
    cursorLine = e.position.lineNumber;
    if (settings().blameInline !== false) render();
  });
  ed.onDidDispose(() => {
    clearTimeout(timer);
    content?.dispose();
    live.delete(handle);
  });

  // hover card over the inline text or a gutter entry
  ed.onMouseMove((e) => {
    const t = e.target;
    const line = t.position?.lineNumber;
    const info = line && data?.lines[line - 1];
    const inInline =
      t.type === monaco.editor.MouseTargetType.CONTENT_TEXT &&
      !!(t.detail as { injectedText?: unknown }).injectedText &&
      line === ed.getPosition()?.lineNumber;
    const inGutter = t.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;
    if (info && data && (inInline || inGutter)) {
      const key = info.sha + info.uncommitted;
      if (key !== cardSha) showCard(info, data.root, e.event.posx, e.event.posy);
    } else hideCard();
  });
  ed.onMouseLeave(hideCard);
  ed.onDidScrollChange(hideCard);

  const handle = {
    path: pathOf,
    refresh: () => schedule(0),
  };
  live.add(handle);
  controllers.set(ed, handle);
  watchContent();
  schedule(0);
}

/** Git moved (commit, checkout, pull...): the blame of every shown file of `root` is stale. */
export function refreshBlame(root: string) {
  for (const p of [...cache.keys()]) if (p.startsWith(root + sep)) cache.delete(p);
  for (const h of live) {
    const p = h.path();
    if (p?.startsWith(root + sep)) h.refresh();
  }
}
