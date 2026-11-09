import { H } from '../lib/tawny';

export interface LspSymbol {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range?: { start: { line: number; character: number } } };
}

export const SYM_KINDS = [
  null,
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];
export const SYM_LIMIT = 200;
export const NO_SERVER_MSG = 'No language server running — open a Ruby or TypeScript file (see status bar)';

/** workspace/symbol from every running language server; `running` is false when none answered. */
export async function searchSymbols(root: string, query: string): Promise<{ syms: LspSymbol[]; running: boolean }> {
  const res = await Promise.all(
    ['ruby', 'ts'].map((k) => H.lspRequest(root, k, 'workspace/symbol', { query }).catch(() => null)),
  );
  const syms = res
    .flatMap((r) => r || [])
    .filter((s: LspSymbol) => s.location?.uri.startsWith('file://'))
    .slice(0, SYM_LIMIT);
  return { syms, running: res.some(Boolean) };
}

/** Absolute path, root-relative path and 1-based line of a symbol. */
export function symbolWhere(s: LspSymbol, root: string | null) {
  const path = decodeURIComponent(s.location.uri.slice(7));
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const r = s.location.range;
  return { path, rel, line: r ? r.start.line + 1 : 1, col: r ? r.start.character + 1 : undefined };
}
