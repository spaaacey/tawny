import { useEffect, useRef, useState } from 'react';
import { askAgent, sendTargets } from '../lib/actions';
import { useStore } from '../store';
import { Button, Textarea } from '../ui';
import { Backdrop } from './Overlay';

/** Message box for the agent: `ref` (e.g. "@file#L3-5") is prefixed; shift+tab cycles the target agent (current one first). */
export function SendBox() {
  const ref = useStore((s) => s.sendRef);
  const close = useStore((s) => s.closeOverlay);
  const [targets] = useState(sendTargets);
  const [idx, setIdx] = useState(targets.index);
  const [msg, setMsg] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);

  const agent = targets.agents[idx];
  const submit = async () => {
    const id = agent?.id;
    close(false);
    await askAgent(ref, msg.trim(), id);
  };

  return (
    <Backdrop>
      <div className="sendbox">
        <div className="send-head">
          <span className="send-ref">{ref}</span>
          {targets.agents.length > 1 && agent && (
            <span className="send-agent">
              <i className={`sdot${agent.waiting ? ' wait' : agent.working ? ' work' : ''}`} />
              <span>{agent.label}</span>
              <kbd>shift+tab</kbd>
            </span>
          )}
        </div>
        <Textarea
          ref={input}
          rows={4}
          placeholder="Message to agent…"
          spellCheck={false}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault();
              if (targets.agents.length > 1) setIdx((idx + 1) % targets.agents.length);
            } else if (e.key === 'Escape') close();
          }}
        />
        <div className="send-actions">
          <Button variant="ghost" onClick={() => close()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Send <span className="send-hint">⌘↵</span>
          </Button>
        </div>
      </div>
    </Backdrop>
  );
}
