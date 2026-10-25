'use strict';
// Transcript model of a chat tab, built by folding ACP `session/update`s. Main keeps it so a remount,
// a second window or a page move renders from `chatHistory` without the agent replaying anything.

const emptyModel = () => ({
  items: [],        // [{type:'user'|'agent'|'thought', id, text} | {type:'tool', id} | {type:'notice', text}], in display order
  tools: {},        // toolCallId -> merged tool call (+ terminal: {output, exit})
  plan: null,       // latest plan entries
  usage: null,      // {used, size, cost}
  title: null,
  commands: [],     // available_commands_update
  configOptions: null,
  currentModeId: null,
  pending: [],      // permission requests waiting for an answer: [{reqId, toolCall, options}]
});

const TEXT_ITEMS = { user_message_chunk: 'user', agent_message_chunk: 'agent', agent_thought_chunk: 'thought' };

function appendText(m, type, u) {
  const text = u.content && u.content.type === 'text' ? u.content.text : '';
  const id = u.messageId || null;
  const last = m.items[m.items.length - 1];
  if (last && last.type === type && (!id || last.id === id)) last.text += text;
  else m.items.push({ type, id, text });
}

/** Merge a tool_call / tool_call_update: an absent field means unchanged (the first tool_call is a stub). */
function mergeTool(m, u) {
  let t = m.tools[u.toolCallId];
  if (!t) {
    t = m.tools[u.toolCallId] = { toolCallId: u.toolCallId };
    m.items.push({ type: 'tool', id: u.toolCallId });
  }
  for (const k of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput']) if (u[k] !== undefined && u[k] !== null) t[k] = u[k];
  const meta = u._meta || {};
  if (meta.claudeCode && meta.claudeCode.toolName) t.toolName = meta.claudeCode.toolName;
  if (meta.terminal_info) t.terminal = { output: '', exit: null };
  if (meta.terminal_output) {
    t.terminal = t.terminal || { output: '', exit: null };
    t.terminal.output += meta.terminal_output.data || '';
  }
  if (meta.terminal_exit) {
    t.terminal = t.terminal || { output: '', exit: null };
    t.terminal.exit = { code: meta.terminal_exit.exit_code, signal: meta.terminal_exit.signal };
  }
}

function fold(m, u) {
  const type = u.sessionUpdate;
  if (TEXT_ITEMS[type]) appendText(m, TEXT_ITEMS[type], u);
  else if (type === 'tool_call' || type === 'tool_call_update') mergeTool(m, u);
  else if (type === 'plan') m.plan = u.entries;
  else if (type === 'usage_update') m.usage = { used: u.used, size: u.size, cost: u.cost || (m.usage && m.usage.cost) || null };
  else if (type === 'session_info_update') { if (u.title) m.title = u.title; }
  else if (type === 'available_commands_update') m.commands = u.availableCommands;
  else if (type === 'config_option_update') m.configOptions = u.configOptions;
  else if (type === 'current_mode_update') m.currentModeId = u.currentModeId;
  else if (type === 'notice' || type === 'compaction_update') m.items.push({ type: 'notice', kind: type, text: u.text || u.message || '' });
  return m;
}

module.exports = { emptyModel, fold };
