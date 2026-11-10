// `tawny chat ...`: spawn and inspect chats. Ticket 7 extends this file (send/read/wait).
import * as z from 'zod';
import type { Chat } from '../acp';
import { agentList, resolveAgent } from '../acp';
import type { Session } from '../agents';
import type { Registry } from './registry';
import { type CliWorkspace, resolveWorkspace } from './workspace';

export interface ChatDeps {
  workspaces: () => CliWorkspace[];
  settings: () => Record<string, unknown>;
  create(dir: string, agent?: string): Promise<Session>;
  chats(): { id: string; chat: Chat }[];
  names: (id: string) => { name: string | null; title: string | null };
  /** Renderer: reveal and focus a chat (and its workspace) */
  focus(id: string, worktree: string): Promise<unknown>;
}

/** Wait until the chat's adapter is up; prompt() refuses before that. */
function ready(chat: Chat, ms = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (chat.status === 'ready') return done(resolve);
      if (chat.status !== 'starting') return done(() => reject(new Error(`chat is not ready (${chat.status})`)));
    };
    const t = setTimeout(() => done(() => reject(new Error('chat did not become ready in time'))), ms);
    const done = (fn: () => void) => {
      clearTimeout(t);
      chat.off('status', check);
      fn();
    };
    chat.on('status', check);
    check();
  });
}

export function registerChat(reg: Registry, deps: ChatDeps) {
  const info = (id: string, chat: Chat) => ({
    chatId: id,
    name: deps.names(id).name ?? deps.names(id).title,
    agent: chat.spec.name,
    worktree: chat.cwd,
    state: chat.status === 'ready' ? chat.state : chat.status,
  });

  reg.add({
    name: 'chat.new',
    summary: 'Open a new chat in a workspace. Prints { chatId, name, worktree }. Does not take focus unless --focus.',
    params: z.object({
      agent: z.string().optional().describe('Chat agent name (default: the configured one)'),
      prompt: z.string().optional().describe('First message to send (or pipe it on stdin)'),
      workspace: z.string().optional().describe('Workspace path or name (default: the current one)'),
      focus: z.boolean().optional().describe('Bring the new chat to the front'),
    }),
    stdin: 'prompt',
    handler: async (p, ctx) => {
      const ws = resolveWorkspace(deps.workspaces(), p.workspace, ctx);
      try {
        resolveAgent(deps.settings(), p.agent);
      } catch (e) {
        throw new Error(`${(e as Error).message} Valid agents: ${Object.keys(agentList(deps.settings())).join(', ')}`);
      }
      const s = await deps.create(ws.path, p.agent);
      const chat = s.acp as Chat;
      if (p.prompt?.trim()) {
        await ready(chat).catch((e) => {
          throw new Error(`chat ${s.id} opened but the prompt was not sent: ${e.message}`);
        });
        chat.prompt([{ type: 'text', text: p.prompt }]).catch(() => {});
      }
      if (p.focus) await deps.focus(s.id, ws.path);
      const { chatId, name, worktree } = info(s.id, chat);
      return { chatId, name, worktree };
    },
  });

  reg.add({
    name: 'chat.list',
    summary: 'List chats: id, name, agent, worktree, state (idle|working|waiting, or the connection problem).',
    params: z.object({
      workspace: z.string().optional().describe('Workspace path or name (default: the current one)'),
      all: z.boolean().optional().describe('Chats of every workspace'),
    }),
    handler: (p, ctx) => {
      const ws = p.all ? null : resolveWorkspace(deps.workspaces(), p.workspace, ctx);
      const known = new Set(deps.workspaces().map((w) => w.path));
      return deps
        .chats()
        .filter(({ chat }) => (ws ? chat.cwd === ws.path : known.has(chat.cwd)))
        .map(({ id, chat }) => {
          const { chatId: _c, ...rest } = info(id, chat);
          return { id, ...rest };
        });
    },
  });
}
