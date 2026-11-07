# Pane toolbar plan

Goal: the 24px bar under the pane bar (today `Crumbs`: path trail + symbols + copy buttons, code editor / diff tabs only) shows on every tab, with per-kind content. Rename `Crumbs` -> `PaneToolbar`.

## Content per tab kind

| Key | Kind | Trail | Actions |
|---|---|---|---|
| `f:` / `d:` | code, rich md, diff | path crumbs + LSP symbols (unchanged) | copy relative path, copy path:line |
| `f:` | image / binary | path crumbs (no symbols) | copy relative path |
| `m:` | mermaid block | path crumbs of the md file, then `Diagram N` | copy relative path |
| `p:` | PR review | `owner/repo` > `#N title` | copy PR link |
| `a:` chat | chat session | workspace > session title | copy session id |
| `a:` terminal | terminal | cwd crumbs | copy cwd |
| `n:` | launcher | no bar | |

## Layout change

Now: `.gbody` (relative) holds absolutely-positioned panes (`inset: 0`); `Crumbs` is portaled into the Monaco hosts (`.ghost` / `.gdiff`, flex column, `order: -1`), and `.rich-diff { top: 24px }` dodges it.

After:

```
.group
├─ .gbar            (tab strip)
├─ PaneToolbar      (24px, hidden for launcher / no tab)
└─ .gbody           (flex 1, relative)  <- reg.body, panes unchanged
```

`PaneToolbar` is rendered once per group by `GroupPane`, above `.gbody`, so no pane needs to know about it. The Crumbs portal into the hosts goes away, as does the `top: 24px` hack.

## Steps

1. Split `Crumbs.tsx`: shared bar shell (`PaneToolbar`: scroll trail, `>` separators, copy buttons, menu) + `EditorCrumbs` (symbol logic, needs the Monaco editor). Mount in `GroupPane` above `.gbody`; drop the portals in `EditorPane` / `DiffPane`; fix CSS (`.crumbs` -> `.pane-toolbar`, hosts, `.rich-diff`).
2. File-ish tabs without an editor: image, binary, mermaid use the path trail.
3. PR, chat, terminal content.
4. Update `docs/terminology.md` (new term), verify both themes (a11y), typecheck, lint.

## Verify

Dev instance via CDP: open one tab of each kind, screenshot, check copy toast, symbol menu, rich/diff views not overlapped, zoomed pane, latte + mocha.
