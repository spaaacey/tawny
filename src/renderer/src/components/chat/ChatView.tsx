import { BrainIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { chatAuth } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { Bubble, BubbleContent } from '../ui/bubble';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog';
import { MessageContent, Message as MessageTurn } from '../ui/message';
import { Composer } from './Composer';
import type { ChatController } from './controller';
import { MessageScroller, MessageScrollerItem } from './MessageScroller';
import { QuestionCard } from './QuestionCard';
import { Tool, ToolContent, ToolHeader } from './Tool';
import { Details, Perm, ToolBody, ToolCard, ToolGroup, ToolHead } from './ToolCard';
import type { Item, PermRequest } from './types';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const INSTALL_CODEX = 'npm install -g @openai/codex';
const INSTALL_MATILDA = 'npm install -g @maincode-ai/matilda-code';

type Block = Item | { type: 'toolgroup'; id: string; run: Item[]; running: boolean };

/** Finished runs of 2+ tool calls collapse into one group (live "running" label while in progress); runs awaiting permission stay expanded. */
function buildBlocks(ctl: ChatController, pendingBy: Record<string, PermRequest>): Block[] {
  const { items, tools } = ctl.model;
  const blocks: Block[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== 'tool') {
      blocks.push(items[i]);
      continue;
    }
    let j = i;
    while (j < items.length && items[j].type === 'tool') j++;
    const run = items.slice(i, j);
    const finished = run.every((t) => ['completed', 'failed'].includes(tools[t.id as string]?.status ?? ''));
    const running = !finished || (j >= items.length && ctl.busy);
    if (run.length > 1 && !run.some((t) => pendingBy[t.id as string]))
      blocks.push({ type: 'toolgroup', id: run[0].id as string, run, running });
    else blocks.push(...run);
    i = j - 1;
  }
  return blocks;
}

/** Split sent text into runs of '>' quote lines (marker stripped) and plain text. */
function quoteSegments(text: string): { quote: boolean; text: string }[] {
  const segs: { quote: boolean; text: string }[] = [];
  for (const line of text.split('\n')) {
    const m = /^>\s?(.*)$/.exec(line);
    const last = segs[segs.length - 1];
    if (m) {
      if (last?.quote) last.text += `\n${m[1]}`;
      else segs.push({ quote: true, text: m[1] });
    } else if (last && !last.quote) last.text += `\n${line}`;
    else segs.push({ quote: false, text: line });
  }
  // a quote block already ends its line, so drop the newline that follows it
  return segs.map((s, i) => (!s.quote && i > 0 ? { ...s, text: s.text.replace(/^\n/, '') } : s));
}

/** Selected text inside user/agent message bodies, with the selection's rect; null otherwise. */
function messageSelection(root: HTMLElement | null) {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const inMsg = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('.msg.user, .msg.agent');
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) || !inMsg(range.startContainer) || !inMsg(range.endContainer))
    return null;
  const text = sel.toString();
  return text.trim() ? { text, rect: range.getBoundingClientRect() } : null;
}

function Message({ ctl, it }: { ctl: ChatController; it: Item }) {
  switch (it.type) {
    case 'user':
      return (
        <MessageTurn align="end" className="msg user">
          <MessageContent>
            {it.images?.length ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {it.images.map((im, i) => {
                  const src = `data:${im.mimeType};base64,${im.data}`;
                  return (
                    <Dialog key={i}>
                      <DialogTrigger asChild>
                        <button type="button" className="cursor-zoom-in overflow-hidden rounded-lg">
                          <img src={src} alt="" className="max-h-40 max-w-60 object-cover" />
                        </button>
                      </DialogTrigger>
                      <DialogContent className="w-auto max-w-[90vw] border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
                        <DialogTitle className="sr-only">Image</DialogTitle>
                        <img src={src} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
                      </DialogContent>
                    </Dialog>
                  );
                })}
              </div>
            ) : null}
            {it.text ? (
              <Bubble align="end" variant="muted">
                <BubbleContent className="whitespace-pre-wrap text-[13.5px]">
                  {quoteSegments(it.text).map((seg, i) =>
                    seg.quote ? (
                      <div key={i} className="chat-quote">
                        {seg.text}
                      </div>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </BubbleContent>
              </Bubble>
            ) : null}
          </MessageContent>
        </MessageTurn>
      );
    case 'agent':
      return (
        <div
          className="msg agent chat-md"
          dangerouslySetInnerHTML={{ __html: window.tawnyChatMd.render(it.text ?? '') }}
        />
      );
    case 'thought': {
      const id = `thought-${it.id || ''}`;
      return (
        <div className="msg thought">
          <Tool
            open={ctl.open[id] ?? false}
            onOpenChange={(now) => {
              ctl.setOpen(id, now);
              ctl.emit();
            }}
          >
            <ToolHeader icon={<BrainIcon />} title="Thinking" />
            <ToolContent>
              <div className="thought-body">{it.text}</div>
            </ToolContent>
          </Tool>
        </div>
      );
    }
    case 'notice':
      return (
        <div className={`msg notice sev-${it.severity || 'info'}`}>
          {it.description ? (
            <>
              <b>{it.text}</b> {it.description}
            </>
          ) : (
            it.text
          )}
        </div>
      );
    case 'clear':
      return <div className="msg divider">Context cleared</div>;
    case 'compaction': {
      const label =
        it.status === 'in_progress'
          ? 'Compacting conversation…'
          : it.status === 'cancelled'
            ? 'Compaction cancelled'
            : 'Conversation compacted';
      return (
        <div className="msg divider">
          {it.summary ? (
            <Details ctl={ctl} id={`compaction-${it.id}`} summary={label}>
              <div className="cmp-sum">{it.summary}</div>
            </Details>
          ) : (
            label
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

function Banner({ ctl }: { ctl: ChatController }) {
  const retry = (label: string) => (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => H.chatReconnect(ctl.id).catch((e: Error) => ctl.flash(e.message))}
    >
      {label}
    </Button>
  );
  let body: React.ReactNode = null;
  switch (ctl.status) {
    case 'starting':
      break;
    case 'no-claude':
      body = (
        <>
          Claude Code isn't installed. Install it with <code>{INSTALL}</code>, then open a new chat.
        </>
      );
      break;
    case 'no-agent':
      body =
        ctl.agent.name === 'matilda' ? (
          <>
            Matilda Code isn't installed. Install it with <code>{INSTALL_MATILDA}</code>, then {retry('Retry')}
          </>
        ) : ctl.agent.name === 'codex' ? (
          <>
            Codex CLI isn't installed. Install it with <code>{INSTALL_CODEX}</code>, then {retry('Retry')}
          </>
        ) : (
          <>
            {ctl.error || `Couldn't start ${ctl.agent.label}.`} Check <code>acpAgents</code> in tawny.json, then{' '}
            {retry('Retry')}
          </>
        );
      break;
    case 'auth-required':
      body = (
        <>
          {ctl.agent.label} needs you to sign in.{' '}
          {ctl.auth.map((m) => (
            <Button
              key={m.id}
              variant="secondary"
              size="sm"
              title={m.description || ''}
              onClick={() => chatAuth(ctl.id, m.id).catch((e: Error) => ctl.flash(e.message))}
            >
              {m.name}
            </Button>
          ))}{' '}
          {retry('Retry')}
        </>
      );
      break;
    case 'disconnected':
      body = (
        <>
          Disconnected{ctl.error ? `: ${ctl.error}` : ''} {retry('Reconnect')}
        </>
      );
      break;
    case 'error':
      body = (
        <>
          Couldn't start the chat{ctl.error ? `: ${ctl.error}` : ''} {retry('Retry')}
        </>
      );
      break;
    default:
      body = ctl.note || null;
  }
  if (!body) return null;
  return (
    <div className="chat-banner" onClick={ctl.status === 'ready' ? () => ctl.dismissNote() : undefined}>
      {body}
    </div>
  );
}

/** Live "Working… 1m 5s" label; `since` is when the turn started. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</>;
}

export function ChatView({ ctl, host }: { ctl: ChatController; host: HTMLElement }) {
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  const scroll = useRef<HTMLDivElement>(null);
  const m = ctl.model;
  const pendingBy: Record<string, PermRequest> = {};
  for (const r of m.pending) pendingBy[r.toolCall.toolCallId] = r;
  const blocks = buildBlocks(ctl, pendingBy);
  const placed = new Set<number>();
  for (const b of blocks)
    if (b.type === 'tool' && pendingBy[b.id as string]) placed.add(pendingBy[b.id as string].reqId);
  // permission requests whose tool call isn't in the transcript yet
  const loose = m.pending.filter((r) => !placed.has(r.reqId));
  const working = ctl.state === 'working' || (ctl.busy && !m.pending.length);
  // the turn's start survives brief non-working gaps (permission prompts); it resets once the chat goes idle
  const turnStart = useRef(0);
  if (!ctl.busy) turnStart.current = 0;
  else if (!turnStart.current) turnStart.current = Date.now();

  // a tab that was hidden or re-parented loses its scroll position: restore it when it shows again
  useLayoutEffect(() => {
    const el = host;
    const sc = scroll.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => {
      if (!el.offsetHeight) return;
      sc.scrollTop = ctl.stick ? sc.scrollHeight : ctl.top;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ctl, host]);

  const root = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const s = messageSelection(root.current);
      setQuote(s ? { text: s.text, x: s.rect.left + s.rect.width / 2, y: s.rect.top } : null);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      if (!el || !host.offsetHeight || !e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.code !== 'KeyR') return;
      const sel = window.getSelection();
      const here = el.contains(document.activeElement) || (!!sel?.rangeCount && el.contains(sel.anchorNode));
      if (!here) return;
      e.preventDefault();
      const s = messageSelection(el);
      if (s) {
        ctl.quote(s.text);
        sel?.removeAllRanges();
      }
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ctl, host]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.chat-md a');
    if (a) {
      e.preventDefault();
      if (/^https?:/.test(a.href)) window.open(a.href);
    }
  };

  return (
    <div
      ref={root}
      className="chat-root"
      onClick={onClick}
      onDragOver={(e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) {
          e.preventDefault();
          ctl.attach(files);
        }
      }}
    >
      <MessageScroller
        className="flex-1"
        contentClassName="chat-col gap-0"
        viewportRef={scroll}
        jumpKey={blocks.filter((b) => b.type === 'user').length}
        onViewportScroll={(e) => {
          const el = e.currentTarget;
          if (!host.offsetHeight) return;
          ctl.top = el.scrollTop;
          ctl.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {blocks.map((b, i) => {
          const key = `${i}:${b.type}`;
          let node: React.ReactNode;
          if (b.type === 'toolgroup')
            node = (
              <ToolGroup
                ctl={ctl}
                id={b.id as string}
                run={(b as { run: Item[] }).run as { id: string }[]}
                running={(b as { running: boolean }).running}
              />
            );
          else if (b.type === 'tool')
            node = pendingBy[b.id as string]?.form ? (
              <QuestionCard ctl={ctl} r={pendingBy[b.id as string]} />
            ) : (
              <ToolCard ctl={ctl} id={b.id as string} req={pendingBy[b.id as string] ?? null} />
            );
          else node = <Message ctl={ctl} it={b as Item} />;
          return (
            <MessageScrollerItem key={key} messageId={key}>
              {node}
            </MessageScrollerItem>
          );
        })}
        <div className="chat-tail">
          {loose.map((r) =>
            r.form ? (
              <QuestionCard key={r.reqId} ctl={ctl} r={r} />
            ) : (
              <div key={r.reqId} className="tool pending open-card">
                <div className="th">
                  <ToolHead t={r.toolCall} />
                </div>
                <div className="tb">
                  <ToolBody t={r.toolCall} ctl={ctl} />
                  <Perm r={r} ctl={ctl} />
                </div>
              </div>
            ),
          )}
          {working ? (
            <div className="chat-working">
              <span className="spin" />
              Working… <Elapsed since={turnStart.current} />
            </div>
          ) : null}
        </div>
      </MessageScroller>
      {quote ? (
        <button
          type="button"
          className="chat-quote-btn"
          style={{ left: quote.x, top: quote.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            ctl.quote(quote.text);
            window.getSelection()?.removeAllRanges();
          }}
        >
          Reply <kbd>⌘R</kbd>
        </button>
      ) : null}
      <Banner ctl={ctl} />
      <Composer ctl={ctl} />
    </div>
  );
}
