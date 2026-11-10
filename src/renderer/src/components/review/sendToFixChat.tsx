// Shared by the Review rail and the branch diff cards: pick the chat that gets a review fix prompt and send items to it.
import { ChevronsUpDownIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { buildFixPrompt } from '../../../../shared/local-review';
import type { ReviewItem } from '../../../../shared/types';
import { sendToAgent, toast } from '../../lib/actions';
import { sessionsFor } from '../../lib/selectors';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { recentTabs } from '../workspace/layoutStore';
import { useLocalReview } from './localStore';

const chatLabel = (c: { title: string | null; name: string | null; index: number }) =>
  c.title || c.name || `agent ${c.index}`;

/** The worktree's non-review, non-terminal chats, plus the target: the picked one, else the most recently active. */
export function useFixChats(dir: string) {
  const app = useStore((s) => s.app);
  const state = useLocalReview(dir);
  const [picked, setPicked] = useState('');
  const wt = app.repos.flatMap((r) => r.worktrees).find((w) => w.path === dir);
  const chats = wt
    ? sessionsFor(app, wt).filter((s) => s.kind !== 'terminal' && !state?.reviewChats.includes(s.id))
    : [];
  const recent = recentTabs()
    .filter((k) => k.startsWith('a:'))
    .map((k) => k.slice(2));
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const target = chats.find((c) => c.id === picked) ?? [...chats].sort((a, b) => rank(a.id) - rank(b.id))[0];
  return { chats, target, setPicked };
}

/** Put the fix prompt for `items` in the chat's composer (not submitted), reveal it, mark the items sent. */
export async function sendToFixChat(dir: string, items: ReviewItem[], chatId: string | undefined) {
  if (!chatId) return toast('No chat to send to. Start an agent chat first.');
  await sendToAgent(buildFixPrompt(items), chatId);
  await H.lrMarkSent(
    dir,
    items.map((i) => i.id),
  );
}

/** Dropdown to choose the target chat. */
export function FixChatPicker({
  chats,
  target,
  onPick,
  className,
}: {
  chats: ReturnType<typeof useFixChats>['chats'];
  target: ReturnType<typeof useFixChats>['target'];
  onPick: (id: string) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={className}
          title="Chat that gets the fix prompt"
          aria-label="Target chat"
          disabled={!chats.length}
        >
          <span className="truncate">{target ? chatLabel(target) : 'No chats'}</span>
          <ChevronsUpDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={target?.id ?? ''} onValueChange={onPick}>
          {chats.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id}>
              {chatLabel(c)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
