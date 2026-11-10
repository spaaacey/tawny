// `tawny chat ...`: spawn, inspect and drive chats (new, list, send, read, wait).
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

  /** A chat addressed by session id; only chats of known workspaces are reachable. */
  const find = (id: string | undefined) => {
    if (!id) throw new Error('missing chat id (see `tawny chat list --all`)');
    const known = new Set(deps.workspaces().map((w) => w.path));
    const hit = deps.chats().find((c) => c.id === id && known.has(c.chat.cwd));
    if (!hit) throw new Error(`unknown chat "${id}" (see \`tawny chat list --all\`)`);
    return hit.chat;
  };

  reg.add({
    name: 'chat.send',
    summary:
      'Send a message to a chat and return once the turn started (use `chat wait` for the end). Errors if the chat is mid-turn or waiting on a permission.',
    params: z.object({
      id: z.string().describe('Chat id (from `chat list` / `chat new`)'),
      message: z.string().optional().describe('Message (or pipe it on stdin)'),
    }),
    args: ['id'],
    stdin: 'message',
    handler: async (p) => {
      const chat = find(p.id);
      if (!p.message?.trim()) throw new Error('empty message: pass --message or pipe it on stdin');
      await ready(chat);
      if (chat.state !== 'idle')
        throw new Error(`chat ${p.id} is ${chat.state}, not idle: \`tawny chat wait ${p.id}\` first`);
      chat.prompt([{ type: 'text', text: p.message }]).catch(() => {});
      return { chatId: p.id, state: chat.state };
    },
  });

  reg.add({
    name: 'chat.read',
    summary:
      'Read the last N messages of a chat as text: [{ role: user|agent, text }]. Tool calls and thoughts are left out.',
    params: z.object({
      id: z.string().describe('Chat id'),
      last: z.number().int().positive().optional().describe('How many messages (default 5)'),
    }),
    args: ['id'],
    handler: (p) => {
      const chat = find(p.id);
      const msgs = chat.model.items.flatMap((it) =>
        (it.type === 'user' || it.type === 'agent') && it.text.trim() ? [{ role: it.type, text: it.text }] : [],
      );
      return { chatId: p.id, state: chat.state, messages: msgs.slice(-(p.last ?? 5)) };
    },
  });

  reg.add({
    name: 'chat.wait',
    summary:
      'Block until the chat is idle (its turn ended). Exits non-zero on timeout. A chat waiting on a permission keeps blocking.',
    params: z.object({
      id: z.string().describe('Chat id'),
      timeout: z.number().positive().optional().describe('Seconds to wait (default 600)'),
    }),
    args: ['id'],
    handler: (p) => {
      const chat = find(p.id);
      const secs = p.timeout ?? 600;
      return new Promise((resolve, reject) => {
        const finish = (fn: () => void) => {
          clearTimeout(t);
          chat.off('state', check);
          chat.off('status', check);
          fn();
        };
        const check = () => {
          if (chat.status !== 'ready' && chat.status !== 'starting')
            return finish(() => reject(new Error(`chat is not ready (${chat.status})`)));
          if (chat.status === 'ready' && chat.state === 'idle') finish(() => resolve({ chatId: p.id, state: 'idle' }));
        };
        const t = setTimeout(
          () => finish(() => reject(new Error(`timed out after ${secs}s; chat ${p.id} is still ${chat.state}`))),
          secs * 1000,
        );
        chat.on('state', check);
        chat.on('status', check);
        check();
      });
    },
  });
}
