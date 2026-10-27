// biome-ignore lint/suspicious/noExplicitAny: only for genuinely dynamic values (ipc handler args from the renderer, the untyped ACP SDK module); protocol payloads have real types
export type Any = any;

// ---- LSP

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface TextEdit {
  range: LspRange;
  newText: string;
}
/** A JSON-RPC 2.0 message as read off an LSP/DAP-style stream; which fields are set tells request/response/notification apart. */
export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

// ---- hooks

/** Body of a Claude Code hook POST (only the fields Tawny reads are typed). */
export interface HookPayload {
  transcript_path?: string;
  [k: string]: unknown;
}
