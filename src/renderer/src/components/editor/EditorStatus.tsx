// Status line under the panes: language-server state, problem counts, cursor position, language. Re-rendered when the
// editor module calls `renderStatus` (cursor / model / diagnostics / LSP changes).
import { useState } from 'react';
import { create } from 'zustand';
import type { LspInfo } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { alertDialog } from '../../lib/dialog';
import { H } from '../../lib/harbor';
import { metaOf, models } from '../../lsp/models';
import { activeFile } from '../workspace/layoutStore';
import { currentEditor } from './host';

const useStatus = create<{ tick: number; lsp: LspInfo[] }>(() => ({ tick: 0, lsp: [] }));

export const renderStatus = () => useStatus.setState((s) => ({ tick: s.tick + 1 }));
export const setLspInfo = (lsp: LspInfo[]) => useStatus.setState((s) => ({ lsp, tick: s.tick + 1 }));
export const lspInfo = () => useStatus.getState().lsp;

function LspButtons({ st, root, kind }: { st: LspInfo; root: string; kind: string }) {
  const [installing, setInstalling] = useState(false);
  return (
    <>
      {st.installable && (
        <button
          type="button"
          className="sbtn"
          disabled={installing}
          onClick={async () => {
            setInstalling(true);
            try {
              await H.lspInstallRuby(root);
              toast('ruby-lsp installed');
            } catch (err) {
              void alertDialog(`gem install ruby-lsp failed:\n\n${(err as Error).message}`);
            }
            setInstalling(false);
          }}
        >
          {installing ? 'Installing…' : 'Install ruby-lsp'}
        </button>
      )}
      <button type="button" className="sbtn" onClick={() => H.lspRestart(root, kind)}>
        Retry
      </button>
      <button type="button" className="sbtn" onClick={() => void alertDialog(st.error ?? 'No details')}>
        Details
      </button>
    </>
  );
}

export function EditorStatus() {
  useStatus();
  const lsp = useStatus.getState().lsp;
  const active = activeFile();
  if (!active) return null;
  const editor = currentEditor();
  const m = editor?.getModel() ? metaOf(editor.getModel()) : models.get(active);
  const st = m?.kind ? lsp.find((s) => s.root === m.root && s.kind === m.kind) : undefined;
  const errs = m?.model ? m.diags.filter((d) => d.severity === 1).length : 0;
  const warns = m?.model ? m.diags.filter((d) => d.severity === 2).length : 0;
  const pos = editor?.getModel() ? editor.getPosition() : null;
  return (
    <div id="edStatus">
      <div className="sl">
        {m?.kind
          ? st &&
            (st.state === 'error' ? (
              <>
                <span className="lsp err" title={st.error}>
                  ⚠ {st.name} not running
                </span>
                <LspButtons st={st} root={m.root as string} kind={m.kind} />
              </>
            ) : st.state === 'starting' ? (
              <span className="lsp busy">
                <i className="mini-spin" />
                {st.name} starting…
              </span>
            ) : st.progress ? (
              <span className="lsp busy">
                <i className="mini-spin" />
                {st.progress}
              </span>
            ) : (
              <span className="lsp ok">● {st.name}</span>
            ))
          : m?.model && <span className="lsp off">No language server</span>}
        {m?.model && (
          <span
            className="probs"
            title="Next problem (F8)"
            onClick={() => {
              editor?.focus();
              editor?.trigger('harbor', 'editor.action.marker.next', null);
            }}
          >
            ⊗ {errs} ⚠ {warns}
          </span>
        )}
      </div>
      <div className="sr">
        {m?.conflict && <span className="lsp err">File changed on disk — save to overwrite or close to discard</span>}
        {pos && (
          <span>
            Ln {pos.lineNumber}, Col {pos.column}
          </span>
        )}
        {m?.model && <span>{m.model.getLanguageId()}</span>}
      </div>
    </div>
  );
}
