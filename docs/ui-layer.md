# UI layer (design-system abstraction)

Status: implemented (shadcn adapter). Migrated: alert-dialog, dialog, command, input, label, checkbox, select, sonner, badge, spinner, tooltip, context-menu, dropdown-menu, scroll-area, textarea, collapsible, resizable, button. Not migrated: `tabs`, pane `resizable` splits, tab bars and page chips (imperative DOM in `legacy/layout.ts`; port to React first), Palette mode tabs, `FindView`, `kbd`, icons.

Goal: use shadcn/ui components wherever one exists (no hand-built equivalents), while keeping the design system swappable.

## Rule

App code never imports shadcn, Radix, `lucide-react` or `sonner` directly. It imports from the app-owned UI layer:

```ts
import { Button, Dialog } from '@/ui';
```

shadcn is the first implementation behind that layer.

## Structure

```
src/renderer/src/ui/
  contract.ts        # app-owned prop types per component (Button, Dialog, Command, Tabs...)
  index.ts           # export * from './adapters/shadcn'   <- the single swap point
  adapters/
    shadcn/          # components added by `shadcn add` (generated, untouched)
                     # + thin index.ts re-exporting them under contract names
    <other>/         # future: same exports, different library
  tokens.css         # semantic tokens
```

Swapping design system = change one line in `ui/index.ts` (or a Vite alias), plus a visual/a11y pass.

## What keeps the swap safe

1. **Contract types.** `contract.ts` defines each component's props: semantic variants (`primary|secondary|ghost|danger`), sizes, `open`/`onOpenChange`. Every adapter `satisfies` the contract, so `npm run typecheck` fails if an adapter is incomplete or a call site uses something the contract doesn't allow.
2. **No library details in the contract.** No shadcn-specific variants, no `asChild`, no free `className` passthrough (at most a restricted layout-only one).
3. **Lint enforcement.** Biome `noRestrictedImports` bans `@/components/ui/*`, `@radix-ui/*`, `lucide-react`, `sonner` outside `ui/adapters/**`.
4. **Icons behind the layer.** `<Icon name="close" />`, mapped per adapter. No direct icon-library imports.
5. **Semantic tokens.** App CSS uses only tokens (`--color-surface`, `--color-accent`, `--radius-control`). Each adapter maps its library's variables (shadcn's `--background`, `--primary`, ...) to these tokens.

## Contract style

Mirror shadcn's compound shape (`Dialog > DialogHeader > DialogTitle`), since it is the de facto standard and Radix-style libraries (Base UI, Ark) swap in easily. Be strict about variants, props and icons. Add flat helpers (e.g. `ConfirmDialog`) only where the app needs them.

## Limits

- The thin adapter + contract layer is the one hand-written piece; plug-and-play isn't possible without it.
- Non-Radix-style libraries (MUI, Mantine) need a real adapter mapping the contract onto their props.
- Behavior (focus, animation, keyboard nav) differs per library; the contract fixes types, not behavior.
- Tailwind utilities in app layout code couple the app to Tailwind (not to shadcn). To stay Tailwind-free, keep layout in CSS or in layout primitives (`Stack`, `Row`) exported from `ui/`.

## Setup (shadcn adapter)

1. `npm i -D tailwindcss @tailwindcss/vite`; add `tailwindcss()` to `renderer.plugins` in `electron.vite.config.ts`.
2. Add `styles/tailwind.css` (`@import "tailwindcss";`, or only `theme` + `utilities` to skip preflight, which would restyle `legacy.css`). Import it in `main.tsx`.
3. Alias `@` → `src/renderer/src` in `electron.vite.config.ts` and `tsconfig.json` (`baseUrl`, `paths`).
4. `npx shadcn@latest init`, with `components.json` pointing at `tailwind.css`, `aliases.components` = `@/ui/adapters/shadcn`, `aliases.utils` = `@/lib/utils`.
5. `npx shadcn@latest add <component>`; re-export from the adapter's `index.ts` under contract names.
6. Add `ui/adapters` to the Biome ignore list (generated code).

## Migration candidates

| Existing | shadcn |
|---|---|
| `ConfirmDialog` | alert-dialog |
| `Overlay`, `NewWorktreeModal` | dialog |
| `Palette`, `QuickSwitcher` | command |
| `Toasts` | sonner |
| `Indicator` | badge, spinner |
| `Sidebar` / tree actions | context-menu, dropdown-menu |
| pane splits | resizable |
| tab bars | tabs, scroll-area |
| shortcut hints | kbd, tooltip |

## Migration log

Done on branch `chat-adjustments`. Foundation: Tailwind v4 (no preflight), `@` alias, `components.json`, `ui/` layer, Biome `noRestrictedImports`. `legacy.css` is imported from `styles/tailwind.css` into a `legacy` cascade layer below `utilities`; unlayered, its button resets beat every Tailwind utility. Theme colors map straight to the app's tokens in `@theme inline` (shadcn's `--accent`/`--muted`/`--input` names clash with the app's, so no shadcn `:root` vars). TS 7 has no `baseUrl`: `paths` uses `./` prefixes.

| Area | Now |
|---|---|
| `ConfirmDialog` | alert-dialog |
| `Palette`, `QuickSwitcher`, `NewWorktreeModal`, `SendBox` (via `Overlay` `Backdrop`) | dialog, command, input, label, checkbox, select |
| `Toasts` (`pushToast` drives sonner), `Indicator`, `StatusBar` | sonner, badge, spinner, tooltip (`UIProvider` in `App.tsx`) |
| `Sidebar`, `TreePane` rows and menus, `#repos`/`#tree` lists | context-menu, scroll-area |
| Chat (`ChatView`, `ToolCard`, `Composer`, `SendBox`) | collapsible, textarea, button |
| Composer box (`PromptInput*`: attachments, textarea, footer with pickers, send/stop) | input-group, attachment |
| Composer mode/model pickers | dropdown-menu (radio items, "More models"/"Effort" submenus) |
| `DebugPanel` | resizable, button |

Notes:
- Radix collapsibles are controlled: `ctl.setOpen` must be followed by `ctl.emit()` (native `<details>` hid this).
- Closed collapsible content is unmounted.
- Sonner's generated `group` class collided with legacy `.group` (`overflow:hidden`); the impl drops it. Sonner is mapped to `--panel`/`--text`/`--line-2`.
- cmdk overwrites the input `id`, so the palette uses a ref, not `#paletteInput`.
- `Overlay.tsx` is a thin `Backdrop` over Dialog (used by `SendBox`).
- Unused legacy CSS removed for the migrated parts (`.modal*`, `.quick*`, `.toast*`, picker/menu rules, `.dbg-b*`, etc.).

## Left to do

- **Port the legacy tab/split layout to React** (`legacy/layout.ts`, `legacy-markup.html`): per-group tab bars (drag between groups, reorder, edge-drop split), split-pane tree and dividers, page chips. Then use `tabs` and `resizable`. Largest remaining item; the `tabs` adapter is untouched.
- **Debug panel top grip** still resizes against the legacy `#panes` workspace.
- **Legacy context menu** (`showContextMenu` / `#ctxMenu`, used by `layout.ts`, `editor.ts`) and `H.addMenu()` (add-workspace menu in `lib/legacy`) should become `ContextMenu`/`DropdownMenu` once their callers are React.
- `FindView`: inputs and results list still hand-built (`input` exists; results use `scrollIntoView`/keyboard focus that Radix's `ScrollArea` could disturb).
- Palette mode tabs (Files/Commands/Text/Symbols) and the Aa/ab/.* toggles: `tabs` and `toggle` (not yet added).
- Debug config `<select>` and breakpoint prompt `<input>`: `select`, `input`, `dialog`.
- `kbd` is unused; shortcut hints (`SendBox`, palette) are hand-built.
- Icons: custom SVGs in `icons.tsx`/`Chevron` have no facade; add `<Icon name>` in the contract if the icon library should be swappable.
- Thumbnail remove button in the composer (needs a Button variant or `Badge`).
- Remaining `.dot`/`.spin` and `.st`/`.rr` CSS stays until `layout.ts` stops building those as HTML strings.
- **Verification gaps:** file-tree/commit/rename context menus, Escape-to-close, retry/auth banner buttons, "Open diff", click/Enter picks in palette and quick switcher, repo `Select`, status-bar popovers, keyboard and scroll behavior in new menus.
- A visual and a11y pass per theme (mocha/latte) before relying on the swap story with a second adapter; no second adapter exists yet, so the contract is untested against another library.
