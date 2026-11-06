# Orchestrator: agents that open and drive other Tawny chats

Goal: one Claude chat (the orchestrator) opens other **Tawny chat tabs** (a planner, then one implementer per task), messages them, and hears back when they finish. The user can chat back and forth in every tab. Not subagents: each one is a full chat tab.

Workflow it serves:

1. The orchestrator opens a planner chat. The user grills or plans with it there, and it writes `docs/<feature>-plan.md` with tasks.
2. The user tells the orchestrator planning is done (or the planner messages it).
3. For each task, the orchestrator opens an implementer chat (in its own worktree when tasks run in parallel) with the prompt "Read docs/<feature>-plan.md, do task N, follow Decisions, tick task N and add notes under it".
4. Implementers report back. The orchestrator queues the next task, starts a review, and so on.

## Research summary

**Herdr** (`herdr --skill`, `herdr --help`) and **Orca** (`orca --help`, `orca skills get orca-cli`) both use the same pattern, and neither uses MCP:

- Environment variables in every managed terminal (`HERDR_ENV=1`, `HERDR_PANE_ID`, ...; `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY`, `ORCA_WORKTREE_ID`, ...).
- A local socket API in the app, with a CLI as a thin client that prints JSON (`herdr pane split|read|send-text`, `herdr agent start|prompt|wait`; `orca terminal split|read|send|wait`, `orca agent launch --prompt`, `orca worktree create --agent --prompt`).
- A skill that teaches the agent the CLI, gated on the environment variable. Orca installs a stub in `~/.claude/skills/` that defers to `orca skills get <name>`, so the guide always matches the installed binary.
- Claude Code hooks report agent state (idle/working/blocked). Tawny already does this (`src/main/hooks.ts`).
- Orca's "handoff" comes in two forms: (a) a UI action, "Hand Off to Another Agent", that starts a fresh session whose first prompt points at the original transcript file plus the last prompt and reply; (b) an agent-run `orca agent launch --prompt "<brief>"`, after which the first agent stops. In this workflow the plan doc does the handoff, so (a) isn't needed.

**Claude Code agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) don't fit:

- A teammate can't be spawned from Agent SDK or `-p` sessions. Tawny chat runs claude-agent-acp, which is built on the Agent SDK, so a chat can't be a team lead.
- Teammates show up inside the lead's terminal or as tmux/iTerm2 panes, never as Tawny chat tabs.

**Claude Code cross-session messaging** (v2.1.224+, on by default) covers most of the messaging:

- `ListAgents` and `SendMessage` reach the user's other sessions on the same machine over a Unix socket per session (`CLAUDE_CODE_MESSAGING_SOCKET`). Sessions are addressed by name (`--name` or `/rename`).
- An idle receiver gets the message as a new turn. A busy one gets it between tool calls.
- `SendMessage` with `notify_when_idle` sends one notice when the watched session next finishes a turn, so the orchestrator wakes without polling.
- `-p` sessions bind the socket too, so SDK-based Tawny chats should already be reachable (to verify).
- Inbound default: a session that bypasses permissions (Tawny chats default to `bypassPermissions`, see `defaultMode` in `src/main/acp.ts`) holds messages unless the sender also bypasses. SDK sessions can't show the approval dialog, so held messages drop after `dialogExpiry` (5 minutes). Fix: launch Tawny chats with `crossSessionInbound: "accept"`.
- Docs: https://code.claude.com/docs/en/agent-teams, https://code.claude.com/docs/en/cross-session-messaging.md

What's left for Tawny: **opening a chat tab from an agent**, and making chat sessions addressable by a name that matches the tab.

| Need | Covered by |
|---|---|
| Orchestrator messages planner and implementers | cross-session `SendMessage` (built in) |
| Orchestrator wakes when a child finishes | `notify_when_idle` (built in) |
| User chats with each agent | Tawny chat tabs (exist) |
| Orchestrator opens a chat tab with a first prompt | **new: `tawny chat new`** |
| Message addresses map to tabs | **new: launch chats with `--name <tab name>`** |

## Phase 0: check that messaging works in Tawny chats (no code)

- [ ] Open two Tawny chats in the dev instance, both with a real agent (manual check, not a fixture). In one, run `/list-agents`. Does the other chat appear?
- [ ] Ask one chat to `SendMessage` the other. Delivered, held or dropped? Check with both in `bypassPermissions` and with one in default mode.
- [ ] Try `notify_when_idle` from one chat to the other.
- [ ] Find out how to pass `--name` and `--settings '{"crossSessionInbound":"accept"}'` to the adapter's Claude process. Options: `_meta.claudeCode.options` in `session/new` (the adapter reads it, see `clear-context-coordinator.js`), the SDK's `extraArgs` / `settings`, or the adapter's process environment.

If Phase 0 fails (no socket in SDK sessions), fall back to Tawny-side messaging: `tawny chat send` / `tawny chat wait` over the control socket, and Tawny posts "chat X finished" into the orchestrator chat when hooks report idle. Write that up only if it's needed.

## Phase 1: chat sessions get names and accept messages

- [ ] Launch Claude chats with `--name <slug of tab title>` (unique per Tawny instance; add a suffix on collision) and `crossSessionInbound: "accept"`.
- [ ] Rename the session when the tab is renamed, if the adapter or SDK allows it. Otherwise keep the launch name and show it on the tab tooltip.
- [ ] Verify: `/list-agents` in chat A lists chat B by its tab name, and a message arrives without being held.

## Phase 2: `tawny` CLI with `chat new`

Control API:

- [ ] Main process: a control endpoint next to the hook server (`src/main/hooks.ts` already runs a local HTTP server and writes its port to a file). Local only, with a per-launch token.
- [ ] Environment for every chat adapter process and PTY: `TAWNY=1`, `TAWNY_CHAT_ID` (or `TAWNY_PANE_ID` for terminals), `TAWNY_WORKTREE`, `TAWNY_CONTROL` (port file path or URL), `TAWNY_TOKEN`.

CLI (Orca model: an Electron node-mode script packaged outside asar, its `bin` folder added to `PATH` in Tawny's PTYs and chat adapter processes; no global symlink needed at first):

- [ ] `tawny chat new --agent claude|codex [--name N] [--worktree PATH | --new-worktree NAME] [--prompt TEXT] [--no-focus]` opens a chat tab and prints JSON `{ chatId, name, worktree, sessionName }`. Default: current worktree, don't steal focus.
- [ ] `tawny chat list` prints JSON: id, name, agent, worktree, state (from hooks).
- [ ] `tawny --help` and `--json` everywhere.

Skill:

- [ ] `tawny skills get tawny` prints a guide matched to the installed version. A stub in `~/.claude/skills/tawny/SKILL.md` (installed from Settings, or on first run with consent) says: "Only if `TAWNY=1`. Run `tawny skills get tawny`." The guide covers:
  - Open chats with `tawny chat new`, then talk to them with `SendMessage` using the returned `sessionName`.
  - Use `notify_when_idle` instead of polling.
  - Don't message a chat the user is typing in or one that's mid-turn, unless the user asked. Only drive chats you opened.
  - Read summaries, not transcripts. The plan doc is the shared state.
  - Parallel tasks get their own worktree (`--new-worktree`). Sequential tasks share one.

Awareness without the skill:

- [ ] Append a short system prompt for Tawny-launched Claude chats via ACP `session/new` `systemPrompt` (the adapter supports append, see `client-system-prompt.js`): "You are running in a Tawny chat tab named X in worktree Y. `tawny --help` lists what you can do."

## Phase 3: plan-doc conventions (docs only)

- [ ] Write `docs/plan-template.md`: Goal, Decisions (choice, reason, rejected alternatives), Tasks (files, acceptance, how to verify, depends-on, status checkbox, notes written by the implementer).
- [ ] Standard implementer prompt, kept in the skill guide: "Read <plan>. Do task N. Follow Decisions. Verify per the task. Tick task N and add 2-3 lines of notes under it. Then message <orchestrator> a one-paragraph summary."

## Later (not now)

- `tawny chat send|read|wait` over the control socket (needed only if cross-session messaging falls short).
- UI "Start agent on task N" button on a plan doc.
- Pane commands (`tawny pane split|read|send`), `file open`, `diff open`.
- Orca-style tmux shim so terminal agent teams open Tawny terminal panes.
- MCP wrapper over the same control API, if a non-shell agent needs it.

## Open questions

- Does the adapter pass `--name` / `--settings` through, or does Tawny need a patch or upstream option?
- Codex chats: no cross-session messaging. The orchestrator can open them, but they can't message back. Is a `tawny chat done --summary` fallback needed for them?
- Should the orchestrator be a special tab (pinned, its own icon), or an ordinary chat that happens to open others?
- Where does an implementer's worktree get merged: by the implementer (per `AGENT.md` shipping rules) or by the orchestrator after review?
