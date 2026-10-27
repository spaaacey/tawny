export interface Location {
  path: string;
  line?: number;
}

export interface DiffContent {
  type: 'diff';
  path?: string;
  oldText?: string | null;
  newText?: string | null;
}

export interface ToolContent {
  type: string;
  text?: string;
  path?: string;
  oldText?: string | null;
  newText?: string | null;
  content?: { type: string; text?: string };
}

export interface Tool {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: Location[];
  rawInput?: { command?: string; description?: string };
  content?: ToolContent[];
  terminal?: { output: string; exit?: { code?: number } };
}

export interface PermOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface PermRequest {
  reqId: number;
  toolCall: Tool;
  options: PermOption[];
}

export interface Item {
  type: string;
  id?: string | null;
  text?: string;
  images?: Image[];
  description?: string;
  severity?: string;
  status?: string;
  summary?: string;
}

export interface Command {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface ConfigValue {
  value: string;
  name: string;
  description?: string;
  options?: ConfigValue[];
}

export interface ConfigOption {
  id: string;
  type: string;
  category?: string;
  currentValue: string;
  options?: ConfigValue[];
}

export interface PlanEntry {
  content: string;
  status?: string;
}

export interface ChatModel {
  items: Item[];
  tools: Record<string, Tool>;
  pending: PermRequest[];
  commands?: Command[];
  configOptions?: ConfigOption[];
  plan?: PlanEntry[];
  usage?: { used: number; size: number };
}

export interface AgentMeta {
  name: string;
  label: string;
  builtin?: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  terminal?: boolean;
}

export interface FileHit {
  f: string;
  hits: number[];
  line: number;
}

export type Pick =
  | { kind: 'file'; items: FileHit[]; sel: number; start: number; end: number }
  | { kind: 'cmd'; items: Command[]; sel: number; start: number; end: number };

export interface Msg {
  text: string;
  blocks: unknown[];
}

/** A non-image file attached by path; the agent gets a resource_link. `src` (videos only) is just for the preview chip. */
export interface AttachedFile {
  name: string;
  path: string;
  mimeType: string;
  src?: string;
}

export interface Image {
  mimeType: string;
  data: string;
}

export type ChatEvent =
  | { k: 'u'; seq: number; update: unknown }
  | { k: 'p'; req: PermRequest }
  | { k: 'd'; reqId: number }
  | { k: 's'; status: string; error: string | null; auth?: AuthMethod[] };
