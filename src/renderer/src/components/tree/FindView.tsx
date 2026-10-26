import { Fragment, useEffect, useRef } from 'react';
import { iconSrc } from '../../lib/fileicons';
import { Chevron, ReplaceAll } from '../icons';
import {
  clear,
  collapseAll,
  dismiss,
  type FileHit,
  type Flag,
  type Match,
  openMatch,
  replaceAll,
  replaceFile,
  replacement,
  replaceOne,
  run,
  schedule,
  setCur,
  setField,
  setReplacing,
  toggleFile,
  toggleFlag,
  useFind,
} from './find';
import { baseName } from './store';

const Svg = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const ICON = {
  replace: 'M2.5 5.5h8.5M8.5 3l2.5 2.5L8.5 8M13.5 10.5H5M7.5 8 5 10.5 7.5 13',
  dismiss: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
  clear: 'M3 4.5h10M3 8h10M3 11.5h6M11 10.5l3 3M14 10.5l-3 3',
  collapse: 'M4 6l4-3 4 3M4 10l4 3 4-3',
};

const Act = ({ act, title, onClick }: { act: keyof typeof ICON; title: string; onClick: () => void }) => (
  <span
    className="fd-act"
    title={title}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
  >
    <Svg d={ICON[act]} />
  </span>
);

function MatchText({ m, replacing, repl }: { m: Match; replacing: boolean; repl: string }) {
  const n = Math.min(m.n, m.t.length - m.o);
  const pre = m.t.slice(0, m.o);
  const hit = m.t.slice(m.o, m.o + n);
  const post = m.t.slice(m.o + n);
  return (
    <>
      {pre}
      {replacing ? (
        <>
          <del>{hit}</del>
          {repl !== '' && <ins>{replacement(hit)}</ins>}
        </>
      ) : (
        <mark>{hit}</mark>
      )}
      {post}
    </>
  );
}

const OPTS: { name: Flag; title: string; label: React.ReactNode }[] = [
  { name: 'matchCase', title: 'Match Case (cmd+option+c)', label: 'Aa' },
  { name: 'wholeWord', title: 'Match Whole Word (cmd+option+w)', label: <u>ab</u> },
  { name: 'regex', title: 'Use Regular Expression (cmd+option+r)', label: '.*' },
];
const OPT_KEYS: Record<string, Flag> = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' };

/** No Undo/Select All menu roles (they'd hijack Monaco's own cmd+z / cmd+a), so the inputs handle them themselves. */
function inputKeys(e: React.KeyboardEvent<HTMLInputElement>) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k === 'a') e.currentTarget.select();
  else if (k === 'z') document.execCommand(e.shiftKey ? 'redo' : 'undo');
  else return false;
  e.preventDefault();
  return true;
}

export function FindView() {
  const s = useFind();
  const { files, status, cur, replacing } = s;
  const query = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!s.focusTick) return;
    query.current?.focus();
    query.current?.select();
  }, [s.focusTick]);

  useEffect(() => {
    results.current?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const count = files.reduce((n, f) => n + f.matches.length, 0);
  const summary =
    status === 'searching'
      ? 'Searching…'
      : status === 'replaced'
        ? s.note
        : status === 'done'
          ? count
            ? `${count}${s.truncated ? '+' : ''} result${count === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${s.truncated ? ' (limited)' : ''}`
            : 'No results found'
          : '';

  /** Rows in display order as [key, fileIndex, matchIndex|undefined]. */
  const rows = () => {
    const out: [string, number, number | undefined][] = [];
    files.forEach((f, i) => {
      out.push([`f${i}`, i, undefined]);
      if (!f.collapsed) for (let j = 0; j < f.matches.length; j++) out.push([`m${i}:${j}`, i, j]);
    });
    return out;
  };

  const onResultKeys = (e: React.KeyboardEvent) => {
    const list = rows();
    let at = list.findIndex((r) => r[0] === cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      if (e.key === 'ArrowUp' && cur === list[0][0]) {
        query.current?.focus();
        query.current?.select();
        e.preventDefault();
        return;
      }
      at = Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      setCur(list[at][0]);
    } else if (at >= 0 && ['Enter', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(e.key)) {
      const [, fi, mj] = list[at];
      const f = files[fi];
      if (e.key === 'Delete' || e.key === 'Backspace') dismiss(fi, mj);
      else if (mj === undefined) {
        if (e.key === 'Enter' || (e.key === 'ArrowLeft') === !f.collapsed) toggleFile(fi);
      } else if (e.key === 'Enter') openMatch(f, f.matches[mj], e.metaKey || e.shiftKey);
      else return;
    } else return;
    e.preventDefault();
  };

  const onFindKeys = (e: React.KeyboardEvent) => {
    if (e.metaKey && e.altKey && OPT_KEYS[e.code]) {
      toggleFlag(OPT_KEYS[e.code]);
      e.preventDefault();
    } else if (e.metaKey && e.shiftKey && e.code === 'KeyJ') {
      setField({ details: !s.details });
      e.preventDefault();
    }
  };

  const inputProps = (field: 'query' | 'include' | 'exclude') => ({
    value: s[field],
    spellCheck: false,
    autoComplete: 'off',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setField({ [field]: e.target.value });
      schedule();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (inputKeys(e)) return;
      if (e.key === 'Enter') run();
      else if (e.key === 'ArrowDown' && files.length) {
        results.current?.focus();
        setCur(cur || 'f0');
        e.preventDefault();
      }
    },
  });

  const fileRows = (f: FileHit, i: number) => {
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    return (
      <>
        <div
          className={`fr${cur === `f${i}` ? ' cur' : ''}`}
          title={f.rel}
          onClick={() => {
            setCur(`f${i}`);
            toggleFile(i);
          }}
        >
          <span className={`tw${f.collapsed ? '' : ' open'}`}>
            <Chevron />
          </span>
          <img className="ti" src={iconSrc(baseName(f.rel), 'file')} draggable={false} alt="" />
          <span className="fr-name">{baseName(f.rel)}</span>
          <span className="fr-dir">{dir}</span>
          <span className="fd-acts">
            {replacing && <Act act="replace" title="Replace All in File" onClick={() => replaceFile(i)} />}
            <Act act="dismiss" title="Dismiss" onClick={() => dismiss(i)} />
          </span>
          <span className="cn-n">{f.matches.length}</span>
        </div>
        {!f.collapsed &&
          f.matches.map((m, j) => (
            <div
              key={`${m.l}:${m.c}`}
              className={`mr${cur === `m${i}:${j}` ? ' cur' : ''}`}
              onClick={() => {
                setCur(`m${i}:${j}`);
                openMatch(f, m, false);
              }}
              onDoubleClick={() => openMatch(f, m, true)}
            >
              <span className="mr-t">
                <MatchText m={m} replacing={replacing} repl={s.replace} />
              </span>
              <span className="fd-acts">
                {replacing && <Act act="replace" title="Replace" onClick={() => replaceOne(i, j)} />}
                <Act act="dismiss" title="Dismiss" onClick={() => dismiss(i, j)} />
              </span>
            </div>
          ))}
      </>
    );
  };

  return (
    <div id="find" onKeyDown={onFindKeys}>
      <div className="fd-form">
        <div className="fd-row">
          <button
            type="button"
            id="fdRepToggle"
            className={`fd-chev${replacing ? ' open' : ''}`}
            title="Toggle Replace"
            onClick={() => setReplacing(!replacing)}
          >
            <Chevron />
          </button>
          <div className="fd-fields">
            <div className="fd-field">
              <input id="fdQuery" ref={query} placeholder="Find" {...inputProps('query')} />
              <span className="fd-opts">
                {OPTS.map((o) => (
                  <button
                    type="button"
                    key={o.name}
                    className={s[o.name] ? 'on' : ''}
                    title={o.title}
                    onClick={() => {
                      toggleFlag(o.name);
                      query.current?.focus();
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </span>
            </div>
            {replacing && (
              <div className="fd-field" id="fdRepField">
                <input
                  id="fdReplace"
                  placeholder="Replace"
                  spellCheck={false}
                  autoComplete="off"
                  value={s.replace}
                  // biome-ignore lint/a11y/noAutofocus: the field was just revealed by the toggle
                  autoFocus
                  onChange={(e) => setField({ replace: e.target.value })}
                  onKeyDown={(e) => {
                    if (inputKeys(e)) return;
                    if (e.key === 'Enter') replaceAll();
                  }}
                />
                <span className="fd-opts">
                  <button type="button" id="fdReplaceAll" title="Replace All (enter)" onClick={replaceAll}>
                    <ReplaceAll />
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          id="fdDetailsBtn"
          className="fd-dots"
          title="Toggle Search Details (cmd+shift+j)"
          onClick={() => setField({ details: !s.details })}
        >
          ⋯
        </button>
        {s.details && (
          <div id="fdDetails">
            <label>
              files to include
              <input placeholder="e.g. *.ts, src/**" {...inputProps('include')} />
            </label>
            <label>
              files to exclude
              <input placeholder="e.g. **/*.test.ts" {...inputProps('exclude')} />
            </label>
          </div>
        )}
        {s.error && <div id="fdErr">{s.error}</div>}
      </div>
      {status !== 'idle' && (
        <div id="fdSummary">
          <span id="fdCount">{summary}</span>
          <span className="fd-acts">
            <button type="button" id="fdRefresh" title="Refresh" onClick={run}>
              <Svg d={ICON.refresh} />
            </button>
            <button type="button" id="fdClear" title="Clear Results" onClick={clear}>
              <Svg d={ICON.clear} />
            </button>
            <button type="button" id="fdCollapse" title="Collapse All" onClick={collapseAll}>
              <Svg d={ICON.collapse} />
            </button>
          </span>
        </div>
      )}
      <div id="fdResults" ref={results} tabIndex={0} role="tree" onKeyDown={onResultKeys}>
        {files.map((f, i) => (
          <Fragment key={f.path}>{fileRows(f, i)}</Fragment>
        ))}
      </div>
    </div>
  );
}
