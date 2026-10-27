# UI layer

shadcn/ui is source copied into the repo, not a dependency. Edit it directly; there is no adapter or contract layer.

## Structure

```
src/renderer/src/components/
  ui/            # shadcn components (`npx shadcn add <name>`), edited in place for app variants
  *.tsx, chat/   # app compositions built on ui/ (ToolCard, Tool, PromptInput, MessageScroller, DropdownMenu, ContextMenu, Indicator, Toasts...)
```

- `components.json` aliases point at `@/components` / `@/components/ui`; `shadcn add` writes straight into `ui/`.
- Import primitives by path (`@/components/ui/button` or relative). No barrel.
- App-specific pieces (`trace`, `code-block`, `chain-of-thought`, tool-call wrappers) are app components, even where the source came from a registry.
- `components/ui/*.tsx` is excluded from Biome (generated style); app compositions are linted.
- Variant names are shadcn's (`default`, `secondary`, `ghost`, `destructive`; sizes `sm`, `icon`...). Note shadcn's `Button` defaults to `default` (primary), not secondary.

## Setup notes

- Tailwind v4 without preflight (`styles/tailwind.css`: `theme` + `utilities`). `legacy.css` is imported from it into a `legacy` cascade layer below `utilities`; unlayered, its button resets would beat every utility.
- Theme colors map straight to the app's tokens in `@theme inline`. shadcn's `--accent`/`--muted`/`--input` names clash with the app's, so no shadcn `:root` vars.
- `@` alias → `src/renderer/src`. TS 7 has no `baseUrl`: `paths` uses `./` prefixes.

## Gotchas

- Radix collapsibles are controlled: `ctl.setOpen` must be followed by `ctl.emit()` (native `<details>` hid this). Closed content is unmounted.
- Sonner's generated `group` class collides with legacy `.group` (`overflow:hidden`); `Toasts` drops it and maps sonner vars to `--panel`/`--text`/`--line-2`.
- cmdk overwrites the input `id`, so the palette uses a ref, not `#paletteInput`. `ui/command.tsx` defaults `shouldFilter` to false (the app filters itself).
- Radix `ScrollArea` wraps content in a `display:table` div, which breaks ellipsis; `ui/scroll-area.tsx` forces block.
- `TopDialogContent` (`Overlay.tsx`) is the shared near-top, unpadded dialog shell for palettes and overlays.

## Left to do

- Port the legacy tab/split layout (`legacy/layout.ts`, `legacy-markup.html`: tab bars, split tree, page chips) to React, then use `tabs` and `resizable`. `ui/tabs.tsx` is unused.
- Debug panel top grip still resizes against the legacy `#panes` workspace.
- Legacy context menu (`showContextMenu` / `#ctxMenu`) and `H.addMenu()` should become `ContextMenu`/`DropdownMenu` once their callers are React.
- `FindView`: hand-built inputs and results list.
- Palette mode tabs and the Aa/ab/.* toggles: `tabs`, `toggle`.
- Debug config `<select>` and breakpoint prompt `<input>`: `select`, `input`, `dialog`.
- `kbd` unused; shortcut hints hand-built. Custom icons in `icons.tsx` / `Chevron`.
- Unverified: file-tree/commit/rename context menus, Escape-to-close, retry/auth banner buttons, "Open diff", palette/quick-switcher picks, repo `Select`, status-bar tooltips, keyboard/scroll behavior in new menus; theme (mocha/latte) pass.
