import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../lib/actions';
import { COMMANDS } from '../lib/commands';
import type { FileMatch } from '../lib/editor/fileIndex';
import { fileIndexLoaded, fileMatches, loadFileIndex, openFileResult } from '../lib/editor/fileIndex';
import { H } from '../lib/legacy';
import { paletteBridge } from '../lib/palette-bridge';
import { currentRoot } from '../lsp/models';
import { useStore } from '../store';
import { openFile } from './editor/api';
import { FileRow } from './editor/FileRow';
import { Chevron, ReplaceAll } from './icons';
import { TopDialogContent } from './Overlay';
import { harborFind, showFind } from './tree/find';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { pages as layoutPages, setPage } from './workspace/layoutStore';

type Mode = 'file' | 'cmd' | 'text' | 'sym';
const MODES: Mode[] = ['file', 'cmd', 'text', 'sym'];
const TAB_LABEL: Record<Mode, string> = { file: 'Files', cmd: 'Commands', text: 'Text', sym: 'Symbols' };

const SYM_KINDS = [
  null,
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];
const SYM_LIMIT = 200;
const HASH_LIMIT = 200;
const OPT_KEYS = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' } as const;

interface Match {
  l: number;
  c: number;
  n: number;
  o: number;
  t: string;
}
interface TextHit {
  rel: string;
  m: Match;
}
interface LspSymbol {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range?: { start: { line: number; character: number } } };
}
interface FindOpts {
  query?: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  replace: string;
  replacing: boolean;
}

interface Row {
  key: string;
  title: string;
  run: () => unknown;
  node?: ReactNode;
  hit?: TextHit;
}

const F = () => harborFind;
const findOpts = () => F().getOpts() as FindOpts;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function initialMode(initial: string): { mode: Mode; text: string } {
  const c = initial[0];
  if (c === '>') return { mode: 'cmd', text: initial.slice(1) };
  if (c === '#') return { mode: 'text', text: initial.slice(1) };
  if (c === '@') return { mode: 'sym', text: initial.slice(1) };
  return { mode: 'file', text: initial };
}

const SM_INPUT = 'h-7 px-2 text-xs md:text-xs';

export function Palette() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <TopDialogContent>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <PaletteBody />
      </TopDialogContent>
    </Dialog>
  );
}

// separate component so the focus effect runs once the dialog content is mounted
function PaletteBody() {
  const initial = useStore((s) => s.paletteInitial);
  const close = useStore((s) => s.closeOverlay);
  const start = useMemo(() => initialMode(initial), [initial]);
  const [mode, setModeState] = useState<Mode>(start.mode);
  const [raw, setRaw] = useState(start.text);
  const [sel, setSel] = useState(0);
  const [opts, setOptsState] = useState<FindOpts>(findOpts);
  const [details, setDetails] = useState(() => !!(opts.include || opts.exclude));
  const [indexed, setIndexed] = useState<boolean>(() => fileIndexLoaded());
  const [hits, setHits] = useState<TextHit[]>([]);
  const [hitMsg, setHitMsg] = useState('');
  const [syms, setSyms] = useState<LspSymbol[]>([]);
  const [symMsg, setSymMsg] = useState('');
  const [rerun, setRerun] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = currentRoot();

  const setOpts = (patch: Partial<FindOpts>) => {
    F().setOpts(patch);
    setOptsState(findOpts());
  };

  useEffect(() => {
    input.current?.focus();
    if (initial[0] === '#') input.current?.select(); // typing replaces the seed
  }, [initial]);

  // file mode: wait for the index
  useEffect(() => {
    if (mode !== 'file' || indexed) return;
    let live = true;
    loadFileIndex().then(() => live && setIndexed(true));
    return () => {
      live = false;
    };
  }, [mode, indexed]);

  // text mode: debounced workspace search; results are shared with the Find sidebar's options
  const optsKey = JSON.stringify([opts.matchCase, opts.wholeWord, opts.regex, opts.include, opts.exclude]);
  useEffect(() => {
    if (mode !== 'text') return;
    F().setOpts({ query: raw });
    setHits([]);
    if (!raw || !root) {
      setHitMsg(raw ? 'No folder open' : 'Type to search in files');
      return;
    }
    setHitMsg('Searching…');
    let live = true;
    const id = 1e9 + Math.floor(Math.random() * 1e6); // far from the Find sidebar's ids: they cancel each other's searches
    const t = setTimeout(async () => {
      let found: TextHit[] = [];
      let msg = 'No matches';
      try {
        const r = await H.search(
          root,
          {
            query: raw,
            matchCase: opts.matchCase,
            wholeWord: opts.wholeWord,
            regex: opts.regex,
            include: opts.include,
            exclude: opts.exclude,
            limit: HASH_LIMIT,
          },
          id,
        );
        if ('cancelled' in r) return;
        found = r.files.flatMap((f) => f.matches.map((m) => ({ rel: f.path, m })));
      } catch (e) {
        msg = errMsg(e).replace(/^\/.*\/[a-z]*: /, '');
      }
      if (!live) return;
      setHits(found);
      setHitMsg(msg);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mode, raw, optsKey, root, rerun]);

  // symbol mode: workspace symbols from the running language servers
  useEffect(() => {
    if (mode !== 'sym') return;
    setSyms([]);
    if (!raw || !root) {
      setSymMsg(raw ? 'No folder open' : 'Type a symbol name');
      return;
    }
    setSymMsg('Searching…');
    let live = true;
    const t = setTimeout(async () => {
      const res = await Promise.all(
        ['ruby', 'ts'].map((k) => H.lspRequest(root, k, 'workspace/symbol', { query: raw }).catch(() => null)),
      );
      if (!live) return;
      setSyms(
        res
          .flatMap((r) => r || [])
          .filter((s: LspSymbol) => s.location?.uri.startsWith('file://'))
          .slice(0, SYM_LIMIT),
      );
      setSymMsg(
        res.some(Boolean)
          ? 'No matching symbols'
          : 'No language server running — open a Ruby or TypeScript file (see status bar)',
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mode, raw, root]);

  const rows: Row[] = useMemo(() => {
    if (mode === 'text') {
      return hits
        .filter(({ m, rel }, i, a) => opts.replacing || !i || m.l !== a[i - 1].m.l || a[i - 1].rel !== rel) // one row per line (per match when replacing)
        .map((hit) => {
          const { rel, m } = hit;
          const n = Math.min(m.n, m.t.length - m.o);
          const hitText = m.t.slice(m.o, m.o + n);
          const mid = !opts.replacing ? (
            <b>{hitText}</b>
          ) : opts.replace !== '' ? (
            <>
              <del>{hitText}</del>
              <ins>{F().replacement(hitText) as string}</ins>
            </>
          ) : (
            <del>{hitText}</del>
          );
          return {
            key: `${rel}:${m.l}:${m.c}`,
            hit,
            title: `${rel}:${m.l}`,
            node: (
              <>
                <span className="qm">
                  {m.t.slice(0, m.o)}
                  {mid}
                  {m.t.slice(m.o + n)}
                </span>
                <span className="r">
                  {rel}:{m.l}
                </span>
                {opts.replacing && (
                  <span className="po-act" title="Replace (cmd+enter)">
                    <ReplaceAll />
                  </span>
                )}
              </>
            ),
            run: () =>
              openFile(`${root}/${rel}`, {
                selection: { startLineNumber: m.l, startColumn: m.c + 1, endLineNumber: m.l, endColumn: m.c + 1 + m.n },
              }),
          };
        });
    }
    if (mode === 'sym') {
      return syms.map((s, i) => {
        const path = decodeURIComponent(s.location.uri.slice(7));
        const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const r = s.location.range;
        const line = r ? r.start.line + 1 : 1;
        return {
          key: `${i}:${s.name}`,
          title: s.name,
          node: (
            <>
              <span>
                <span className="cat">{SYM_KINDS[s.kind] || 'Symbol'}: </span>
                {s.name}
                {s.containerName && (
                  <>
                    {' '}
                    <span className="cat">{s.containerName}</span>
                  </>
                )}
              </span>
              <span className="r">
                {rel}:{line}
              </span>
            </>
          ),
          run: () => openFile(path, r ? { selection: { lineNumber: line, column: r.start.character + 1 } } : {}),
        };
      });
    }
    if (mode === 'cmd') {
      const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
      const num = /^\d+$/.test(raw.trim()) ? +raw : 0; // ">2" jumps to page 2
      const pages = (layoutPages() as { i: number; label: string }[]).map(({ i, label }) => ({
        cat: 'Page',
        title: label,
        keys: '',
        run: () => setPage(i),
        n: i + 1,
      }));
      const scored = [...COMMANDS, ...pages]
        .map((c) => {
          if (num && 'n' in c && c.n === num) return { c, score: -1 };
          if (num) return null;
          const hay = `${c.cat}: ${c.title}`.toLowerCase();
          let score = 0;
          for (const w of words) {
            const at = hay.indexOf(w);
            if (at < 0) return null;
            score += at;
          }
          return { c, score };
        })
        .filter((x): x is { c: (typeof COMMANDS)[number]; score: number } => !!x);
      if (words.length) scored.sort((a, b) => a.score - b.score); // stable: ties keep menu order
      return scored.map(({ c }, i) => ({
        key: `${i}:${c.cat}:${c.title}`,
        title: c.title,
        run: c.run,
        node: (
          <>
            <span>
              <span className="cat">{c.cat}: </span>
              {c.title}
            </span>
            {c.keys && <kbd>{c.keys}</kbd>}
          </>
        ),
      }));
    }
    if (!indexed) return [];
    return (fileMatches(raw) as FileMatch[]).map((r) => ({
      key: r.f,
      title: r.f,
      node: <FileRow r={r as FileMatch} />,
      run: () => openFileResult(r),
    }));
  }, [mode, raw, hits, syms, opts.replacing, opts.replace, indexed, root]);

  const emptyMsg =
    mode === 'text'
      ? hitMsg
      : mode === 'sym'
        ? symMsg
        : mode === 'cmd'
          ? 'No matching commands'
          : indexed
            ? 'No matching files'
            : 'Indexing…';
  const cur = Math.min(sel, Math.max(0, rows.length - 1));

  const run = useCallback(
    (i: number) => {
      const c = rows[i];
      close();
      if (c)
        Promise.resolve()
          .then(c.run)
          .catch((e) => toast(`${c.title}: ${errMsg(e)}`));
    },
    [rows, close],
  );

  const setMode = (m: Mode) => {
    setModeState(m);
    setSel(0);
    input.current?.focus();
  };

  const replaceSelected = async () => {
    const hit = rows[cur]?.hit;
    if (!hit || !findOpts().replacing) return;
    try {
      await F().replaceMatch(hit.rel, hit.m, raw);
    } catch (e) {
      return toast(`Replace failed: ${errMsg(e)}`);
    }
    setRerun((n) => n + 1); // search again: the rows after this one have moved up
  };
  const replaceAllHits = async () => {
    if (!raw || !findOpts().replacing) return;
    const note = await F().replaceAll(raw);
    if (note) toast(note);
    setRerun((n) => n + 1);
  };
  const toggleReplace = () => {
    const on = !findOpts().replacing;
    setOpts({ replacing: on });
    setTimeout(() => (on ? document.getElementById('poReplace') : input.current)?.focus());
  };

  // the menu's find-in-files command acts on the mounted palette
  const latest = useRef({ mode, raw });
  latest.current = { mode, raw };
  useEffect(() => {
    paletteBridge.inTextMode = () => latest.current.mode === 'text';
    paletteBridge.toSidebar = () => {
      const q = latest.current.raw;
      close(false);
      showFind();
      F().setOpts({ query: q });
      F().run();
    };
    return () => {
      paletteBridge.inTextMode = () => false;
      paletteBridge.toSidebar = () => {};
    };
  }, [close]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const target = e.currentTarget;
    if (e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault(); // no Select All menu role (see commitMsg in editor.js)
      target.select();
      return;
    }
    const text = mode === 'text';
    const main = target === input.current;
    const edge =
      main &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.ctrlKey &&
      target.selectionStart === target.selectionEnd &&
      (e.key === 'ArrowLeft'
        ? target.selectionStart === 0
        : e.key === 'ArrowRight' && target.selectionStart === target.value.length);
    if (edge) {
      const to = MODES[MODES.indexOf(mode) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (to) setMode(to);
      e.preventDefault();
    } else if (text && e.metaKey && e.altKey && e.code in OPT_KEYS) {
      const k = OPT_KEYS[e.code as keyof typeof OPT_KEYS];
      setOpts({ [k]: !findOpts()[k] });
      e.preventDefault();
    } else if (text && e.metaKey && e.shiftKey && e.code === 'KeyJ') {
      setDetails((d) => !d);
      e.preventDefault();
    } else if (text && e.metaKey && e.shiftKey && e.code === 'KeyH') {
      toggleReplace();
      e.preventDefault();
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      setSel(Math.min(rows.length - 1, cur + 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      setSel(Math.max(0, cur - 1));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (text && e.metaKey) replaceSelected();
      else if (target.id === 'poReplace') replaceAllHits();
      else if (main) run(cur);
    } else if (e.key === 'Backspace' && main && mode !== 'file' && !target.value) setMode('file');
  };

  const onInput = (v: string) => {
    const c = v[0];
    if (mode === 'file' && (c === '>' || c === '#' || c === '@')) {
      setModeState(c === '>' ? 'cmd' : c === '#' ? 'text' : 'sym'); // typing the old prefix still switches
      setRaw(v.slice(1));
    } else setRaw(v);
    setSel(0);
  };

  const placeholder = {
    cmd: 'Type a command…',
    text: 'Search in files…',
    sym: 'Go to symbol in workspace…',
    file: 'Go to file…   (name:line works too)',
  }[mode];

  return (
    <Command
      value={rows[cur]?.key}
      onValueChange={(v) =>
        setSel(
          Math.max(
            0,
            rows.findIndex((r) => r.key === v),
          ),
        )
      }
    >
      <div className="palette-tabs">
        {MODES.map((m) => (
          <button
            type="button"
            key={m}
            className={m === mode ? 'on' : ''}
            onMouseDown={(e) => {
              e.preventDefault();
              setMode(m);
            }}
          >
            {TAB_LABEL[m]}
          </button>
        ))}
        <span>← → switch</span>
      </div>
      <CommandInput
        ref={input}
        spellCheck={false}
        placeholder={placeholder}
        value={raw}
        onValueChange={onInput}
        onKeyDown={onKeyDown}
      />
      {mode === 'text' && (
        <div className="palette-opts">
          <div className="po-row">
            <button
              type="button"
              className={`fd-chev${opts.replacing ? ' open' : ''}`}
              title="Toggle Replace (cmd+shift+h)"
              onClick={toggleReplace}
            >
              <Chevron />
            </button>
            <span className="fd-opts">
              <button
                type="button"
                className={opts.matchCase ? 'on' : ''}
                title="Match Case (cmd+option+c)"
                onClick={() => {
                  setOpts({ matchCase: !opts.matchCase });
                  input.current?.focus();
                }}
              >
                Aa
              </button>
              <button
                type="button"
                className={opts.wholeWord ? 'on' : ''}
                title="Match Whole Word (cmd+option+w)"
                onClick={() => {
                  setOpts({ wholeWord: !opts.wholeWord });
                  input.current?.focus();
                }}
              >
                <u>ab</u>
              </button>
              <button
                type="button"
                className={opts.regex ? 'on' : ''}
                title="Use Regular Expression (cmd+option+r)"
                onClick={() => {
                  setOpts({ regex: !opts.regex });
                  input.current?.focus();
                }}
              >
                .*
              </button>
            </span>
            <button
              type="button"
              className="po-dots"
              title="Toggle Search Details (cmd+shift+j)"
              onClick={() => {
                setDetails((d) => !d);
                input.current?.focus();
              }}
            >
              ⋯
            </button>
            <span className="po-hint">cmd+option+f: open in sidebar</span>
          </div>
          {opts.replacing && (
            <Input
              className={SM_INPUT}
              id="poReplace"
              placeholder="Replace   (enter: replace all, cmd+enter: replace selected)"
              spellCheck={false}
              autoComplete="off"
              value={opts.replace}
              onChange={(e) => setOpts({ replace: e.target.value })}
              onKeyDown={onKeyDown}
            />
          )}
          {details && (
            <div className="po-details">
              <Input
                className={SM_INPUT}
                placeholder="files to include, e.g. *.ts, src/**"
                spellCheck={false}
                autoComplete="off"
                value={opts.include}
                onChange={(e) => {
                  setOpts({ include: e.target.value });
                  setSel(0);
                }}
                onKeyDown={onKeyDown}
              />
              <Input
                className={SM_INPUT}
                placeholder="files to exclude, e.g. **/*.test.ts"
                spellCheck={false}
                autoComplete="off"
                value={opts.exclude}
                onChange={(e) => {
                  setOpts({ exclude: e.target.value });
                  setSel(0);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
          )}
        </div>
      )}
      <CommandList className="max-h-[50vh]">
        <CommandEmpty>{emptyMsg}</CommandEmpty>
        {rows.map((r, i) => {
          const sel = i === cur ? ' sel' : '';
          return (
            <CommandItem
              key={r.key}
              value={r.key}
              onMouseDown={(e) => {
                e.preventDefault();
                if ((e.target as HTMLElement).closest('.po-act')) {
                  setSel(i);
                  replaceSelected();
                } else run(i);
              }}
            >
              <div className={`qrow${sel}`}>{r.node}</div>
            </CommandItem>
          );
        })}
      </CommandList>
    </Command>
  );
}
