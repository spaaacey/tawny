import type { HarborApi } from '../../../shared/harbor-api';
import type { Session } from '../../../shared/types';

// biome-ignore lint/suspicious/noExplicitAny: classic-script modules have no types until they are ported
type LegacyModule = Record<string, (...a: any[]) => any>;

export interface SendTarget {
  id: string;
  label: string;
  working: boolean;
  waiting: boolean;
}

/** What the legacy scripts (layout, editor, chat, ...) call back into; implemented in bridge.ts. */
export interface HarborApp {
  openPalette(initial?: string): void;
  settings(): unknown;
  toast(msg: string, ms?: number): void;
  sendToAgent(text: string, id?: string): Promise<void>;
  composeToAgent(ref: string): void;
  askAgent(ref: string, msg: string, id?: string): Promise<void>;
  sendTargets(): { agents: SendTarget[]; index: number };
  newAgent(gid?: string, kind?: string, opts?: { agent?: string; sessionId?: string; title?: string }): Promise<void>;
  chatAuth(id: string, methodId?: string): Promise<void>;
  chatToTerminal(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  fitAll(): void;
  focusTerm(id: string): void;
  termEl(id: string): HTMLElement;
  renameAgent(id: string, title: string): Promise<void>;
  markSidebar(): void;
  toggleSidebar(): void;
  state(): import('../../../shared/types').AppState;
  revealSession(path: string, id: string): Promise<void>;
  activePath(): string | null;
  agentInfo(id: string): Session | null;
}

declare global {
  interface Window {
    harbor: HarborApi;
    harborApp: HarborApp;
    harborTree: typeof import('../components/tree/store').harborTree;
    harborLayout: typeof import('../legacy/layout').harborLayout;
    harborEditor: typeof import('../legacy/editor').harborEditor;
    harborChat: typeof import('../components/chat').harborChat;
    harborChatMd: { render(md: string): string };
    harborDebug: LegacyModule;
    harborDnd: typeof import('../legacy/dnd').harborDnd;
  }
}

export const H = window.harbor;
export const Layout = () => window.harborLayout;
export const Editor = () => window.harborEditor;
