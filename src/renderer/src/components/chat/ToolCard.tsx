import {
  ArrowRightIcon,
  DownloadIcon,
  FileTextIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { Editor } from '../../lib/legacy';
import { Chevron } from '../Chevron';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import type { ChatController } from './controller';
import { Terminal } from './Terminal';
import { ToolCode, ToolHeader, ToolContent as ToolPanel, Tool as ToolRoot } from './Tool';
import type { PermRequest, Tool, ToolContent } from './types';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escapes
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const KIND_GLYPH: Record<string, string> = {
  read: '≡',
  edit: '✎',
  delete: '✕',
  move: '→',
  search: '⌕',
  execute: '$',
  think: '…',
  fetch: '↓',
  switch_mode: '⇄',
  other: '•',
};
const KIND_ICON: Record<string, ReactNode> = {
  read: <FileTextIcon />,
  edit: <PencilIcon />,
  delete: <Trash2Icon />,
  move: <ArrowRightIcon />,
  search: <SearchIcon />,
  fetch: <DownloadIcon />,
};
/** Lookups (read/search) recede; edits and runs keep full strength. */
const QUIET_KINDS = new Set(['read', 'search']);
const MAX_TEXT = 20000;
const clip = (s: string) =>
  s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters)` : s;
const baseName = (p: string) => String(p).split('/').pop();

// Syntax-highlighted lines per (path, text), filled in by Monaco's colorizer; subscribers re-render when one lands.
const colored = new Map<string, string[] | null>();
const colorListeners = new Set<() => void>();
let colorVer = 0;
const subscribeColor = (fn: () => void) => {
  colorListeners.add(fn);
  return () => colorListeners.delete(fn);
};
function coloredLines(text: string, path: string) {
  const key = `${path}\0${text}`;
  if (!colored.has(key)) {
    colored.set(key, null);
    Editor()
      .colorizeLines(text, path)
      .then((lines: string[] | null) => {
        colored.set(key, lines);
        if (lines) {
          colorVer++;
          for (const fn of colorListeners) fn();
        }
      });
    if (colored.size > 200) colored.delete(colored.keys().next().value as string);
  }
  return colored.get(key) ?? null;
}

/** Short human title for a call: bash `description`, else the first command's leading words (the row below shows the full command), else the tool title. */
export function toolLabel(t: Tool) {
  const d = t.rawInput?.description?.trim();
  if (d) return d;
  const cmd = t.kind === 'execute' ? String(t.rawInput?.command || '').trim() : '';
  if (!cmd) return String(t.title || 'Tool').split('\n')[0];
  const first = cmd.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean)[0] ?? cmd;
  return first
    .replace(/^[\s(]+/, '')
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
}

export function Mark({ status }: { status?: string }) {
  if (status === 'completed') return <span className="ok">✓</span>;
  if (status === 'failed') return <span className="bad">✗</span>;
  return <span className="spin" />;
}

/** Status mark with the call's duration when known. */
function Status({ ctl, id, status }: { ctl: ChatController; id: string; status?: string }) {
  const d = ctl.duration(id);
  return (
    <>
      {d ? <span className="mr-1 text-[11px] opacity-60">{d}</span> : null}
      <Mark status={status || 'pending'} />
    </>
  );
}

/** Header row content (glyph, title, status); wrap in a CollapsibleTrigger or a `.th` div. */
export function ToolHead({ t }: { t: Tool }) {
  const title = String(t.title || 'Tool').split('\n')[0];
  return (
    <>
      <span className="ti">{KIND_GLYPH[t.kind ?? ''] || KIND_GLYPH.other}</span>
      <span className="tt">{title}</span>
      <span className="ts">
        <Mark status={t.status || 'pending'} />
      </span>
    </>
  );
}

/** Changed lines of a `diff` content item with 2 lines of context; "Open diff" shows it in a Monaco diff tab. */
function Diff({ c, ctl, toolId, di }: { c: ToolContent; ctl: ChatController; toolId: string; di: number }) {
  useSyncExternalStore(subscribeColor, () => colorVer);
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
  const rows: { key: string; cls: string; sign: string; html: string | null; raw: string }[] = [];
  const add = (cls: string, sign: string, html: string[] | null, lines: string[], i: number) =>
    rows.push({ key: `${sign}${i}${cls}`, cls, sign, html: html?.[i] ?? null, raw: lines[i] });
  for (let i = Math.max(0, s - ctx); i < s; i++) add('', ' ', ca, a, i);
  for (let i = s; i < a.length - e; i++) add('del', '-', ca, a, i);
  for (let i = s; i < b.length - e; i++) add('add', '+', cb, b, i);
  for (let i = a.length - e; i < Math.min(a.length, a.length - e + ctx); i++) add('', ' ', ca, a, i);
  const open = () => {
    const full = (ctl.model.tools[toolId].content || []).filter((x) => x.type === 'diff')[di];
    if (full) Editor().openTextDiff(full.path as string, full.oldText, full.newText);
  };
  return (
    <>
      <div className="tdiff-path">
        <span>{c.path || ''}</span>
        <Button variant="secondary" size="sm" onClick={open}>
          Open diff
        </Button>
      </div>
      <div className="tdiff">
        {rows.map((r) => (
          <div key={r.key} className={`dl ${r.cls}`}>
            <span>{r.sign}</span>
            {r.html != null ? (
              <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: r.html }} />
            ) : (
              r.raw
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function ToolBody({ t, ctl }: { t: Tool; ctl: ChatController }) {
  const cmd = t.kind === 'execute' && t.rawInput?.command;
  let di = 0;
  const out = t.terminal?.output.replace(ANSI_RE, '');
  return (
    <>
      {(t.locations || []).map((l) => (
        <span key={`${l.path}:${l.line}`}>
          {/* biome-ignore lint/a11y/useValidAnchor: styled file link */}
          <a className="tloc" href="#" onClick={(e) => openLoc(e, l.path, l.line)}>
            {baseName(l.path)}
            {l.line ? `:${l.line}` : ''}
          </a>{' '}
        </span>
      ))}
      {cmd ? <ToolCode>{`$ ${cmd}`}</ToolCode> : null}
      {(t.content || []).map((c, i) => {
        const key = `${c.type}${i}`;
        if (c.type === 'diff') return <Diff key={key} c={c} ctl={ctl} toolId={t.toolCallId} di={di++} />;
        if (c.type === 'content' && c.content?.type === 'text' && !(t.terminal && t.kind === 'execute'))
          return <ToolCode key={key}>{clip(c.content.text ?? '')}</ToolCode>;
        if (c.type === 'text') return <ToolCode key={key}>{clip(c.text ?? '')}</ToolCode>;
        return null;
      })}
      {out ? <ToolCode>{clip(out)}</ToolCode> : null}
      {t.terminal?.exit?.code ? <div className="texit">exit {t.terminal.exit.code}</div> : null}
    </>
  );
}

function openLoc(e: React.MouseEvent, path: string, line?: number) {
  e.preventDefault();
  Editor().openFile(path, line ? { selection: { lineNumber: line, column: 1 } } : {});
}

export function Perm({ r, ctl }: { r: PermRequest; ctl: ChatController }) {
  return (
    <div className="perm">
      {r.options.map((o, i) => (
        <Button
          key={o.optionId}
          variant={String(o.kind || '').startsWith('reject') ? 'destructive' : i === 0 ? 'default' : 'secondary'}
          size="sm"
          onClick={() => ctl.answer(r.reqId, o.optionId)}
        >
          <kbd>{i + 1}</kbd>
          {o.name}
        </Button>
      ))}
    </div>
  );
}

/** Collapsible whose open state survives re-renders (and remounts) through the controller. */
export function Details({
  ctl,
  id,
  dflt = false,
  summary,
  children,
  className,
  triggerClassName,
}: {
  ctl: ChatController;
  id: string;
  dflt?: boolean;
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  triggerClassName?: string;
}) {
  const open = ctl.open[id] ?? dflt;
  return (
    <Collapsible
      className={className}
      open={open}
      onOpenChange={(now) => {
        ctl.setOpen(id, now);
        ctl.emit();
      }}
    >
      <CollapsibleTrigger className={triggerClassName}>{summary}</CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ToolCard({ ctl, id, req }: { ctl: ChatController; id: string; req: PermRequest | null }) {
  const t = ctl.model.tools[id];
  return (
    <div className={`tool k-${t.kind || 'other'} s-${t.status || 'pending'}${req ? ' pending' : ''}`}>
      <ToolDetails ctl={ctl} id={id} req={req} />
    </div>
  );
}

/** Verb dimmed, target (query, path, command) at full strength. */
function Title({ text }: { text: string }) {
  const i = text.indexOf(' ');
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)} <span className="tt-arg">{text.slice(i + 1)}</span>
    </>
  );
}

export function ToolDetails({ ctl, id, req }: { ctl: ChatController; id: string; req: PermRequest | null }) {
  const t = ctl.model.tools[id];
  const open = ctl.open[id] ?? (t.status === 'failed' || !!req);
  const state = t.status === 'failed' ? 'error' : t.status === 'completed' ? 'done' : 'running';
  const cmd = t.kind === 'execute' ? String(t.rawInput?.command || '').trim() : '';
  if (cmd) {
    const output = clip((t.terminal?.output.replace(ANSI_RE, '') ?? '').trim());
    return (
      <Terminal
        command={cmd}
        description={t.rawInput?.description?.trim()}
        output={output}
        running={state === 'running'}
        exitCode={t.terminal?.exit?.code}
        failed={t.status === 'failed'}
        duration={ctl.duration(id)}
        open={ctl.open[id] ?? (t.status === 'failed' || !!req || (state === 'running' && !!output))}
        onOpenChange={(now) => {
          ctl.setOpen(id, now);
          ctl.emit();
        }}
      >
        {req ? <Perm r={req} ctl={ctl} /> : null}
      </Terminal>
    );
  }
  return (
    <ToolRoot
      className={QUIET_KINDS.has(t.kind ?? '') ? 'opacity-70' : undefined}
      open={open}
      onOpenChange={(now) => {
        ctl.setOpen(id, now);
        ctl.emit();
      }}
    >
      <ToolHeader
        icon={KIND_ICON[t.kind ?? ''] ?? <WrenchIcon />}
        title={<Title text={String(t.title || 'Tool').split('\n')[0]} />}
        status={<Status ctl={ctl} id={id} status={t.status} />}
        state={state}
      />
      <ToolPanel className="ml-0 mt-1 border-l-0 pl-0 pr-0">
        <div className="tb">
          <ToolBody t={t} ctl={ctl} />
          {req ? <Perm r={req} ctl={ctl} /> : null}
        </div>
      </ToolPanel>
    </ToolRoot>
  );
}

const GROUP_VERB: Record<string, [string, string, string]> = {
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  delete: ['deleted', 'file', 'files'],
  move: ['moved', 'file', 'files'],
  search: ['searched', 'time', 'times'],
  execute: ['ran', 'command', 'commands'],
  fetch: ['fetched', 'page', 'pages'],
  think: ['thought', 'time', 'times'],
  switch_mode: ['switched mode', '', ''],
  other: ['used', 'other tool', 'other tools'],
};

/** Plain-language summary of a run of tool calls, e.g. "Read 3 files, searched 2 times, ran 1 command". */
function groupLabel(ts: Tool[]) {
  const n: Record<string, number> = {};
  for (const t of ts) {
    const k = t.kind && GROUP_VERB[t.kind] ? t.kind : 'other';
    n[k] = (n[k] || 0) + 1;
  }
  const out = Object.keys(GROUP_VERB)
    .filter((k) => n[k])
    .map((k) => {
      const [verb, one, many] = GROUP_VERB[k];
      return one ? `${verb} ${n[k]} ${n[k] === 1 ? one : many}` : verb;
    })
    .join(', ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function ToolGroup({
  ctl,
  id,
  run,
  running,
}: {
  ctl: ChatController;
  id: string;
  run: { id: string }[];
  running: boolean;
}) {
  const ts = run.map((r) => ctl.model.tools[r.id]);
  const failed = ts.filter((t) => t.status === 'failed').length;
  const cur = ts.filter((t) => !['completed', 'failed'].includes(t.status ?? '')).pop() || ts[ts.length - 1];
  const label = running ? `Running ${ts.indexOf(cur) + 1} of ${ts.length} · ${toolLabel(cur)}` : groupLabel(ts);
  return (
    <div className={`tool-group${failed && !running ? ' has-failed' : ''}`}>
      <Details
        ctl={ctl}
        id={`grp-${id}`}
        triggerClassName="tg-head"
        summary={
          <>
            <span className="tt">{label}</span>
            <span className="tg-chev">
              <Chevron />
            </span>
            <span className="ts">
              {running ? (
                <span className="spin" />
              ) : failed ? (
                <span className="bad">✗ {failed}</span>
              ) : (
                <span className="ok">✓</span>
              )}
            </span>
          </>
        }
      >
        <div className="tg-body">
          {run.map((r) => {
            const t = ctl.model.tools[r.id];
            return (
              <div key={r.id} className={`tool k-${t.kind || 'other'} s-${t.status || 'pending'}`}>
                <ToolDetails ctl={ctl} id={r.id} req={null} />
              </div>
            );
          })}
        </div>
      </Details>
      {running && !(ctl.open[`grp-${id}`] ?? false) ? (
        <div className="tg-live">
          <ToolDetails ctl={ctl} id={cur.toolCallId} req={null} />
        </div>
      ) : null}
    </div>
  );
}
