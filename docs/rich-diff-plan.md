# Plan: rich markdown diff

Status: implemented 2026-11-06; automated checks pass. User manually tested the dev UI and approved landing.

## Implementation notes

- Shared Source / Rich toggle, read-only merged rendering, recursive list diffing, word marks, stacked non-prose changes, model subscriptions, F7 navigation, and formatting notice are implemented.
- Changed inline images and hard breaks preserve the old and new containing paragraphs. This keeps removed atoms visible without relying on unsupported inline marks.
- Frontmatter changes show a separate metadata notice with View Source, including when body changes are also present. Notices reserve space above the document.
- Live-update anchors exclude both directly marked blocks and blocks containing nested change marks.
- Regression checks: `node --experimental-strip-types --test test/rich-diff.test.mjs`.
- Verification passed: regression checks, `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check`. Lint has an unrelated informational finding in CodeAsk; build has an existing CSS `::highlight` optimizer warning.
- Interactive verification: user manually tested and reported that the view looks good. Agent-driven Electron verification was unavailable because computer access was denied.

Diff tabs of `.md` / `.markdown` files can show a **rich diff**: one rendered (Tiptap) document with the changes marked, instead of the Monaco diff editor. Same Source / Rich toggle as editor tabs.

## Decisions

| # | Topic | Choice |
|---|---|---|
| Q1 | What it shows | One combined rendered doc with change marks (not two panes, not just the new side) |
| Q2 | Editable | **Read-only**. "Open file" (titlebar, already exists) is the way to edit |
| Q3 | Granularity | Top-level blocks diffed; modified prose blocks (paragraph, heading, list item, blockquote, task item) also get **word-level** ins/del inside |
| Q12 | Modified non-prose blocks (code, table, mermaid, image) | Old version (faded, red edge) stacked above new (green edge). Mermaid renders both diagrams |
| Q4 | Entry | Reuse the existing Source / Rich segmented toggle (`RichToggle`) in diff tabs; default follows `settings.richMarkdown` (default rich) |
| Q7 | Toggle state | Shared per-file override with editor tabs (`richOverride` in `host.ts`), no new state |
| Q6 | Which diffs | All `.md` diffs: git diffs (HEAD / index / commits) and agent-edit text diffs (`d:t:`). Snapshot tabs (`d:o:`) render rich read-only, no marks |
| Q5 | Unchanged blocks | Full doc rendered (no folding); open scrolled to first change; `F7` / `shift+F7` next / previous change (same keys as Monaco diff) |
| Q8 | Titlebar | Hide "Side by side / Inline" while rich; Source restores it and the last choice. "Open original" / "Open file" stay |
| Q9 | Live updates | Recompute on model change (debounced ~200ms), keep scroll anchored to nearest unchanged block |
| Q10 | Render-invisible changes (whitespace, `*` vs `_`, list markers, reflow, table padding) | No marks. If the whole diff is source-only, show a slim note "Only formatting changes — view Source" |
| Q11 | Code-ask in rich diff | Not in v1 |

## Approach

Existing pieces:

- Monaco diff editor per group: `createDiff` in `src/renderer/src/components/editor/host.ts` (`diffs` map, `DiffState`).
- Rich editor bundle: `src/renderer/src/rich/entry.ts`, exposed as `window.tawnyRich.create(host, {...})`, Tiptap + `@tiptap/markdown`, mermaid node view.
- Rich toggle UI: `RichToggle` in `EditorPane.tsx`, state in `useRichUi`, override logic `wantsRich` / `setRich` in `host.ts`.
- Diff titlebar buttons: `DiffViewToggle.tsx`.

Libraries: add `diff` (jsdiff) for the sequence/word diffs (`diffArrays` with a comparator for blocks, `diffWordsWithSpace` for prose). Don't hand-roll LCS. (`prosemirror-changeset` tracks edit steps, not two arbitrary docs, so it doesn't fit.)

Steps:

1. **Diff core (pure, in the rich bundle).** New `src/renderer/src/rich/diff.ts`: parse old and new markdown with the same Tiptap schema/markdown extension into ProseMirror docs (headless). Compare top-level blocks by a normalized key (node type + attrs + text content / JSON with marks, so render-invisible source changes compare equal). Output a list of segments: `same | added | removed | modified(old, new)`. For modified prose blocks of the same type, compute word ins/del ranges. Report `formattingOnly` when markdown text differs but no segments changed.
2. **Rendering.** `window.tawnyRich.createDiff(host, { oldMarkdown, newMarkdown, onLink, keys })` → `{ update(old, new), next(), prev(), destroy }`. Build a read-only (`editable: false`) Tiptap editor whose doc is the merged block list; removed / old blocks are real nodes in this throwaway doc (it's never written back), tagged with a `diff` attr or decorations: `.rd-add`, `.rd-del`, `.rd-old`, `.rd-new`, inline `.rd-ins` / `.rd-del-word`. Mermaid node view renders both versions. Theme colors from the Catppuccin vars already in `app.css` (green / red with low-alpha backgrounds, red strikethrough for removed words).
3. **Host wiring (`host.ts`).** When a diff tab's path is richable and `wantsRich(path)`: hide the Monaco diff element, mount the rich diff into the group's `diffHost`, feed it original + modified model text, re-run `update` on model content change (debounced), scroll to first change on open, bind `F7` / `shift+F7`. `setRich` must also resync diff groups showing that path. Snapshot (`d:o:`) tabs: render via the existing read-only rich view with no marks. Clean up in the same places Monaco diff state is released.
4. **UI.** Show `RichToggle` in `DiffPane` for richable diffs (extend `useRichUi` or reuse it keyed by diff gid). `DiffViewToggle`: hide Side by side / Inline while rich. Formatting-only note as a slim bar at the top of the rich diff with a "View Source" action.
5. **Verify** in the dev instance via CDP with a sample `.md` change (git diff and an agent-edit text diff from a chat fixture): added / removed / modified paragraph with word marks, modified code block / table / mermaid stacked, formatting-only banner, toggle shared with an editor tab of the same file, live update while editing in another tab, F7 navigation. `npm run typecheck` + `npm run lint`.

## Open risks

- Tiptap markdown round-trip may normalize blocks differently between old and new (e.g. loose vs tight lists); the normalized compare key must ignore that.
- List items nested inside lists: top-level diff treats a whole list as one block. Probably need to recurse one level into lists (diff list items) so a one-item change doesn't mark the whole list. Decide during step 1.
- Scroll anchoring on live update while an agent streams edits.
