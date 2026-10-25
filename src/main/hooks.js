'use strict';
// Claude Code lifecycle hooks -> exact working/idle state. Agents started with `claude` get
// `--settings <hooks.json>`; each hook runs a tiny script that pings this local server with
// the agent id (HARBOR_AGENT_ID, set in the launch command). Other agents fall back to heuristics.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const EVENTS = { prompt: 'working', tool: 'working', stop: 'idle', wait: 'waiting', end: 'idle' }; // hook event -> agent state

class HookServer extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = path.join(dir, 'hooks');
    this.settingsFile = path.join(this.dir, 'claude-settings.json');
    this.portFile = path.join(this.dir, 'port');
    this.script = path.join(this.dir, 'notify.sh');
    this.server = null;
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    // the script reads the port on every call, so tmux sessions that outlive Harbor reach the new server
    fs.writeFileSync(this.script, [
      '#!/bin/sh',
      '[ -n "$HARBOR_AGENT_ID" ] || exit 0',
      `port=$(cat '${this.portFile}' 2>/dev/null) || exit 0`,
      'curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/$1/$HARBOR_AGENT_ID"',
      'exit 0', '',
    ].join('\n'), { mode: 0o755 });
    const hook = (ev, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `'${this.script}' ${ev}` }] }];
    fs.writeFileSync(this.settingsFile, JSON.stringify({
      hooks: {
        UserPromptSubmit: hook('prompt'),
        PreToolUse: hook('tool'),                              // resumes "working" after a permission prompt
        Stop: hook('stop'),
        Notification: hook('wait', 'permission_prompt|elicitation_dialog'),
        SessionEnd: hook('end'),
      },
    }, null, 2));
    this.server = http.createServer((req, res) => {
      const [, ev, id] = req.url.split('/');
      if (ev in EVENTS && id) this.emit('event', decodeURIComponent(id), ev, EVENTS[ev]);
      res.end();
    });
    await new Promise((ok, fail) => { this.server.once('error', fail); this.server.listen(0, '127.0.0.1', ok); });
    fs.writeFileSync(this.portFile, String(this.server.address().port));
  }

  /** `claude …` -> `HARBOR_AGENT_ID=<id> claude --settings <file> --name <name> …`; other commands untouched. */
  wrap(command, id, name) {
    const m = /^claude(\s.*)?$/s.exec((command || '').trim());
    if (!m || !this.server) return command;
    return `HARBOR_AGENT_ID=${id} claude --settings '${this.settingsFile}'${name ? ` --name '${name}'` : ''}${m[1] || ''}`;
  }

  dispose() { try { this.server && this.server.close(); } catch { /* */ } }
}

module.exports = { HookServer };
