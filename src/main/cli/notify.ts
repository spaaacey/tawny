// `tawny notify`: flag a tab as needing attention (the sidebar "!" mark); cleared when the tab is focused.
import * as z from 'zod';
import type { Bridge } from './bridge';
import type { Registry } from './registry';

export function registerNotify(reg: Registry, bridge: Bridge) {
  reg.add({
    name: 'notify',
    summary: 'Mark a tab as needing attention until it is focused (default: this chat). No-op if already focused.',
    params: z.object({ tab: z.string().optional().describe('Tab (session) id; default: the calling chat') }),
    args: ['tab'],
    handler: (p, ctx) => {
      const tab = p.tab ?? ctx.chatId;
      if (!tab) throw new Error('no tab: pass --tab <id> (run from a Tawny chat to default to it)');
      return bridge.request('notify.send', { tab });
    },
  });
}
