// Claude Code lifecycle hooks -> exact working/idle state. Agents started with `claude` get
// `--settings <hooks.json>`; each hook runs a tiny script that pings this local server with
// the agent id (TAWNY_AGENT_ID, set in the launch command). Other agents fall back to heuristics.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

const EVENTS: Record<string, string> = {
  prompt: 'working',
  tool: 'working',
  stop: 'idle',
  wait: 'waiting',
  end: 'idle',
}; // hook event -> agent state

class HookServer extends EventEmitter {
  dir: string;
  settingsFile: string;
  portFile: string;
  script: string;
  server: http.Server | null = null;

  constructor(dir: string) {
    super();
    this.dir = path.join(dir, 'hooks');
    this.settingsFile = path.join(this.dir, 'claude-settings.json');
    this.portFile = path.join(this.dir, 'port');
    this.script = path.join(this.dir, 'notify.sh');
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    // the script reads the port on every call, so agents started under an earlier Tawny run reach the new server
    fs.writeFileSync(
      this.script,
      [
        '#!/bin/sh',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, not a JS template
        'id="${TAWNY_AGENT_ID:-$HARBOR_AGENT_ID}"', // HARBOR_AGENT_ID: agents launched before the rename
        '[ -n "$id" ] || exit 0',
        `port=$(cat '${this.portFile}' 2>/dev/null) || exit 0`,
        'curl -s -m 2 -o /dev/null --data-binary @- "http://127.0.0.1:$port/$1/$id"', // hook JSON arrives on stdin
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const hook = (ev: string, matcher?: string) => [
      { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `'${this.script}' ${ev}` }] },
    ];
    fs.writeFileSync(
      this.settingsFile,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: hook('prompt'),
            PreToolUse: hook('tool'), // resumes "working" after a permission prompt
            Stop: hook('stop'),
            Notification: hook('wait', 'permission_prompt|elicitation_dialog'),
            SessionEnd: hook('end'),
          },
        },
        null,
        2,
      ),
    );
    this.server = http.createServer((req, res) => {
      const [, ev, id] = (req.url ?? '').split('/');
      let body = '';
      req.on('data', (d) => {
        if (body.length < 65536) body += d;
      });
      req.on('end', () => {
        let payload: unknown = {};
        try {
          payload = JSON.parse(body);
        } catch {
          /* no/invalid body */
        }
        if (ev in EVENTS && id) this.emit('event', decodeURIComponent(id), ev, EVENTS[ev], payload);
        res.end();
      });
    });
    const server = this.server;
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', ok);
    });
    fs.writeFileSync(this.portFile, String((server.address() as AddressInfo).port));
  }

  /** `claude …` -> `TAWNY_AGENT_ID=<id> claude --settings <file> --name <name> …`; other commands untouched. */
  wrap(command: string, id: string, name?: string) {
    const m = /^claude(\s.*)?$/s.exec((command || '').trim());
    if (!m || !this.server) return command;
    return `TAWNY_AGENT_ID=${id} claude --settings '${this.settingsFile}'${name ? ` --name '${name}'` : ''}${m[1] || ''}`;
  }

  dispose() {
    try {
      this.server && this.server.close();
    } catch {
      /* */
    }
  }
}

export { HookServer };
