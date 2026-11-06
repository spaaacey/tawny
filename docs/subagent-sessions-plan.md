# Subagent sessions: show each subagent's model and effort

Goal: every subagent row in chat shows the model, effort and agent type it **actually** ran with, not a guess from the Agent call's input.

## Why native subagent sessions

The Claude ACP adapter (`@agentclientprotocol/claude-agent-acp` 0.95.0) only reports a subagent's resolved model/effort when the client opts into **native subagent sessions** (the ACP subagents RFD, unstable):

- Today (no opt-in) a subagent's tool calls and text come on the root session, tagged `_meta.claudeCode.parentToolUseId`; Tawny nests them under the Agent tool row (`foldSub` in `src/shared/chat-model.ts`). The resolved model never reaches the client: `reportModel` and `subagentConfigurationHook` are gated on `subagentForm(...) === "rfd"`.
- Agent call input has `model`/`effort` only when the caller passed them; agent definitions (frontmatter `model:`) and inheritance are invisible. Rejected as inaccurate.

## Adapter behaviour in RFD form (read from `dist/native-subagents.js`, not yet seen live)

Opt-in: `clientCapabilities.subagents = {}` (top level of ClientCapabilities). Without the AIR capability the form is `rfd`.

Per child (child session id = SDK agent id; resumes get `:generation:N`):

1. On the **parent** session: `subagent_update` `{sessionId: <child>, title, description, capabilities: {cancel: {}}, state: {state: 'running'}}`. Title is `name (role)` or role (the subagent type); description is the Agent call's short description. Sent before any child traffic.
2. The Agent/Task tool call is **hidden** from the parent (`routeRfdLaunch` returns null) and replaced by `session_message`s:
   - launch prompt: parent -> child, `messageId = <toolUseId>`, published on both sessions (`linkedSessionMessages`).
   - reply: on the parent, `messageId = <toolUseId>:reply`, sender = child, content = the Agent result text (`launchReply`). The child's own transcript has the same answer as `agent_message_chunk`s.
   - hand-back mode: a `SubagentHandback` call becomes child -> parent `session_message`s instead.
   - Exception: a launch whose child was never announced (e.g. failed early) stays a normal Agent tool call on the parent (`unexposedControlFallback`). The existing Subagent row must keep working for it.
3. The child's tool calls, text, permission requests and `config_option_update`s come with `sessionId = <child>`. Config options (from hooks SubagentStart/Stop, PreToolUse, PostToolUse(Failure), PostModelSwitch, plus `reportModel` on each child `message_start`):
   - `category: 'model'` currentValue = resolved model id (e.g. `claude-haiku-5-5`)
   - `category: 'thought_level'` (id `effort`) currentValue = effort level (only on models with effort, only from tool-context hooks: a child that makes no tool call may never report effort)
   - id `agent`: subagent type
   - `category: 'mode'`: permission mode
4. On the parent: `subagent_update` `{sessionId, state}` as work changes: `running` / `requires_action` / `idle` + `stopReason` (`end_turn` | `cancelled` | `error` + `error`) / `unknown`.
5. Nested subagents: the grandchild's `subagent_update` is published on its immediate parent (the child session).
6. `session/load` replays children too (`RfdSubagentReplay`).

## Tawny-side findings

- Tawny's ACP client imports the **stable** SDK entry (`@agentclientprotocol/sdk`). Its zod validator **rejects** `subagent_update` and `session_message` (checked: `zSessionNotification.safeParse` fails), so those notifications would be dropped. The `@agentclientprotocol/sdk/unstable` entry accepts them and has identical exports (`client`, `ndJsonStream`, `methods`): swap the import.
- `push()`/`fold()` ignore `params.sessionId` today (one adapter process per tab, one session). Child routing needs the session id passed through, including fixture replay.
- Sub-tools of a subagent get `req={null}` today, so a permission request raised inside a subagent isn't shown inline. Fix while here.
- Status-bar layout bug in the screenshot: the subagent title overlaps the duration (`Phase 1: open + checkout` over `12.9s`). Fix while here.

## Design

Model (`src/shared/chat-model.ts`):

```ts
interface Subagent {
  sessionId: string;
  parentSessionId: string;   // root or another child
  title?: string; description?: string;
  state?: string; stopReason?: string; error?: string;
  startedAt?: number; endedAt?: number;   // stamped in main on running / idle
  model?: string; effort?: string; agentType?: string;
  prompt?: string;
  items: SubItem[];          // tools, agent text, nested { type: 'subagent', id }
}
ChatModel.subagents: Record<string, Subagent>
ChatItem | SubItem gains { type: 'subagent'; id: string }
```

`fold(m, u, sessionId?)`: when `sessionId` is a known child, fold into that child (tool calls into the shared `m.tools`, text into `items`, config options into model/effort/agentType). `subagent_update` creates/patches the child and inserts a `subagent` item into its parent's list. `session_message`: launch prompt -> `child.prompt`; the `:reply` view is ignored (the child transcript already has it). Root session id is stored on the model so fold can tell root from child. Old path (`parentToolUseId`) stays for agents without RFD (Codex, other ACP agents, unexposed launches).

UI (`ToolCard.tsx`): a `SubagentRow` for `subagent` items, same look as today's Subagent row: `Ran <description>` plus badges for agent type, model (short name: `haiku 5.5`), effort. Running state from `state`, duration from `startedAt`/`endedAt`. Expanding shows prompt (collapsed), child items, nested rows. Permission requests matched by tool id inside children.

## Phases

0. **Spike (costs one real run, needs the user's OK).** Add `--subagents` to `scripts/acp-spike.ts` (sets the capability, uses the unstable SDK), prompt: launch one Explore subagent with defaults and one general-purpose with explicit `model: haiku`, `effort: low`, each doing one Read. Record `test/fixtures/acp/claude-subagents.jsonl`, plus a `load` replay of it. Confirm the shapes above, especially: effort arrives, order of announce vs child traffic, permission request session id, what `config_option_update` lands on the root (must not clobber the footer's model picker).
1. **Plumbing.** Unstable SDK import; `subagents: {}` capability for the builtin Claude spec only; pass session id through `onNotify` -> `push` -> `fold` and fixture replay; model + fold changes; never let a child's `config_option_update` reach `m.configOptions`.
2. **UI.** Subagent row with badges, status, duration, nesting, inline permissions; title/duration overlap fix.
3. **Load + cancel.** Restore via `session/load` replay; Stop also cancels running children (`session/cancel` with child ids if the root cancel doesn't cover them; check in spike).

Verification: replay `claude-subagents.jsonl` with `TAWNY_ACP_FIXTURE` in the dev instance, screenshot the rows (running and done), expand, reload the tab.
