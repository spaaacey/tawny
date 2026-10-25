# Terminology

Names for the parts of the Harbor window. Use these in UI text, docs, code and conversation.

```
repo
└─ workspace   a git worktree; one row in the primary sidebar
   └─ pane     a split region of the workspace, with its own pane bar
      └─ tab   one agent, terminal, file or diff
```

## Window layout

![Window layout](img/layout-overview.png)

| Term | What it is |
|---|---|
| **Primary sidebar** | Left. Toggle `cmd+b`. Lists repos and their workspaces. |
| **Repo** | Heading in the primary sidebar. Groups workspaces; not selectable. |
| **Workspace** | A git worktree. One row under a repo; click to switch. Shows agent state and the `option+cmd+<n>` shortcut. |
| **Workspace view** | The middle area: the active workspace's panes. Not a separate concept, just where the active workspace renders. |
| **Secondary sidebar** | Right. Toggle `cmd+option+b`. Two views: **Files** (file tree) and **Source** (changes, commit box, Commits). |

## Panes and tabs

![Panes and tabs](img/panes-and-tabs.png)

| Term | What it is |
|---|---|
| **Pane** | A split region of the workspace view. Holds many tabs, shows one at a time. Created by dragging a tab to a pane's edge, or by moving the active tab to a neighbouring pane. |
| **Pane bar** | A pane's tab strip, with the `+` button for a new agent or terminal. |
| **Tab** | One item in exactly one pane: an agent, terminal, file or diff. Drag between panes or reorder in the bar. |

## Rules

- "Workspace" always means a worktree. Never use it for the middle area or the sidebar as a whole.
- A tab is never split. Panes are split; tabs live inside them.
- Say "agent tab", not "agent pane".

## Names in code that don't match yet

| Now | Should be |
|---|---|
| `group`, `gbar`, `gtab` in `src/renderer/layout.js` | `pane`, `pane bar`, `tab` |
| `#workspace` in `src/renderer/index.html` (middle area) | `#workspaceView` |
| `#treePane` | `#secondarySidebar` |
| `#sidebar` | `#primarySidebar` |
| README: "Agent pane per worktree" | "agent tab" |

The screenshots are from the dev instance, annotated by overlaying outlines on the live DOM.
