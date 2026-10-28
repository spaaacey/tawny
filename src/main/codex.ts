// Translate the installed Codex app-server protocol into Tawny's chat events.
// Codex owns model discovery, auth, execution, permissions and thread storage.
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ConfigOption, SessionUpdate } from '../shared/chat-model';
import type { Any } from './types';

interface Hooks {
  update(update: SessionUpdate): void;
  permission(params: Any): Promise<Any>;
  session?(id: string): void;
}
interface Model {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
}

export class CodexAgent {
  nextId = 0;
  pending = new Map<
    number,
    { resolve(value: Any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  models: Model[] = [];
  model = '';
  effort = '';
  thread = '';
  turn: { id: string | null; resolve(value: Any): void; reject(error: Error): void } | null = null;
  streamed = new Set<string>();
  closed = false;
  lines;

  readonly proc: ChildProcess;
  readonly hooks: Hooks;
  constructor(proc: ChildProcess, hooks: Hooks) {
    this.proc = proc;
    this.hooks = hooks;
    this.lines = createInterface({ input: proc.stdout! });
    this.lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          this.serverRequest(message.method, message.params || {})
            .then((result) => this.send({ id: message.id, result }))
            .catch((e) => this.send({ id: message.id, error: { code: -32603, message: e.message } }));
        } else if (message.method) this.event(message.method, message.params || {});
        else {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
          else pending.resolve(message.result);
        }
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    proc.on('error', (e) => this.fail(e));
    proc.on('exit', (code, signal) => this.fail(new Error(`Codex exited (${signal || code})`)));
    proc.stdin!.on('error', (e) => this.fail(e));
  }

  send(message: Any) {
    if (!this.closed && !this.proc.stdin!.destroyed) this.proc.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  rpc(method: string, params: Any = {}): Promise<Any> {
    if (this.closed) return Promise.reject(new Error('Codex is disconnected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out responding to ${method}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.turn?.reject(error);
    this.turn = null;
  }

  close() {
    this.closed = true;
    this.fail(new Error('Codex connection closed'));
    this.lines.close();
    this.proc.kill();
  }

  async request(method: string, params: Any = {}): Promise<Any> {
    switch (method) {
      case 'initialize': {
        await this.rpc('initialize', {
          clientInfo: { name: 'tawny', title: 'Tawny', version: '0.2.0' },
          capabilities: { experimentalApi: true },
        });
        this.send({ method: 'initialized' });
        let cursor: string | null = null;
        do {
          const page = await this.rpc('model/list', { cursor });
          this.models.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        const preferred = this.models.find((m) => m.isDefault) || this.models[0];
        if (!preferred) throw new Error('Codex returned no models. Sign in with `codex login` and reconnect.');
        this.model = preferred.model;
        this.effort = preferred.defaultReasoningEffort;
        return {
          agentInfo: { name: 'codex', version: 'app-server' },
          agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } },
          authMethods: [{ id: 'login', name: 'Sign in with Codex', type: 'terminal', args: ['login'] }],
        };
      }
      case 'session/new':
      case 'session/load':
      case 'session/resume': {
        const account = await this.rpc('account/read', {});
        if (!account.account && account.requiresOpenaiAuth)
          throw Object.assign(new Error('Authentication required: sign in with Codex.'), { code: -32000 });
        const res = await this.rpc(method === 'session/new' ? 'thread/start' : 'thread/resume', {
          ...(method === 'session/new' ? {} : { threadId: params.sessionId }),
          cwd: params.cwd,
          // Use the installed runtime's model catalog, never the old ACP fallback.
          ...(method === 'session/new' ? { model: this.model } : {}),
        });
        this.thread = res.thread.id;
        const selected = this.models.find((m) => m.model === res.model);
        if (selected) {
          this.model = selected.model;
          this.effort = selected.supportedReasoningEfforts.some((e) => e.reasoningEffort === res.reasoningEffort)
            ? res.reasoningEffort
            : selected.defaultReasoningEffort;
        }
        if (method === 'session/load')
          for (const turn of res.thread.turns || []) for (const item of turn.items || []) this.item(item, true, true);
        if (res.thread.name) this.hooks.update({ sessionUpdate: 'session_info_update', title: res.thread.name });
        this.hooks.update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'fork', description: 'Branch this conversation in the current tab' }],
        });
        return { sessionId: this.thread, configOptions: this.config() };
      }
      case 'session/prompt':
        return this.prompt(params.prompt || []);
      case 'session/set_config_option': {
        if (params.configId === 'model') {
          const model = this.models.find((m) => m.model === params.value);
          if (!model) throw new Error(`Codex did not offer model "${params.value}".`);
          this.model = model.model;
          this.effort = model.defaultReasoningEffort;
        } else if (params.configId === 'effort') {
          const model = this.models.find((m) => m.model === this.model);
          if (!model?.supportedReasoningEfforts.some((e) => e.reasoningEffort === params.value))
            throw new Error(`Unsupported reasoning effort "${params.value}".`);
          this.effort = params.value;
        } else throw new Error(`Unknown Codex setting "${params.configId}".`);
        return { configOptions: this.config() };
      }
      case 'session/list': {
        const sessions: Any[] = [];
        let cursor: string | null = null;
        do {
          const page = await this.rpc('thread/list', { cwd: params.cwd, cursor, sortKey: 'updated_at' });
          sessions.push(
            ...page.data.map((t: Any) => ({
              sessionId: t.id,
              title: t.name || t.preview,
              updatedAt: new Date(t.updatedAt * 1000).toISOString(),
            })),
          );
          cursor = page.nextCursor;
        } while (cursor);
        return { sessions };
      }
      case 'session/close':
        await this.rpc('thread/unsubscribe', { threadId: params.sessionId });
        return {};
      default:
        throw new Error(`Codex does not support ${method}`);
    }
  }

  config(): ConfigOption[] {
    const model = this.models.find((m) => m.model === this.model);
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: this.model,
        options: this.models.map((m) => ({ value: m.model, name: m.displayName, description: m.description })),
      },
      {
        id: 'effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: this.effort,
        options: (model?.supportedReasoningEfforts || []).map((e) => ({
          value: e.reasoningEffort,
          name: e.reasoningEffort,
          description: e.description,
        })),
      },
    ];
  }

  async prompt(blocks: Any[]) {
    if (this.turn) throw new Error('A Codex turn is already running.');
    if (blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.trim() === '/fork') {
      const res = await this.rpc('thread/fork', { threadId: this.thread });
      this.thread = res.thread.id;
      this.hooks.session?.(this.thread);
      this.hooks.update({
        sessionUpdate: 'notice',
        text: 'Forked this conversation. New messages will use the new branch.',
      });
      return { stopReason: 'end_turn' };
    }
    const input = blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text, text_elements: [] };
      if (b.type === 'image') return { type: 'image', url: `data:${b.mimeType};base64,${b.data}` };
      if (b.type === 'resource_link') return { type: 'text', text: `@${b.name}\n${b.uri}`, text_elements: [] };
      if (b.type === 'resource' && b.resource?.text) return { type: 'text', text: b.resource.text, text_elements: [] };
      throw new Error(`Codex does not support content type "${b.type}".`);
    });
    return new Promise<Any>((resolve, reject) => {
      // Install the waiter before turn/start: completion can precede its response.
      const turn = (this.turn = { id: null as string | null, resolve, reject });
      this.streamed.clear();
      this.rpc('turn/start', { threadId: this.thread, input, model: this.model, effort: this.effort })
        .then((res) => {
          if (this.turn === turn) {
            turn.id = res.turn.id;
            if (this.cancelOnStart) {
              this.cancelOnStart = false;
              this.notify('session/cancel').catch((e) => this.fail(e));
            }
          }
        })
        .catch((e) => {
          if (this.turn === turn) this.turn = null;
          reject(e);
        });
    });
  }

  async notify(method: string) {
    if (method === 'session/cancel' && this.turn) {
      if (this.turn.id) await this.rpc('turn/interrupt', { threadId: this.thread, turnId: this.turn.id });
      else this.cancelOnStart = true;
    }
  }
  cancelOnStart = false;

  event(method: string, p: Any) {
    if (p.threadId && this.thread && p.threadId !== this.thread) return;
    if (method === 'turn/started' && this.turn) {
      this.turn.id = p.turn.id;
      if (this.cancelOnStart) {
        this.cancelOnStart = false;
        this.notify('session/cancel').catch((e) => this.fail(e));
      }
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      this.streamed.add(p.itemId);
      this.hooks.update({
        sessionUpdate: method === 'item/agentMessage/delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
        messageId: p.itemId,
        content: { type: 'text', text: p.delta },
      });
    } else if (method === 'item/started' || method === 'item/completed') {
      this.item(p.item, method === 'item/completed');
    } else if (method === 'turn/completed') {
      const turn = this.turn;
      this.turn = null;
      this.cancelOnStart = false;
      if (p.turn.status === 'failed') turn?.reject(new Error(p.turn.error?.message || 'Codex turn failed'));
      else turn?.resolve({ stopReason: p.turn.status === 'interrupted' ? 'cancelled' : 'end_turn' });
    } else if (method === 'error' && !p.willRetry) {
      this.hooks.update({
        sessionUpdate: 'notice',
        severity: 'error',
        text: p.error?.message || 'Codex request failed',
      });
    } else if (method === 'thread/name/updated') {
      this.hooks.update({ sessionUpdate: 'session_info_update', title: p.threadName });
    } else if (method === 'thread/tokenUsage/updated') {
      this.hooks.update({
        sessionUpdate: 'usage_update',
        used: p.tokenUsage.last.totalTokens,
        size: p.tokenUsage.modelContextWindow || 0,
      });
    } else if (method === 'turn/plan/updated') {
      this.hooks.update({
        sessionUpdate: 'plan',
        entries: p.plan.map((step: Any) => ({
          content: step.step,
          status: step.status === 'inProgress' ? 'in_progress' : step.status,
          priority: 'medium',
        })),
      });
    }
  }

  item(item: Any, completed: boolean, replay = false) {
    if (item.type === 'userMessage') {
      if (replay)
        for (const content of item.content) {
          if (content.type === 'text')
            this.hooks.update({
              sessionUpdate: 'user_message_chunk',
              messageId: item.id,
              content: { type: 'text', text: content.text },
            });
          if (content.type === 'image') {
            const match = /^data:([^;]+);base64,(.*)$/.exec(content.url || '');
            if (match)
              this.hooks.update({
                sessionUpdate: 'user_message_chunk',
                messageId: item.id,
                content: { type: 'image', mimeType: match[1], data: match[2] },
              });
          }
        }
      return;
    }
    if (item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan') {
      if (completed && !this.streamed.has(item.id))
        this.hooks.update({
          sessionUpdate: item.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
          messageId: item.id,
          content: { type: 'text', text: item.text || (item.summary || []).join('\n') },
        });
      return;
    }
    const kind = item.type === 'fileChange' ? 'edit' : item.type === 'commandExecution' ? 'execute' : 'other';
    this.hooks.update({
      sessionUpdate: completed ? 'tool_call_update' : 'tool_call',
      toolCallId: item.id,
      title: item.command || item.tool || item.type,
      kind,
      status: completed
        ? ['failed', 'declined'].includes(item.status) || item.error
          ? 'failed'
          : 'completed'
        : 'in_progress',
      rawInput: item.arguments || item.changes || item.command,
      rawOutput: item.aggregatedOutput || item.result || item.error,
      content: item.aggregatedOutput
        ? [{ type: 'content', content: { type: 'text', text: item.aggregatedOutput } }]
        : [],
      locations: (item.changes || []).map((c: Any) => ({ path: c.path })),
    } as unknown as SessionUpdate);
  }

  async serverRequest(method: string, p: Any) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const result = await this.hooks.permission({
        toolCall: {
          toolCallId: p.itemId,
          title: p.command || p.reason || 'Codex approval',
          kind: method.includes('fileChange') ? 'edit' : 'execute',
        },
        options: [
          { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
        ],
      });
      return {
        decision: result.outcome?.outcome === 'selected' && result.outcome.optionId === 'accept' ? 'accept' : 'decline',
      };
    }
    // Fail closed rather than granting tools or answering user questions silently.
    throw new Error(`Tawny does not yet support the Codex request ${method}.`);
  }
}
