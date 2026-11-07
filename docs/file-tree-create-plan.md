# Plan: new file / new folder from the Files view

Status: scoped 2026-11-07, not started.

Create files and folders from the Files sidebar, VS Code style: header buttons + right-click, inline name input row in the tree.

## Decisions

| # | Topic | Choice |
|---|---|---|
| Q1 | Entry points | Slim header row atop Files view: root folder name (uppercase, left), icon buttons right: New File, New Folder, Collapse All. Buttons show on header hover (VS Code). Plus context menu items "New File…" / "New Folder…" on every row and on empty tree space |
| Q2 | Target folder | Track a focused row (last-clicked). Folder → inside it; file → its parent; none → root. Right-click targets the clicked row (folder → inside, file → parent) |
| Q3 | Scope | Create only. No rename / delete in this pass |
| Q4 | After create | File: open pinned, focus editor. Folder: expand it, focus it in tree |
| Q5 | Input UX | Inline row inserted as first child of target folder (target auto-expands), file/folder icon + `@/ui/input`. Enter commits, Escape or blur-with-empty cancels, blur-with-text commits (VS Code) |
| Q6 | Nested paths | `a/b/c.ts` creates intermediate dirs; New Folder with `a/b` creates both. Expand created ancestors |
| Q7 | Validation | Inline error under the input (red border + message), commit blocked: empty / whitespace-only, leading or trailing slash, `..` or `.` segments, name already exists (checked against listing + main-side `wx` flag). Absolute paths rejected |
| Q8 | Refresh | After create, force `listDir` of affected dirs immediately (don't wait for watcher's 150ms debounce); watcher still handles git status |

## Approach

Existing pieces:

- Files view: `FilesView` in `src/renderer/src/components/tree/TreePane.tsx` (flat `rows` from `dirs` + `expanded`, rows are `.tn`, context menu via `components/ContextMenu.tsx`).
- Tree state: `src/renderer/src/components/tree/store.ts` (`useTree`, `listDir`, `toggleDir`, `revealInTree`, `H.onFsChanged`).
- Main fs: `src/main/files.ts` (`list`, `write`), IPC registered in `src/main/main.ts` (`h('fs:write', …)`), preload `src/preload/index.ts`, typed API `src/shared/tawny-api.ts`.
- Opening: `openFile(path, { pin: true })` from `components/editor/api`.
- Styles: `src/renderer/src/styles/app.css` (`#tree`, `.tn`).

No library needed: tree is custom, create is `fs.mkdir({recursive})` + `fs.writeFile(…, {flag: 'wx'})`.

## Tickets

### T1 main: create IPC

- `files.ts`: `create(file: string, kind: 'file' | 'dir')`. Dir: `mkdir(recursive)`, error if it already exists as anything. File: `mkdir(dirname, recursive)` then `writeFile('', {flag: 'wx'})` (EEXIST → "A file or folder named X already exists").
- Register `fs:create` in `main.ts`, expose `create` in preload + `tawny-api.ts`.

### T2 store: focus + pending-create state

- `useTree`: `focused: string | null` (set on row click; cleared on root change), `creating: { dir: string; kind: 'file' | 'dir' } | null`.
- `startCreate(kind, fromPath?)`: resolve target per Q2, expand target (await `listDir`), set `creating`.
- `commitCreate(name)`: validate (Q7), `H.create`, force `listDir` on each new/changed dir, expand created ancestors, then Q4 (open pinned / expand + focus + reveal). Errors → keep input open with message; unexpected → `toast`.
- `cancelCreate()`, `collapseAll()` (clear `expanded[root]`, persist like `toggleDir`).

### T3 UI: header + input row + menu items

- Header row above the `ScrollArea` in `FilesView`: root basename, `Button` (ghost, icon size, from `@/ui/button`) ×3 with `@/ui/tooltip` titles. Hidden until header hover / focus-within.
- Focused row styling (`.tn.focus`, subtle outline distinct from `.on` active file).
- Input row rendered in `rows` walk at top of `creating.dir`'s children (or top-level if root), depth-indented, `@/ui/input` compact, autofocus, inline error text.
- Context menu: prepend "New File…", "New Folder…" to row menu; wrap empty tree area in a `ContextMenu` targeting root.

### T4 verify

- Dev instance via CDP: create file at root, inside folder (right-click + toolbar after clicking folder / file), nested `a/b/c.ts`, new folder, duplicate name error, Escape cancel, blur behaviour, collapse all. Check new file opens pinned with editor focus and git shows `U`.
- Clean up created test files. `npm run typecheck`, `npm run lint`.

## Out of scope

Rename, delete/trash, drag-move, copy/paste, multi-select in Files view, keyboard navigation of tree rows.
