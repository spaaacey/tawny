// Generic review item card (a PR finding, a local review item) in read mode of the shared ComposeCard: icon, title, location,
// category/verdict and state badges, markdown body, suggestion, collapsible failure scenario and an inline editor.
// Footer: target chip left, then the owner's buttons. The x dismisses. The owner injects badges and actions.
import { BotIcon, ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/ui/item';
import { Textarea } from '@/ui/textarea';
import type { ReviewFields } from '../../../../shared/types';
import { Md } from '../workspace/prParts';
import { CardTitle, ComposeCard, TargetChip } from './ComposeCard';

/** `path:line` or `path:start-end`. */
export const itemWhere = (i: Pick<ReviewFields, 'path' | 'line' | 'startLine'>) =>
  `${i.path}:${i.startLine ? `${i.startLine}-` : ''}${i.line}`;

/** A state badge. Always a word (never colour alone, WCAG 1.4.1); `title` explains it on hover. */
export interface ItemBadge {
  label: string;
  title?: string;
  /** default 'secondary' */
  variant?: 'secondary' | 'outline';
}

function Badges({ list }: { list?: ItemBadge[] }) {
  return list?.map((b) => (
    <Badge key={b.label} variant={b.variant ?? 'secondary'} title={b.title}>
      {b.label}
    </Badge>
  ));
}

/** The card's edit text: body (prefilled with body + failure scenario) and suggestion. */
export interface ItemDraft {
  body: string;
  suggestion: string;
}

/** What `actions` gets to build its buttons. */
export interface ItemCardCtx {
  /** the inline editor is open */
  editing: boolean;
  /** the editor was closed at least once ("Done editing"): the card shows the draft instead of the item */
  edited: boolean;
  draft: ItemDraft;
  /** open the editor, or close it keeping the draft ("Edit" / "Done editing") */
  toggleEdit: () => void;
}

export interface ItemCardProps {
  item: ReviewFields;
  /** header icon; default the bot icon */
  icon?: ReactNode;
  /** before the icon (e.g. local review's "include in send" checkbox) */
  leading?: ReactNode;
  /** header text when there's no `onJump` (in a diff zone the location is implicit); default "Agent finding" */
  label?: ReactNode;
  /** makes the header's location a link */
  onJump?: () => void;
  /** footer chip, left of the buttons (where the item goes: "Pending review", "Local review") */
  chip?: string;
  /** the x: dismiss the item */
  onDismiss?: () => void;
  /** after the item's category / verdict */
  badges?: ItemBadge[];
  /** the editor offers a suggestion box (RIGHT side only) */
  canSuggest?: boolean;
  /** below the body (e.g. a "Fixed" note) */
  children?: ReactNode;
  /** the button row; nothing when it returns null */
  actions?: (ctx: ItemCardCtx) => ReactNode;
  /** content height changed (view zones re-measure) */
  onSize?: () => void;
}

export function ItemCard({
  item,
  icon,
  leading,
  label = 'Agent finding',
  onJump,
  chip,
  onDismiss,
  badges,
  canSuggest,
  children,
  actions,
  onSize,
}: ItemCardProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [body, setBody] = useState(item.detail ? `${item.body}\n\n${item.detail}` : item.body);
  const [sugg, setSugg] = useState(item.suggestion ?? '');
  const shownSugg = edited ? sugg : item.suggestion;
  const row = actions?.({
    editing,
    edited,
    draft: { body, suggestion: sugg },
    toggleEdit: () => {
      if (editing) setEdited(true);
      setEditing((e) => !e);
    },
  });
  const content = (
    <div className="flex flex-col gap-2">
      {editing ? (
        <>
          <Textarea
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {canSuggest && (
            <Textarea
              rows={2}
              className="font-mono text-xs"
              placeholder="Suggested replacement for the selected lines (optional)"
              value={sugg}
              onChange={(e) => setSugg(e.target.value)}
            />
          )}
        </>
      ) : (
        <Md text={edited ? body : item.body} />
      )}
      {!editing && shownSugg && (
        <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{shownSugg}</pre>
      )}
      {!editing && !edited && item.detail && (
        <Collapsible
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            requestAnimationFrame(() => onSize?.());
          }}
        >
          <CollapsibleTrigger asChild>
            <button type="button" className="flex cursor-pointer items-center gap-1 text-muted-foreground text-xs">
              <ChevronRightIcon className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
              Failure scenario
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            <Md text={item.detail} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {children}
    </div>
  );
  return (
    <ComposeCard
      className="compose-flow"
      title={
        <>
          {leading}
          <CardTitle
            icon={icon ?? <BotIcon />}
            title={label}
            loc={itemWhere(item)}
            onLoc={onJump}
            badges={
              <>
                {item.category && <Badge variant="outline">{item.category}</Badge>}
                {item.verdict && <Badge variant="secondary">{item.verdict}</Badge>}
                <Badges list={badges} />
              </>
            }
          />
        </>
      }
      onClose={onDismiss}
      closeTitle="Dismiss"
      body={content}
      footer={
        chip || row ? (
          <>
            {chip && <TargetChip>{chip}</TargetChip>}
            {row}
          </>
        ) : null
      }
    />
  );
}

/** Compact one-row form of an item (e.g. in a chat tool block): location, one-line body, state badges and actions. */
export function ItemRow({
  item,
  struck,
  badges,
  actions,
}: {
  item: ReviewFields;
  /** strike the body through (dismissed) */
  struck?: boolean;
  badges?: ItemBadge[];
  actions?: ReactNode;
}) {
  return (
    <Item variant="outline" size="sm" className="gap-2 px-3 py-2">
      <ItemContent>
        <ItemTitle className="font-mono text-xs">{itemWhere(item)}</ItemTitle>
        <ItemDescription className={struck ? 'line-through' : undefined}>{item.body}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badges list={badges} />
        {actions}
      </ItemActions>
    </Item>
  );
}
