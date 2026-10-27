import { BrainIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { H } from '../../lib/legacy';
import { Bubble, BubbleContent } from '../ui/bubble';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog';
import { MessageContent, Message as MessageTurn } from '../ui/message';
import { Composer } from './Composer';
import type { ChatController } from './controller';
import { MessageScroller, MessageScrollerItem } from './MessageScroller';
import { Tool, ToolContent, ToolHeader } from './Tool';
import { Details, Perm, ToolBody, ToolCard, ToolGroup, ToolHead } from './ToolCard';
import type { Item, PermRequest } from './types';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

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
                <BubbleContent className="whitespace-pre-wrap text-[13.5px]">{it.text}</BubbleContent>
              </Bubble>
            ) : null}
          </MessageContent>
        </MessageTurn>
      );
    case 'agent':
      return (
        <div
          className="msg agent chat-md"
          dangerouslySetInnerHTML={{ __html: window.harborChatMd.render(it.text ?? '') }}
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
      body = (
        <>
          {ctl.error || `Couldn't start ${ctl.agent.label}.`} Check <code>acpAgents</code> in harbor.json, then{' '}
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
              onClick={() => window.harborApp.chatAuth(ctl.id, m.id).catch((e: Error) => ctl.flash(e.message))}
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
  return <div className="chat-banner">{body}</div>;
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

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.chat-md a');
    if (a) {
      e.preventDefault();
      if (/^https?:/.test(a.href)) window.open(a.href);
    }
  };

  return (
    <div
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
            node = <ToolCard ctl={ctl} id={b.id as string} req={pendingBy[b.id as string] ?? null} />;
          else node = <Message ctl={ctl} it={b as Item} />;
          return (
            <MessageScrollerItem key={key} messageId={key}>
              {node}
            </MessageScrollerItem>
          );
        })}
        <div className="chat-tail">
          {loose.map((r) => (
            <div key={r.reqId} className="tool pending open-card">
              <div className="th">
                <ToolHead t={r.toolCall} />
              </div>
              <div className="tb">
                <ToolBody t={r.toolCall} ctl={ctl} />
                <Perm r={r} ctl={ctl} />
              </div>
            </div>
          ))}
          {working ? (
            <div className="chat-working">
              <span className="spin" />
              Working…
            </div>
          ) : null}
        </div>
      </MessageScroller>
      <Banner ctl={ctl} />
      <Composer ctl={ctl} />
    </div>
  );
}
