# Migrating app components to `components/ui`

Goal: files under `src/renderer/src/components/**` (outside `ui/`) compose shadcn components from `components/ui` instead of raw `<button>`/`<input>`/`<kbd>`/`<label>`/`<a>` styled by custom CSS in `styles/app.css`.

## Rules

1. Check `components/ui` first. If missing, add it with the shadcn CLI: `npx shadcn@latest add <name>` (pipe `yes n |` so it never overwrites existing files). Never hand-roll a primitive that shadcn ships.
2. Import from the specific file (`./ui/button`, `../ui/kbd`), not the barrel. The barrel `ui/index.ts` is regenerated once at the end; don't edit it.
3. Keep behavior identical: handlers, ids that other code or tests query (`#commitBtn`, `#fdQuery`, ...), keyboard shortcuts, focus handling. If an id/class is queried from outside the file (grep first), keep it.
4. Don't edit `styles/app.css`. List CSS classes that became unused in your report; they're removed in a final pass.
5. Pass layout/spacing tweaks via `className` on the ui component. Don't fork the ui component to fit one caller.
6. Leave Monaco, portal-host and pane/layout DOM internals alone unless a ui component is a clean fit. Report skipped spots and why.
7. Do not commit, merge, or start a dev instance. Run `npm run typecheck` and `npx biome check --write <your files>` before reporting. (`npm run lint` has one known pre-existing error in `editor/CodeAsk.tsx` — `noUselessFragments`; ignore unless you're the editor task.)

## Mapping

| Raw | Use |
|---|---|
| `<button className="icon-btn">` | `Button variant="ghost" size="icon-xs"` (or `icon-sm`) |
| `<button className="primary-btn">` | `Button` |
| `<button className="link-btn">` | `Button variant="link"` |
| `mode-btn`, `sbtn`, `ask-*` buttons | `Button variant="ghost"`/`outline`, `size="xs"`/`sm` |
| `<kbd>` | `Kbd` / `KbdGroup` |
| `<input>` | `Input` (or `InputGroup` + `InputGroupInput` with addons) |
| `<label>` | `Label` (or `Field` + `FieldLabel`) |
| two-state toggle buttons | `Tabs` or `ToggleGroup` (add `toggle-group`) |
| bordered panel | `Card` |
| list row with title/description/actions | `Item` |
| form row | `Field`, `FieldGroup` |
| button cluster | `ButtonGroup` |
| right-click menu | `ContextMenu` via `components/ContextMenu.tsx` wrapper |
| `<a href="#">` that runs a handler | `Button variant="link"` |

## Tasks (disjoint files, run in parallel)

| # | Files | Notes |
|---|---|---|
| 1 | `Sidebar.tsx`, `StatusBar.tsx`, `AttentionChips.tsx` | icon/primary/link buttons, att-chip -> Badge or Button |
| 2 | `chat/Composer.tsx`, `chat/ChatView.tsx`, `chat/QuestionCard.tsx`, `chat/ToolCard.tsx` | mode-btn -> Button/Select, `<kbd>` -> Kbd, `<a>` -> link Button |
| 3 | `tree/FindView.tsx`, `tree/TreePane.tsx`, `tree/AsksView.tsx` | Input/Label/Button; keep `role="tree"` results list; keep element ids |
| 4 | `editor/EditorPane.tsx`, `editor/EditorStatus.tsx`, `editor/CodeAsk.tsx`, `editor/ContextMenu.tsx`, `editor/Crumbs.tsx`, `editor/FileRow.tsx` | buttons, Kbd, toggle -> Tabs/ToggleGroup; `editor/ContextMenu.tsx` is a Monaco-driven imperative menu: use ui `context-menu`/`dropdown-menu` only if it fits, else report |
| 5 | `debug/DebugPanel.tsx`, `Palette.tsx`, `DiffViewToggle.tsx`, `Chevron.tsx`, `workspace/Launcher.tsx`, `workspace/Workspace.tsx` | `<input>`, `<kbd>`, titlebar buttons, Chevron -> lucide icon; Workspace pane DOM stays unless clean fit |

## Final pass (coordinator)

1. Regenerate `ui/index.ts` barrel.
2. Remove unused CSS classes from `styles/app.css`.
3. `npm run typecheck`, `npm run lint`, then verify in the dev instance (screenshot each touched surface), close it, commit.

## Report format (per task)

Files changed; new shadcn components added; CSS classes now unused; spots skipped and why; typecheck/biome result.
