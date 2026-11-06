// Small presentational pieces shared by the PR tab and the inline review threads in diffs.
import { MessageAvatar } from '@/ui/message';
import type { PrUser } from '../../../../shared/types';

export const ago = (t: string | number) => {
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 45) return 'just now';
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour');
  return f.format(-Math.round(s / 86400), 'day');
};

export function Md({ text }: { text: string }) {
  if (!text.trim()) return <div className="text-muted-foreground text-xs italic">No description provided.</div>;
  return (
    <div className="chat-md text-[13.5px]" dangerouslySetInnerHTML={{ __html: window.tawnyChatMd.render(text) }} />
  );
}

export function Avatar({ user }: { user: PrUser | null }) {
  return (
    <MessageAvatar className="size-7 min-w-7 self-start">
      {user?.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="size-7" />
      ) : (
        <span className="text-xs">{(user?.login || '?')[0]}</span>
      )}
    </MessageAvatar>
  );
}
