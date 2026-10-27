# Legacy workspace migration

Scope for moving `src/renderer/src/legacy/{layout,editor}.ts` (3835 lines) to React. Line numbers are from commit `780576f`.

## Current state

- Everything else in the renderer is React: sidebar, tree, chat, palette, status bar, toasts, dialogs, debug UI.
- The legacy pair is TS (lint-clean) but still imperative DOM: `innerHTML` (12), `addEventListener` (42), `createElement`/`querySelector` (55).
- Boot (`App.tsx`): `loadScripts(['monaco/vs/loader.js', 'fileicons/map.js'])` → `import('./legacy/layout')` → `import('./legacy/editor')` → `startBridge()` (`bridge.ts`) calls `harborLayout.init(ui)`, `harborEditor.init(state)`, then `setLegacyReady()`, which mounts `TreePane` and `DebugPanel`.
- `<LegacyWorkspace>` injects `legacy-markup.html` via `dangerouslySetInnerHTML` (React must not touch it). Mount points: `#layoutRoot`, `#dbgHost`, `#edStatus`, `#pageBar`. `#ctxMenu` and `#termHold` live in `App.tsx`.
- Wiring is through window globals: `harborLayout`, `harborEditor` (typed in `lib/legacy.ts`), plus `harborApp` (implemented in `bridge.ts`, called by legacy), `harborDebug`, `harborChat`, `harborTree`. `Layout()` / `Editor()` accessors wrap them.
- `layout.ts` and `editor.ts` call each other (`Lay()`, `E()`), so they must move together.

## Anatomy

### `layout.ts` (1703 lines)

Model: per worktree root, `Workspace { pages[], at }`; page = tree of `Split { dir, sizes, children }` / `Leaf { id, tabs[], active, preview }`. Tab keys: `a:<session>` agent, `f:<path>` file, `n:<id>` launcher, `d:s|w|c:…` diff.

| Lines | Section | Notes |
|---|---|---|
| 97–228 | tree ops (`parentOf`, `prune`, `normalize`, `splitGroup`, …) | pure; first thing to extract |
| 229–302 | persistence (`H.saveUi`, `revive`) | pure + IPC |
| 303–340 | sessions ↔ agent tabs (`reconcile`, `sync`) | store logic |
| 341–751 | rendering (`groupEl`, `renderGroup`, `buildNode`, `splitter`, `mount`, `gc`) | imperative DOM; per-group host nodes for Monaco, diff, image, binary, launcher |
| 752–895 | pages (page bar, rename, new, close) | |
| 896–1151 | actions (`closeKey`, `openKey`, `revealAgent`, `toggleZoom`, `pickPane` overlay, …) | |
| 1152–1703 | tab DnD (`dropAt`, `beginDrag`, `beginGroupDrag`, `moveTab`), launcher (`newTab`, `renderLaunch`, chat history, markdown naming), `cycleTab`, `moveActive` | uses `lib/dnd.tsx` `track`; launcher is ~270 lines |

Group body mounts one of: Monaco editor, diff editor, rich editor, image, binary placeholder, launcher, or an agent view (`APP().termEl(id)`, an xterm or chat element owned elsewhere and re-parented).

### `editor.ts` (2132 lines)

| Lines | Section | DOM? |
|---|---|---|
| 1–247 | types, helpers, LSP pos/range converters | no |
| 248–391 | models (`ensureModel`, `openLsp`, `save`, `reloadFromDisk`, dirty tracking) | no |
| 392–444 | open/show file | yes (group host) |
| 445–672 | rich markdown toggle (`syncRich`, uses `rich/entry.ts`), `preload`, `closeTab`, `tabInfo`, `saveView`, `focusGroup`, `disposeGroup` | yes |
| 673–930 | diff tabs (`createDiff`, `showDiff`, `refreshDiffs`, `openTextDiff`) | yes |
| 931–954 | nav history | no |
| 955–1043 | diagnostics, workspace edits | no |
| 1044–1345 | LSP → Monaco providers (`registerProviders`) | no |
| 1346–1446 | tree shims, ⌘P fuzzy + file index (`fileMatches`, `fileRowHtml`) | `fileRowHtml` returns HTML string |
| 1447–1543 | status bar (`renderStatus`), `showContextMenu`, toast | yes |
| 1544–1975 | `createEditor`, `mountCrumbs` (breadcrumbs, 1677), `codeAsk` (1853), Monaco theme/TS setup | yes |
| 1975–2132 | `init`, selection → agent, `setRoot`, `harborEditor` export | |

About 1300 lines (models, history, diagnostics, edits, providers, fuzzy) have no DOM.

## External coupling

Call sites outside `legacy/`, by `harborEditor` method (count): `openFile` 10, `fileRowHtml` 3, `openQuickOpen` 4, `saveView` 4, `openDiff` 2, `diffInfo` 2, `tabInfo` 2, `layoutGroup` 2, `groupFocused` 2, `fileIndexLoaded` 2, `absPath` 2, `forgetRoot` 2, `openFileResult` 2, `showContextMenu` 2, `toggleRich` 2, `save` 2, `selectedText` 2; the rest are 1 each (`init`, `setRoot`, `setLspStatus`, `invalidateIndex`, `refreshDiffs`, `modelText`, `applyModelEdits`, `dirtyText`, `fileMatches`, `openTextDiff`, `closeTab`, `closeDiff`, `dropDiff`, `dropPath`, `disposeGroup`, `focusGroup`, `show`, `showDiff`) plus the getters `root` and `editor`. (Some of the 1-count ones are only called by `layout.ts` through `E()`.)

`harborLayout` externals: `activeFile` 8, `moveActive` 9 (menu + commands), `currentAgent` 6, `revealAgent` 6, `focusedGroup` 4, `splitFocused` 4, `activeKey` 3, `agentLabel` 3, `focusGroup` 3, `cyclePage` 2, `cycleTab` 2, `renderTabs` 2, the rest 1 each (`init`, `setRoot`, `sync`, `forgetRoot`, `newTab`, `newPage`, `newMarkdown`, `openFile`, `openDiff`, `openKey`, `removeKey`, `removeFile`, `hasFile`, `hasKey`, `closeActive`, `closePage`, `renamePage`, `setPage`, `pages`, `pickPane`, `toggleZoom`, `focusEditor`, `dragFile`). Never used externally (delete, don't port): `diffKeys`, `filesOf`, `expectAgent`, `visibleAgents` (check `visibleAgents` in legacy first), `colorizeLines`, `dirtyCount`, `focus`, `loadFileIndex`, `preload`, `renderTabs` and `revealInTree` on the editor.

Consumers:

- `bridge.ts`: menu dispatch (~15 layout/editor calls), `init`.
- `lib/commands.ts`, `lib/actions.ts`, `lib/terminals.ts` (direct `window.harborEditor.openFile` for `path:line:col` links).
- `components/Palette.tsx`: file index, `fileRowHtml` (HTML string, will need a component), `openFileResult`.
- `components/tree/{TreePane,find,store}.ts*`: open file/diff, `modelText`/`applyModelEdits` (find/replace on open models), `refreshDiffs`, `invalidateIndex`.
- `components/debug/{session,breakpoints}.ts`: reach into `harborEditor.editor` (the live Monaco instance) and `harborEditor.root`; `window.monaco` directly for decorations, hover provider, gutter mouse events. Legacy calls back via `harborDebug.{init,attach,saved,modelCreated}`.
- `harborApp` (legacy → React): `toast`, `openPalette`, `toggleSidebar`, `sendTargets`, `askAgent`, `composeToAgent`, `newAgent`, `agentInfo`, `termEl`, `fitAll`, `focusTerm`, `stopAgent`, `renameAgent`, `markSidebar`, `settings`.

## Risks

1. **Monaco lifetime.** Editors, models, view states and diff editors are cached per group and per path, and survive tab switches. React components must host them (ref + effect), not recreate them. Per-group `tok` / `pending` / `mounted` guards in `GroupEl` encode async race fixes that need to be preserved.
2. **Re-parented agent views.** `termEl(id)` returns an xterm / chat element created outside React; the pane must adopt it (and `fitAll` after splitter drags).
3. **`window.monaco` via AMD loader** (`monaco/vs/loader.js`). Keeping the loader means keeping a global; switching to bundled `monaco-editor` (already a dependency) is a separate decision with Vite worker setup (`MonacoEnvironment`, line ~1978). Don't mix it into this migration.
4. **Debug panel** depends on the live editor instance and `#panes` geometry (see `ui-layer.md`).
5. **Persistence format** (`H.saveUi({ pages })`, `revive`) must stay compatible with saved user layouts.
6. **Splitter / DnD** is hand-rolled (`track`); `ui/resizable` is an option but changes drag semantics (min px, edge-drop zones at 25%).
7. **Unmeasured:** behavior under HMR (the `__legacyStarted` guard exists because StrictMode/HMR re-run the boot).

## Plan

Each step ships independently; the app works after each.

1. **Extract the pure parts** (no UI change): LSP providers, diagnostics, workspace edits, models, history, fuzzy/file index → `lib/editor/*` or `lsp/*` (~1300 lines). `editor.ts` imports them.
2. **Layout store** (zustand): tree ops, pages, persistence, session reconcile, tab/zoom/focus actions (~600 lines from `layout.ts`). Legacy renderer reads from it; `harborLayout` becomes a thin facade. Unit-test tree ops.
3. **React shell**: `<Workspace>` replaces `legacy-markup.html`; page bar, pane tree, splitters, tab bars (`ui/tabs`, optional `ui/resizable`), tab DnD, launcher, `pickPane`. Panes host a `<div ref>` that the (still imperative) editor module mounts into.
4. **Monaco host**: `<EditorPane>` / `<DiffPane>` own create/dispose, model swap, view-state save/restore, rich toggle, binary/image placeholders. Move `createEditor`, `createDiff`, `show*` in. Breadcrumbs, `codeAsk` become components.
5. **Editor-adjacent UI**: status bar (`renderStatus`, `#edStatus`) → `StatusBar`; `showContextMenu` → `ContextMenu`; `fileRowHtml` → component used by `Palette`.
6. **Remove the shims**: replace `Layout()` / `Editor()` / `window.harbor*` / `harborApp` with imports of the store and module functions; update the ~140 call sites (`bridge.ts`, `commands.ts`, `actions.ts`, `terminals.ts`, `Palette`, tree, debug); drop `legacy-markup.html`, `LegacyWorkspace`, `setLegacyReady`, and the `__legacyStarted` guard; keep `harborDebug` access via a typed module.
7. **Cleanup**: delete `legacy.css` rules no longer used; update `ui-layer.md` "Left to do" and the stale `src/renderer/public/legacy` line in `CLAUDE.md` (the dir no longer exists; only `public/fileicons` remains).

## Estimate

Roughly 1.5–2.5 weeks of focused work. Step 4 carries most of the risk and ~1/3 of the time. Step 6 is wide but mechanical. Steps 1 and 2 are low-risk and can start now.

## Open questions

- Keep the AMD Monaco loader or move to bundled Monaco (risk 3)?
- Use `ui/resizable` or keep custom splitters (risk 6)?
- Should debug breakpoints/hover move onto a `useEditor()` hook or a small `editorApi` module instead of `harborEditor.editor`?

## Progress

Working protocol: branch `legacy-migration`; one commit per slice (`legacy(step N): …`); verify each slice with `npm run typecheck` + `npx biome check <changed>`; a session reads this section first, takes the next unchecked slice, and ticks it in the same commit as the code. Line numbers above are from `780576f` — treat as a map, not gospel.

- [x] **1a.** Extract LSP → Monaco providers, diagnostics, workspace edits → `src/renderer/src/lsp/*`
- [x] **1b.** Extract models (`ensureModel`, `openLsp`, `save`, dirty tracking, `reloadFromDisk`) → `lib/editor/models.ts`
- [x] **1c.** Extract nav history + ⌘P fuzzy / file index (keep `fileRowHtml` HTML-string seam for now) → `lib/editor/history.ts`, `lib/editor/fileIndex.ts`
- [x] **2.** Layout zustand store (tree ops, pages, persistence, reconcile, tab/zoom/focus actions); legacy renderer reads it; `harborLayout` becomes facade; unit-test tree ops
- [x] **3.** React `<Workspace>` shell: page bar, pane tree, splitters, tab bars, tab DnD, launcher, `pickPane`; panes host `<div ref>` for editor module
- [x] **4.** `<EditorPane>` / `<DiffPane>` Monaco hosts (create/dispose, model swap, view-state, rich toggle, placeholders); breadcrumbs + `codeAsk` as components
- [ ] **5.** Status bar, context menu, `fileRowHtml` → components
- [ ] **6.** Remove shims (`Layout()`/`Editor()`/`harborApp`); update ~140 call sites; drop `legacy-markup.html`, `LegacyWorkspace`, `setLegacyReady`, `__legacyStarted`; typed `harborDebug` module
- [ ] **7.** Cleanup: dead `legacy.css` rules, `ui-layer.md` "Left to do", stale CLAUDE.md line

**Position:** next slice = 5. Done: 1a+1b as `src/renderer/src/lsp/{protocol,models,providers}.ts` — protocol is pure (wire↔Monaco converters, `languageFor`, `editsByFile`, `parseDiff`); models owns `models`/`knownRoots`/`root` state + LSP sessions + diagnostics + fs-change reload, with editor UI effects injected via `configureModels({ renderStatus, syncRichFromModel, editorsShowing })`; providers takes `{ openFile, pushHistory }` deps from `init`. 1c as `src/renderer/src/lib/editor/{history,fileIndex}.ts` — history owns `history`/`historyPos` + `pushHistory`/`goHistory`; fileIndex owns `indexByRoot`, `fuzzy`, `fileMatches`, `fileRowHtml` (HTML-string seam until step 5), `rel`/`absPath`, quick-open and index loading (`warmIndex`/`invalidateIndex` also serve `setRoot`/`forgetRoot`). Both get editor-layer effects (`openFile`, palette, live editor, layout recent-files) via `configureHistory`/`configureFileIndex` wired at boot; `FileMatch` is re-exported from `editor.ts` so `layout.ts` is untouched. `editor.ts` is now ~1395 lines (was 2170).
Done: step 2 as `src/renderer/src/legacy/layoutStore.ts` — zustand store (`useLayoutStore`: `workspaces`, `root`, `legacy`, `expectGroup/expectReplace`, `rev`) with tree ops exported as pure functions (no test runner in this project, so tree-op unit tests are deferred to a later slice — the ops are exported ready for them); persistence (`initFromUi`/`revive`/`persist`) keeps the exact saved shape; `layout.ts` (~1160 lines, was 1790) is renderer-only plus a thin `harborLayout` facade, and wires its DOM effects into the store via `configureLayoutStore({ renderRoot, renderPageBar, afterActivate, focusGroup, pendingMount, groupRect, gc })`.
Done: step 3 as `src/renderer/src/components/workspace/{Workspace,Launcher}.tsx` + `panes.ts` — `<Workspace>` renders `#layoutRoot` (pane tree, splitters, tab bars with inline rename, DnD via `track`), `#pageBar` (chips, HTML5 reorder, color menu, inline rename via `useUiTick.renamePageAt`), and the `#dbgHost`/`#edStatus` mount points; `legacy-markup.html` is gone. `panes.ts` keeps the per-group persistent hosts (`regFor`: `.ghost`/`.gdiff`/`.gimage`/`.gbinary`, tok/pending/mounted guards) that `GroupPane` adopts in a layout effect before calling `syncShown`; it also owns pickPane, DnD, launcher state and the store's fx wiring (`renderRoot` bumps `useUiTick`). `layout.ts` is now only the `harborLayout` facade. Launcher rows are still HTML strings (`fileRowHtml` seam, step 5); `.lopt`/`.qi` have no CSS (pre-existing). Verified on dev instance: launcher, split, zoom, splitter drag, pages, tab DnD, Monaco + chat re-parenting.
Done: step 4 as `src/renderer/src/components/editor/{host.ts,EditorPane.tsx,Crumbs.tsx,CodeAsk.tsx}` — `host.ts` owns the Monaco state moved out of `editor.ts` (`editors`/`diffs`/`richViews`, `createEditor`/`createDiff`, `show`/`showDiff`, rich toggle + Tiptap sync, view-state save/restore, focus/dispose, `refreshDiffs`, `selectionRef`/`sendSelectionToAgent`) and still creates editors lazily into the persistent per-group `reg.host`/`reg.diffHost` (lifetime = group id via gc → `disposeGroup`, tok guards unchanged); editor-layer effects come back through `configureHost({ whenReady, openFile, renderStatus, toast, markTreeActive, showContextMenu })`. `<EditorPane>`/`<DiffPane>` (rendered by `GroupPane`) adopt those hosts, own their `hidden` + relayout, and render image/binary placeholders as plain React from `useGroupView` (driven by `panes.ts` `syncShown`/`mount`; `reg.image`/`reg.binary` are gone). `<Crumbs>`, `<RichToggle>` and `<CodeAsk>` portal into the host / the per-editor view-zone node (`askZones`), state in zustand stores (`useEditorReady`, `useRichUi`, `useAsk`). `editor.ts` is now ~590 lines. Verified on dev instance (:9333): markdown rich/source toggle, view-state restore across tab switches, breadcrumbs, text diff, image + binary placeholders, CodeAsk open/Escape.
