import { useEffect, useRef, useState } from 'react';
import { focusAgent } from '../lib/actions';
import { H } from '../lib/legacy';
import { useStore } from '../store';
import { Backdrop } from './Overlay';

export function NewWorktreeModal() {
  const repos = useStore((s) => s.app.repos);
  const initialRepo = useStore((s) => s.worktreeRepo);
  const close = useStore((s) => s.closeOverlay);
  const [repo, setRepo] = useState(initialRepo ?? repos[0]?.path ?? '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [startAgent, setStartAgent] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => branchRef.current?.focus(), []);
  useEffect(() => {
    let live = true;
    H.currentBranch(repo).then(
      (b) => live && setBase(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [repo]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = branch.trim();
    if (!/^[^\s~^:?*[\\]+$/.test(name) || name.includes('..')) {
      setErr('Invalid branch name');
      return;
    }
    setBusy(true);
    try {
      await H.createWorktree({ repo, branch: name, base: base.trim(), startAgent });
      close(false);
      if (startAgent) setTimeout(focusAgent, 400);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Backdrop>
      <form className="modal" autoComplete="off" onSubmit={submit}>
        <h2>New worktree</h2>
        {repos.length > 1 && (
          <label>
            Repository
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Branch
          <input
            ref={branchRef}
            placeholder="feature/thing"
            spellCheck={false}
            required
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <label>
          <span>
            Base <span className="muted">— only used if the branch is new</span>
          </span>
          <input spellCheck={false} value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={startAgent} onChange={(e) => setStartAgent(e.target.checked)} /> Start an
          agent in it
        </label>
        <div className="err">{err}</div>
        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={() => close()}>
            Cancel
          </button>
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}
