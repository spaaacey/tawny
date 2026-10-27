import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { H } from '../../lib/legacy';
import {
  Bubble,
  BubbleContent,
  Button,
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
  MessageContent,
  Message as MessageTurn,
} from '../../ui';
import { Composer } from './Composer';
import type { ChatController } from './controller';
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
            <Bubble align="end" variant="muted">
              <BubbleContent className="whitespace-pre-wrap">{it.text}</BubbleContent>
            </Bubble>
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
          <ChainOfThought
            open={ctl.open[id] ?? false}
            onOpenChange={(now) => {
              ctl.setOpen(id, now);
              ctl.emit();
            }}
          >
            <ChainOfThoughtHeader>Thinking</ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <ChainOfThoughtStep>
                <div className="thought-body">{it.text}</div>
              </ChainOfThoughtStep>
            </ChainOfThoughtContent>
          </ChainOfThought>
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
    <Button size="sm" onClick={() => H.chatReconnect(ctl.id).catch((e: Error) => ctl.flash(e.message))}>
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

  // follow the tail while the user is at the bottom
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && ctl.stick) el.scrollTop = el.scrollHeight;
  });
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

  const files = (e: React.DragEvent) => [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));

  return (
    <div
      className="chat-root"
      onClick={onClick}
      onDragOver={(e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const imgs = files(e);
        if (imgs.length) {
          e.preventDefault();
          ctl.addImages(imgs);
        }
      }}
    >
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!host.offsetHeight) return;
          ctl.top = el.scrollTop;
          ctl.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="chat-col">
          <div className="chat-list">
            {blocks.map((b, i) => {
              const key = `${i}:${b.type}`;
              if (b.type === 'toolgroup')
                return (
                  <ToolGroup
                    key={key}
                    ctl={ctl}
                    id={b.id as string}
                    run={(b as { run: Item[] }).run as { id: string }[]}
                    running={(b as { running: boolean }).running}
                  />
                );
              if (b.type === 'tool')
                return <ToolCard key={key} ctl={ctl} id={b.id as string} req={pendingBy[b.id as string] ?? null} />;
              return <Message key={key} ctl={ctl} it={b as Item} />;
            })}
          </div>
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
        </div>
      </div>
      <Banner ctl={ctl} />
      <Composer ctl={ctl} />
    </div>
  );
}
