// LSP → Monaco providers (completion, hover, definitions, …) plus openers that turn
// Monaco navigations into Tawny tab opens. `openFile`/`pushHistory` arrive as deps —
// they live in the layout/editor UI layer, which must not be imported from here.
import type * as Monaco from 'monaco-editor';
import { H } from '../lib/legacy';
import { ensureModel, type Meta, metaOf, req } from './models';
import { docString, editsByFile, markdown, toDocSymbols, toLspPos, toLspRange, toRange, uriToPath } from './protocol';

// Monaco is loaded at runtime by the AMD loader (vs/loader.js) and lands on the global scope.
declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads are loosely typed
type Any = any;
type OpenSel = { startLineNumber?: number; lineNumber: number; column: number } | Monaco.IRange;

export interface ProviderDeps {
  openFile(path: string, opts?: { selection?: OpenSel; recordHistory?: boolean }): unknown;
  pushHistory(): void;
}

const KIND_NAMES: (string | null)[] = [
  null,
  'Text',
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Interface',
  'Module',
  'Property',
  'Unit',
  'Value',
  'Enum',
  'Keyword',
  'Snippet',
  'Color',
  'File',
  'Reference',
  'Folder',
  'EnumMember',
  'Constant',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];

async function toMonacoWorkspaceEdit(edit: Any) {
  const result: { edits: Monaco.languages.IWorkspaceTextEdit[] } = { edits: [] };
  for (const [path, edits] of editsByFile(edit)) {
    await ensureModel(path).catch(() => null);
    for (const e of edits)
      result.edits.push({
        resource: monaco.Uri.file(path),
        textEdit: { range: toRange(e.range), text: e.newText },
        versionId: undefined,
      });
  }
  return result;
}

async function toLocations(res: Any) {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: Monaco.languages.Location[] = [];
  for (const l of arr) {
    const uri = l.targetUri || l.uri;
    const range = l.targetSelectionRange || l.targetRange || l.range;
    const p = uriToPath(uri);
    if (!p || !range) continue;
    try {
      await ensureModel(p);
    } catch {
      continue;
    }
    out.push({ uri: monaco.Uri.file(p), range: toRange(range) });
  }
  return out;
}

export function registerProviders({ openFile, pushHistory }: ProviderDeps) {
  const langs = ['typescript', 'javascript', 'ruby', 'html'];
  const L = monaco.languages;
  for (const lang of langs) {
    L.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '"', "'", '/', '@', '<', '#', '$'],
      async provideCompletionItems(model, position, ctx) {
        const m = metaOf(model);
        if (!m?.lspOpen) return { suggestions: [] };
        const res = await req(model, 'textDocument/completion', {
          position: toLspPos(position),
          context:
            ctx.triggerKind === 1 && ctx.triggerCharacter
              ? { triggerKind: 2, triggerCharacter: ctx.triggerCharacter }
              : { triggerKind: ctx.triggerKind === 2 ? 3 : 1 },
        });
        if (!res) return { suggestions: [] };
        const items = Array.isArray(res) ? res : res.items || [];
        const word = model.getWordUntilPosition(position);
        const def = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
        const suggestions = items.slice(0, 1000).map((it: Any) => {
          const te = it.textEdit;
          let range: Any = def;
          let insertText = it.insertText ?? (typeof it.label === 'string' ? it.label : it.label.label);
          if (te) {
            insertText = te.newText;
            range = te.range ? toRange(te.range) : { insert: toRange(te.insert), replace: toRange(te.replace) };
          }
          return {
            label: it.labelDetails
              ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description }
              : it.label,
            kind: (L.CompletionItemKind as Any)[KIND_NAMES[it.kind] || 'Text'] ?? L.CompletionItemKind.Text,
            detail: it.detail,
            documentation: docString(it.documentation),
            sortText: it.sortText,
            filterText: it.filterText,
            preselect: it.preselect,
            insertText,
            range,
            insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : 0,
            additionalTextEdits: (it.additionalTextEdits || []).map((e: Any) => ({
              range: toRange(e.range),
              text: e.newText,
            })),
            commitCharacters: it.commitCharacters,
            tags: it.deprecated || (it.tags || []).includes(1) ? [L.CompletionItemTag.Deprecated] : [],
            _lsp: it,
            _meta: m,
          };
        });
        return { suggestions, incomplete: !Array.isArray(res) && !!res.isIncomplete };
      },
      async resolveCompletionItem(item: Any) {
        const m = item._meta as Meta | undefined;
        if (!m?.lspOpen || item.documentation) return item;
        try {
          const r = await H.lspRequest(m.root as string, m.kind as string, 'completionItem/resolve', item._lsp);
          if (r) {
            item.documentation = docString(r.documentation) || item.documentation;
            item.detail = r.detail || item.detail;
            if (r.additionalTextEdits)
              item.additionalTextEdits = r.additionalTextEdits.map((e: Any) => ({
                range: toRange(e.range),
                text: e.newText,
              }));
          }
        } catch {
          /* not supported */
        }
        return item;
      },
    });

    L.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const r = await req(model, 'textDocument/hover', { position: toLspPos(position) });
        if (!r?.contents) return null;
        const contents = markdown(r.contents);
        return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
      },
    });

    L.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        pushHistory();
        return toLocations(await req(model, 'textDocument/definition', { position: toLspPos(position) }));
      },
    });
    L.registerTypeDefinitionProvider(lang, {
      async provideTypeDefinition(model, position) {
        return toLocations(await req(model, 'textDocument/typeDefinition', { position: toLspPos(position) }));
      },
    });
    L.registerImplementationProvider(lang, {
      async provideImplementation(model, position) {
        return toLocations(await req(model, 'textDocument/implementation', { position: toLspPos(position) }));
      },
    });
    L.registerReferenceProvider(lang, {
      async provideReferences(model, position, ctx) {
        return toLocations(
          await req(model, 'textDocument/references', {
            position: toLspPos(position),
            context: { includeDeclaration: ctx.includeDeclaration },
          }),
        );
      },
    });

    L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      async provideSignatureHelp(model, position) {
        const r = await req(model, 'textDocument/signatureHelp', { position: toLspPos(position) });
        if (!r?.signatures?.length) return null;
        return {
          value: {
            signatures: r.signatures.map((s: Any) => ({
              label: s.label,
              documentation: docString(s.documentation),
              parameters: (s.parameters || []).map((p: Any) => ({
                label: p.label,
                documentation: docString(p.documentation),
              })),
              activeParameter: s.activeParameter,
            })),
            activeSignature: r.activeSignature || 0,
            activeParameter: r.activeParameter || 0,
          },
          dispose() {},
        };
      },
    });

    L.registerDocumentHighlightProvider(lang, {
      async provideDocumentHighlights(model, position) {
        const r = await req(model, 'textDocument/documentHighlight', { position: toLspPos(position) });
        return (r || []).map((h: Any) => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 }));
      },
    });

    L.registerDocumentSymbolProvider(lang, {
      displayName: 'LSP',
      async provideDocumentSymbols(model) {
        const r = await req(model, 'textDocument/documentSymbol');
        return toDocSymbols(r);
      },
    });

    L.registerRenameProvider(lang, {
      async provideRenameEdits(model, position, newName) {
        const r = await req(model, 'textDocument/rename', { position: toLspPos(position), newName });
        if (!r) return { edits: [], rejectReason: 'Nothing to rename here' };
        return toMonacoWorkspaceEdit(r);
      },
    });

    L.registerDocumentFormattingEditProvider(lang, {
      async provideDocumentFormattingEdits(model, options) {
        const r = await req(model, 'textDocument/formatting', {
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        });
        return (r || []).map((e: Any) => ({ range: toRange(e.range), text: e.newText }));
      },
    });

    L.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, ctx) {
        const m = metaOf(model);
        if (!m?.lspOpen) return { actions: [], dispose() {} };
        const diags = m.diags.filter((d) => toRange(d.range).intersectRanges(range));
        const r = await req(model, 'textDocument/codeAction', {
          range: toLspRange(range),
          context: {
            diagnostics: diags,
            only: ctx.only ? [ctx.only] : undefined,
            triggerKind: ctx.trigger === 1 ? 1 : 2,
          },
        });
        const actions: Any[] = [];
        for (const a of r || []) {
          if (a.command && typeof a.command === 'string') {
            // bare Command
            actions.push({
              title: a.title,
              command: { id: 'harbor.lsp.exec', title: a.title, arguments: [m.root, m.kind, a] },
            });
            continue;
          }
          const act: Any = {
            title: a.title,
            kind: a.kind,
            isPreferred: a.isPreferred,
            diagnostics: [],
            _lsp: a,
            _meta: m,
          };
          if (a.edit) act.edit = await toMonacoWorkspaceEdit(a.edit);
          if (a.command)
            act.command = { id: 'harbor.lsp.exec', title: a.command.title, arguments: [m.root, m.kind, a.command] };
          actions.push(act);
        }
        return { actions, dispose() {} };
      },
      async resolveCodeAction(action: Any) {
        if (action.edit || !action._lsp || !action._meta) return action;
        try {
          const r = await H.lspRequest(
            action._meta.root as string,
            action._meta.kind as string,
            'codeAction/resolve',
            action._lsp,
          );
          if (r?.edit) action.edit = await toMonacoWorkspaceEdit(r.edit);
        } catch {
          /* */
        }
        return action;
      },
    });
  }

  monaco.editor.registerCommand('harbor.lsp.exec', (_acc, r, kind, cmd) =>
    H.lspRequest(r, kind, 'workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments }).catch(
      () => {},
    ),
  );

  // go-to-definition, peek "open", reference clicks -> open as a Tawny tab
  monaco.editor.registerEditorOpener({
    openCodeEditor(_src, resource, sel) {
      if (resource.scheme !== 'file') return false;
      openFile(resource.path, { selection: sel, recordHistory: false });
      return true;
    },
  });
  // links inside hovers (ruby-lsp: file:///…#L12,3)
  if (monaco.editor.registerLinkOpener) {
    monaco.editor.registerLinkOpener({
      open(uri) {
        if (uri.scheme !== 'file') return false;
        const mm = /L(\d+)(?:,(\d+))?/.exec(uri.fragment || '');
        openFile(uri.path.replace(/\/{2,}/g, '/'), {
          selection: mm ? { lineNumber: +mm[1], column: +(mm[2] || 1) } : undefined,
        });
        return true;
      },
    });
  }
}
