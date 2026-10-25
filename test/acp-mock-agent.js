#!/usr/bin/env node
'use strict';
// Minimal ACP agent for exercising chat tabs without a real one: runs a command through the client's terminal/*.
// `mock-agent login` writes MOCK_AUTH_FILE; while that file is missing (and MOCK_AUTH_FILE is set) session/new asks for sign-in.
const fs = require('fs');
const readline = require('readline');

if (process.argv[2] === 'login') {
  if (process.env.MOCK_AUTH_FILE) fs.writeFileSync(process.env.MOCK_AUTH_FILE, 'ok');
  console.log('Logged in. You can close this tab and press Retry in the chat.');
  process.exit(0);
}

let nextId = 1000;
const waiting = new Map();
const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const call = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

async function prompt(id, { sessionId, prompt: blocks }) {
  const text = blocks.map(b => b.text || '').join('');
  const cmd = process.env.MOCK_CMD || "printf 'hello from pty\\n'; sleep 0.3; printf 'second line\\n'; exit 3";
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `You said: ${text}\n\nRunning a command…` } });
  const { terminalId } = await call('terminal/create', { sessionId, command: cmd });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run command', kind: 'execute', status: 'in_progress', rawInput: { command: cmd }, content: [{ type: 'terminal', terminalId }] });
  const exit = await call('terminal/wait_for_exit', { sessionId, terminalId });
  const out = await call('terminal/output', { sessionId, terminalId });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: exit.exitCode ? 'failed' : 'completed' });
  await call('terminal/release', { sessionId, terminalId });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Exit ${exit.exitCode}, ${out.output.length} bytes of output.` } });
  send({ id, result: { stopReason: 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) { const r = waiting.get(m.id); waiting.delete(m.id); if (r) r(m.result); return; }
  if (m.method === 'initialize') {
    const terminalAuth = m.params.clientCapabilities && m.params.clientCapabilities.auth && m.params.clientCapabilities.auth.terminal;
    send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '0.0.1' }, agentCapabilities: {}, authMethods: terminalAuth ? [{ id: 'login', name: 'Sign in (mock)', type: 'terminal', args: ['login'] }] : [] } });
  } else if (m.method === 'session/new') {
    if (process.env.MOCK_AUTH_FILE && !fs.existsSync(process.env.MOCK_AUTH_FILE)) send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    else send({ id: m.id, result: { sessionId: 'mock-1' } });
  } else if (m.method === 'session/prompt') prompt(m.id, m.params).catch(e => send({ id: m.id, error: { code: -32603, message: String(e) } }));
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
});
