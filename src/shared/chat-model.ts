// Transcript model of a chat tab, built by folding ACP `session/update`s. Main keeps it so a remount,
// a second window or a page move renders from `chatHistory` without the agent replaying anything.

export interface TerminalState {
  output: string;
  exit: { code?: number | null; signal?: string | null } | null;
}

/** A tool_call merged across its tool_call / tool_call_update notifications. */
export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: { type: string; terminalId?: string; [k: string]: unknown }[];
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  toolName?: string;
  terminal?: TerminalState;
  /** Subagent run (Task/Agent tool): its messages and tool calls in order, tagged by `parentToolUseId`. */
  sub?: SubItem[];
}

export type SubItem = { type: 'tool'; id: string } | { type: 'agent'; text: string };

type ChatItemText = { text: string; images?: { mimeType: string; data: string }[] };

export type ChatItem =
  | {
      type: 'user' | 'agent' | 'thought';
      id: string | null;
      text: string;
      images?: { mimeType: string; data: string }[];
    }
  | { type: 'tool'; id: string }
  | { type: 'notice'; severity: string; text: string; description: string }
  | { type: 'clear' }
  | { type: 'compaction'; id: string; status: string; summary: string };

export interface FormQuestion {
  key: string; // form field id: `question_<n>`; its free-text companion is `<key>_custom`
  header?: string;
  question: string;
  multi: boolean;
  options: { value: string; label: string; description?: string }[];
}

/** Answer to an AskUserQuestion form: picked value(s) per question key, plus `<key>_custom` free text. */
export type FormAnswer = Record<string, string | string[]>;

export interface PendingPermission {
  reqId: number;
  toolCall: unknown;
  options: unknown[];
  form?: { questions: FormQuestion[] }; // AskUserQuestion: rendered as a question card instead of option buttons
}

/** A config option as sent by the agent (`category: 'mode'` carries the permission mode). */
export interface ConfigOption {
  id?: string;
  category?: string;
  currentValue?: unknown;
  /** Choices, or groups of choices (`{group, options}`). */
  options?: ConfigChoice[];
  [k: string]: unknown;
}
export interface ConfigChoice {
  value?: string;
  options?: ConfigChoice[];
  [k: string]: unknown;
}

export interface ChatModel {
  items: ChatItem[]; // in display order
  tools: Record<string, ToolCall>; // toolCallId -> merged tool call (+ terminal: {output, exit})
  terminals: Record<string, TerminalState>; // client terminal id (agents that use terminal/*)
  plan: unknown[] | null; // latest plan entries
  usage: { used: number; size: number; cost: unknown } | null;
  title: string | null;
  commands: unknown[]; // available_commands_update
  configOptions: ConfigOption[] | null;
  currentModeId: string | null;
  pending: PendingPermission[]; // permission requests waiting for an answer
  auth?: string | null; // label of the signed-in account (main only; never the email)
}

/**
 * An ACP `session/update` payload (plus Tawny's synthetic `x_*` updates). A single loose shape: the variants share
 * most field names and fold() dispatches on `sessionUpdate`, so a discriminated union would only add casts.
 */
export interface SessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string; data?: string; mimeType?: string };
  messageId?: string | null;
  toolCallId?: string;
  title?: string;
  text?: string;
  description?: string;
  severity?: string;
  kind?: string;
  status?: string;
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: {
    claudeCode?: { toolName?: string; parentToolUseId?: string };
    terminal_info?: unknown;
    terminal_output?: { data?: string };
    terminal_exit?: { exit_code?: number | null; signal?: string | null };
  };
  terminalId?: string;
  data?: string;
  exit?: { exitCode?: number | null; signal?: string | null };
  entries?: unknown[];
  used?: number;
  size?: number;
  cost?: unknown;
  availableCommands?: unknown[];
  configOptions?: ConfigOption[];
  currentModeId?: string;
  compactionId?: string;
}

export const emptyModel = (): ChatModel => ({
  items: [],
  tools: {},
  terminals: {},
  plan: null,
  usage: null,
  title: null,
  commands: [],
  configOptions: null,
  currentModeId: null,
  pending: [],
});

const TEXT_ITEMS: Record<string, 'user' | 'agent' | 'thought'> = {
  user_message_chunk: 'user',
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'thought',
};

/** Route a subagent's message or tool call into its parent tool's `sub` list instead of the transcript. */
function foldSub(m: ChatModel, parentId: string, u: SessionUpdate) {
  const parent = m.tools[parentId];
  if (!parent) return false;
  parent.sub ??= [];
  const sub = parent.sub;
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
    const id = u.toolCallId as string;
    if (!m.tools[id]) sub.push({ type: 'tool', id });
    mergeTool(m, u, false);
  } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
    const last = sub[sub.length - 1];
    if (last?.type === 'agent') last.text += u.content.text ?? '';
    else sub.push({ type: 'agent', text: u.content.text ?? '' });
  }
  return true;
}

function appendText(m: ChatModel, type: 'user' | 'agent' | 'thought', u: SessionUpdate) {
  const text = u.content && u.content.type === 'text' ? (u.content.text ?? '') : '';
  const image =
    u.content && u.content.type === 'image' && u.content.data
      ? { mimeType: String(u.content.mimeType), data: String(u.content.data) }
      : null;
  const id = u.messageId || null;
  const last = m.items[m.items.length - 1];
  const item = last && last.type === type && (!id || last.id === id) ? (last as ChatItemText) : null;
  if (item) {
    item.text += text;
    if (image) item.images = [...(item.images ?? []), image];
  } else m.items.push({ type, id, text, ...(image && { images: [image] }) });
}

/** Merge a tool_call / tool_call_update: an absent field means unchanged (the first tool_call is a stub). */
function mergeTool(m: ChatModel, u: SessionUpdate, top = true) {
  const id = u.toolCallId as string;
  let t = m.tools[id];
  if (!t) {
    t = m.tools[id] = { toolCallId: id };
    if (top) m.items.push({ type: 'tool', id });
  }
  const merged = t as unknown as Record<string, unknown>;
  for (const k of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput'] as const) {
    if (u[k] !== undefined && u[k] !== null) merged[k] = u[k];
  }
  const meta = u._meta || {};
  if (meta.claudeCode?.toolName) t.toolName = meta.claudeCode.toolName;
  linkTerminal(m, t);
  if (meta.terminal_info) t.terminal = { output: '', exit: null };
  if (meta.terminal_output) {
    t.terminal = t.terminal || { output: '', exit: null };
    t.terminal.output += meta.terminal_output.data || '';
  }
  if (meta.terminal_exit) {
    t.terminal = t.terminal || { output: '', exit: null };
    t.terminal.exit = { code: meta.terminal_exit.exit_code, signal: meta.terminal_exit.signal };
  }
}

/** A tool whose content embeds a client terminal shows that terminal's output. */
function linkTerminal(m: ChatModel, t: ToolCall) {
  if (t.terminal) return;
  const c = (t.content || []).find((x) => x.type === 'terminal' && x.terminalId && m.terminals[x.terminalId]);
  if (c?.terminalId) t.terminal = m.terminals[c.terminalId];
}

const TERM_KEEP = 200000;

/** Output/exit of a client terminal (synthetic `x_terminal` update from main), shown on the tool card that embeds it. */
function foldTerminal(m: ChatModel, u: SessionUpdate) {
  const tid = u.terminalId as string;
  let term = m.terminals[tid];
  if (!term) {
    term = { output: '', exit: null };
    m.terminals[tid] = term;
  }
  if (u.data) term.output = (term.output + u.data).slice(-TERM_KEEP);
  if (u.exit) term.exit = { code: u.exit.exitCode, signal: u.exit.signal };
  for (const t of Object.values(m.tools)) linkTerminal(m, t);
}

/** One divider per compactionId: status in_progress -> completed/cancelled, plus the retained summary as it streams. */
function foldCompaction(m: ChatModel, u: SessionUpdate) {
  let it = m.items.find((x) => x.type === 'compaction' && x.id === u.compactionId) as
    | Extract<ChatItem, { type: 'compaction' }>
    | undefined;
  if (!it) {
    it = { type: 'compaction', id: u.compactionId as string, status: 'in_progress', summary: '' };
    m.items.push(it);
  }
  if (u.status) it.status = u.status;
  if (u.content && u.content.type === 'text') it.summary += u.content.text ?? '';
}

export function fold(m: ChatModel, u: SessionUpdate): ChatModel {
  const type = u.sessionUpdate;
  const parentId = u._meta?.claudeCode?.parentToolUseId;
  if (parentId && foldSub(m, parentId, u)) return m;
  if (TEXT_ITEMS[type]) appendText(m, TEXT_ITEMS[type], u);
  else if (type === 'tool_call' || type === 'tool_call_update') mergeTool(m, u);
  else if (type === 'x_terminal') foldTerminal(m, u);
  else if (type === 'x_clear') {
    m.items.push({ type: 'clear' });
    m.plan = null;
    m.usage = null;
  } else if (type === 'plan') m.plan = u.entries ?? null;
  else if (type === 'usage_update')
    m.usage = { used: u.used ?? 0, size: u.size ?? 0, cost: u.cost || m.usage?.cost || null };
  else if (type === 'session_info_update') {
    if (u.title) m.title = u.title;
  } else if (type === 'available_commands_update') m.commands = u.availableCommands ?? [];
  else if (type === 'config_option_update') m.configOptions = u.configOptions ?? null;
  else if (type === 'current_mode_update') {
    m.currentModeId = u.currentModeId ?? null;
    const mode = (m.configOptions || []).find((o) => o.category === 'mode');
    if (mode) mode.currentValue = u.currentModeId;
  } else if (type === 'notice')
    m.items.push({
      type: 'notice',
      severity: u.severity || 'info',
      text: u.title || u.text || '',
      description: u.description || '',
    });
  else if (type === 'compaction_update' || type === 'compaction_summary_chunk') foldCompaction(m, u);
  return m;
}
