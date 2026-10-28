import { useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { type DropdownItem, DropdownMenu } from '../DropdownMenu';
import { FileRow } from '../editor/FileRow';
import type { ChatController } from './controller';
import {
  PromptInput,
  PromptInputAdd,
  PromptInputAttachments,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from './PromptInput';
import { Task, TaskContent, TaskItem, TaskTrigger } from './Task';
import type { ConfigOption, ConfigValue, PlanEntry } from './types';

const PLAN_STATUS: Record<string, 'pending' | 'in_progress' | 'completed'> = {
  completed: 'completed',
  in_progress: 'in_progress',
  pending: 'pending',
};
const PLAN_MARK: Record<string, string> = { completed: '✓', in_progress: '●', pending: '○' };

const MODE_UI: Record<string, { name: string; desc: string; icon: string; warn?: boolean }> = {
  default: {
    name: 'Ask for approval',
    desc: "Asks before edits and commands your settings don't allow",
    icon: 'M8 13V5.5a1 1 0 0 1 2 0V10m0-5.5v-1a1 1 0 0 1 2 0V10m0-5.5a1 1 0 0 1 2 0V10m0-3.5a1 1 0 0 1 2 0V13a6 6 0 0 1-6 6h-.5a5 5 0 0 1-4-2L4 13.5a1.2 1.2 0 0 1 2-1.3L8 14',
  },
  acceptEdits: {
    name: 'Accept edits',
    desc: 'Approves file edits and file commands; asks for the rest',
    icon: 'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z M13 3v6h6M9 16l1-3 5-5 2 2-5 5z',
  },
  auto: {
    name: 'Approve for me',
    desc: 'Reviews approval requests for you',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5',
  },
  plan: {
    name: 'Plan',
    desc: 'Creates a plan before making changes',
    icon: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  },
  bypassPermissions: {
    name: 'Full access',
    desc: 'Never asks before edits or commands',
    warn: true,
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M12 8v5M12 16.5v.01',
  },
};
const MODE_ORDER = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

const flat = (o: ConfigOption): ConfigValue[] => (o.options || []).flatMap((x) => (x.options ? x.options : [x]));

function ModeIcon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      className="mi"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const Chev = ({ d }: { d: string }) => (
  <svg
    aria-hidden="true"
    className="chev"
    viewBox="0 0 12 12"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <path d={d} />
  </svg>
);

function ModePicker({ ctl, mode, disabled }: { ctl: ChatController; mode: ConfigOption; disabled: boolean }) {
  const items = flat(mode).sort((a, b) => MODE_ORDER.indexOf(a.value) - MODE_ORDER.indexOf(b.value));
  const info = (x: ConfigValue) =>
    MODE_UI[x.value] || { name: x.name, desc: x.description || '', icon: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0' };
  const cur = items.find((x) => x.value === mode.currentValue) || items[0];
  const ci = cur ? info(cur) : null;
  return (
    <DropdownMenu
      disabled={disabled}
      side="top"
      trigger={
        <button type="button" className={`mode-btn${ci?.warn ? ' warn' : ''}`}>
          {ci ? <ModeIcon d={ci.icon} /> : null}
          {ci?.name}
          <Chev d="M3 4.5l3 3 3-3" />
        </button>
      }
      items={items.map((x): DropdownItem => {
        const i = info(x);
        return {
          kind: 'radio',
          label: i.name,
          description: i.desc,
          icon: <ModeIcon d={i.icon} />,
          checked: x.value === mode.currentValue,
          tone: i.warn ? 'warn' : undefined,
          onSelect: () => ctl.setConfig(mode.id, x.value),
        };
      })}
    />
  );
}

function ModelPicker({
  ctl,
  model,
  effort,
  disabled,
}: {
  ctl: ChatController;
  model?: ConfigOption;
  effort?: ConfigOption;
  disabled: boolean;
}) {
  const cur = (o?: ConfigOption) => (o ? flat(o).find((x) => x.value === o.currentValue)?.name : undefined);
  const all = model ? flat(model) : [];
  const top = all.slice(0, 5);
  const choices = (o: ConfigOption, xs: ConfigValue[]): DropdownItem[] =>
    xs.map((x) => ({
      kind: 'radio',
      label: x.name,
      description: x.description || undefined,
      checked: x.value === o.currentValue,
      onSelect: () => ctl.setConfig(o.id, x.value),
    }));
  const items: DropdownItem[] = [];
  if (model) {
    items.push({ kind: 'label', label: 'Model · this session' }, ...choices(model, top));
    if (all.length > top.length) {
      items.push({ kind: 'separator' }, { kind: 'sub', label: 'More models', items: choices(model, all) });
    }
  }
  if (effort) {
    if (model) items.push({ kind: 'separator' });
    items.push({ kind: 'sub', label: 'Effort', value: cur(effort) || '', items: choices(effort, flat(effort)) });
  }
  return (
    <DropdownMenu
      disabled={disabled}
      side="top"
      align="end"
      trigger={
        <button type="button" className="mode-btn model-btn">
          {cur(model) || ''}
          {effort ? <span className="eff"> {cur(effort) || ''}</span> : null}
        </button>
      }
      items={items}
    />
  );
}

/** Mode popover (Claude Desktop style) plus model and effort menus, from the agent's config options (by category). */
function Picks({ ctl }: { ctl: ChatController }) {
  const cfg = (c: string) => (ctl.model.configOptions || []).find((o) => o.type === 'select' && o.category === c);
  const disabled = ctl.status !== 'ready';
  const mode = cfg('mode');
  const model = cfg('model');
  const effort = cfg('thought_level');
  return (
    <span className="chat-picks">
      {mode ? <ModePicker ctl={ctl} mode={mode} disabled={disabled} /> : null}
      {model || effort ? <ModelPicker ctl={ctl} model={model} effort={effort} disabled={disabled} /> : null}
    </span>
  );
}

function Plan({ ctl, entries }: { ctl: ChatController; entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === 'completed').length;
  return (
    <Task
      className="chat-plan"
      open={ctl.open.plan !== false}
      onOpenChange={(now) => {
        ctl.setOpen('plan', now);
        ctl.emit();
      }}
    >
      <TaskTrigger title="Plan" meta={`${done}/${entries.length}`} />
      <TaskContent className="max-h-[140px] overflow-auto">
        {entries.map((e, i) => (
          <TaskItem key={i} status={PLAN_STATUS[e.status ?? ''] ?? 'pending'}>
            <span className={cn('w-3 flex-none text-center', e.status === 'in_progress' && 'text-primary')}>
              {PLAN_MARK[e.status ?? ''] || PLAN_MARK.pending}
            </span>
            {e.content}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

export function Composer({ ctl }: { ctl: ChatController }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const b = ctl.busy;
  const usable = ctl.status === 'ready' || ctl.status === 'starting';
  const hasInput = !!ctl.text.trim() || ctl.images.length > 0 || ctl.files.length > 0;
  const stopMode = b && !hasInput;
  const p = ctl.pick;

  // grow with the content; restore the caret after programmatic text changes
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    // hidden (display:none) reports 0; keep auto so it isn't stuck collapsed once shown
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    if (ctl.caret != null) {
      el.setSelectionRange(ctl.caret, ctl.caret);
      ctl.caret = null;
    }
  });
  // focus requests from outside
  useEffect(() => {
    if (ctl.focusTick && !ta.current?.disabled) ta.current?.focus();
  }, [ctl.focusTick, ctl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const native = e.nativeEvent;
    // The app menu has no Select All role, so macOS never routes cmd+a to the textarea.
    if (e.metaKey && !e.altKey && e.code === 'KeyA') {
      e.preventDefault();
      el.select();
      return;
    }
    // Textareas only insert a newline for shift+enter natively.
    if (e.key === 'Enter' && e.altKey && !native.isComposing) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
      return;
    }
    if (p?.items.length && !native.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        ctl.movePick(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      const exact =
        p.kind === 'cmd' && e.key === 'Enter' && !e.shiftKey && ctl.text.trim() === `/${p.items[p.sel].name}`;
      if (!exact && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        ctl.chooseMention(p.sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        ctl.closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !native.isComposing) {
      e.preventDefault();
      ctl.send();
    } else if (e.key === 'Escape' && b) {
      e.preventDefault();
      ctl.stop();
    } else if (/^[1-9]$/.test(e.key) && !ctl.text && !e.metaKey && !e.ctrlKey && !e.altKey && ctl.answerKey(+e.key))
      e.preventDefault();
  };

  return (
    <div className="chat-compose">
      {ctl.model.plan?.length ? <Plan ctl={ctl} entries={ctl.model.plan} /> : null}
      {ctl.queue.length ? (
        <div className="chat-queue">
          {ctl.queue.length} queued: {(ctl.queue[0].text || '[attachment]').slice(0, 60)}
        </div>
      ) : null}
      {p ? (
        <div
          className="chat-mention"
          onMouseDown={(e) => {
            const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
            if (row) {
              e.preventDefault();
              ctl.chooseMention(+(row.dataset.i as string));
            }
          }}
        >
          {p.kind === 'cmd'
            ? p.items.map((r, i) => (
                <div key={r.name} className={`mi${i === p.sel ? ' on' : ''}`} data-i={i}>
                  <b className="cn">/{r.name}</b>
                  {r.input?.hint ? <span className="ch">{r.input.hint}</span> : null}
                  <span className="r">{r.description}</span>
                </div>
              ))
            : p.items.map((r, i) => (
                <div key={r.f} className={`mi${i === p.sel ? ' on' : ''}`} data-i={i}>
                  <FileRow r={r} />
                </div>
              ))}
        </div>
      ) : null}
      <PromptInput>
        <PromptInputAttachments
          items={[
            ...ctl.images.map((im) => ({ src: `data:${im.mimeType};base64,${im.data}` })),
            ...ctl.files.map((f) => ({ src: f.src, name: f.name, video: !!f.src })),
          ]}
          onRemove={(i) => {
            if (i < ctl.images.length) ctl.images.splice(i, 1);
            else ctl.files.splice(i - ctl.images.length, 1);
            ctl.emit();
          }}
        />
        <PromptInputAdd disabled={!usable} onFiles={(files) => ctl.attach(files)} />
        <PromptInputTextarea
          ref={ta}
          rows={1}
          spellCheck={false}
          aria-label="Message"
          value={ctl.text}
          disabled={!usable}
          placeholder={
            ctl.status === 'starting'
              ? 'Starting…'
              : b
                ? 'Queue a message… (Esc to stop)'
                : `Message ${ctl.agent.label}…`
          }
          onChange={(e) => {
            ctl.setText(e.target.value);
            ctl.updateMention(e.target.selectionStart);
          }}
          onClick={(e) => ctl.updateMention(e.currentTarget.selectionStart)}
          onBlur={() => ctl.closeMention()}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length) {
              e.preventDefault();
              ctl.attach(files);
            }
          }}
        />
        <PromptInputFooter
          submit={
            <PromptInputSubmit
              stop={stopMode}
              disabled={!usable || (!stopMode && !hasInput)}
              onClick={() => {
                if (stopMode) ctl.stop();
                else ctl.send();
                ta.current?.focus();
              }}
            />
          }
        />
      </PromptInput>
      <div className="chat-foot">
        <Picks ctl={ctl} />
        <span className="chat-usage">
          {(() => {
            const used = ctl.model.usage?.used ?? 0;
            const size = ctl.model.usage?.size ?? 0;
            const percent = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
            return (
              <span
                className="chat-usage-meter"
                title={size ? `${used.toLocaleString()} of ${size.toLocaleString()} tokens` : 'No usage reported yet'}
              >
                <span className="chat-usage-bar">
                  <span className="chat-usage-fill" style={{ width: `${percent}%` }} />
                </span>
                {compact(used)}
              </span>
            );
          })()}
        </span>
      </div>
    </div>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
