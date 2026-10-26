// Catppuccin (Mocha / Latte) for the whole app: CSS variables, xterm and Monaco all derive from these palettes.
// pref (settings.theme in harbor.json): 'system' (follow the OS) | 'mocha' | 'latte'
type Color =
  | 'rosewater'
  | 'flamingo'
  | 'pink'
  | 'mauve'
  | 'red'
  | 'maroon'
  | 'peach'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'sky'
  | 'sapphire'
  | 'blue'
  | 'lavender'
  | 'text'
  | 'subtext1'
  | 'subtext0'
  | 'overlay2'
  | 'overlay1'
  | 'overlay0'
  | 'surface2'
  | 'surface1'
  | 'surface0'
  | 'base'
  | 'mantle'
  | 'crust';
export type Palette = { dark: boolean } & Record<Color, string>;
export type Name = 'mocha' | 'latte';
type Pref = 'system' | Name;

const PALETTES: Record<Name, Palette> = {
  mocha: {
    dark: true,
    rosewater: '#f5e0dc',
    flamingo: '#f2cdcd',
    pink: '#f5c2e7',
    mauve: '#cba6f7',
    red: '#f38ba8',
    maroon: '#eba0ac',
    peach: '#fab387',
    yellow: '#f9e2af',
    green: '#a6e3a1',
    teal: '#94e2d5',
    sky: '#89dceb',
    sapphire: '#74c7ec',
    blue: '#89b4fa',
    lavender: '#b4befe',
    text: '#cdd6f4',
    subtext1: '#bac2de',
    subtext0: '#a6adc8',
    overlay2: '#9399b2',
    overlay1: '#7f849c',
    overlay0: '#6c7086',
    surface2: '#585b70',
    surface1: '#45475a',
    surface0: '#313244',
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',
  },
  latte: {
    dark: false,
    rosewater: '#dc8a78',
    flamingo: '#dd7878',
    pink: '#ea76cb',
    mauve: '#8839ef',
    red: '#d20f39',
    maroon: '#e64553',
    peach: '#fe640b',
    yellow: '#df8e1d',
    green: '#40a02b',
    teal: '#179299',
    sky: '#04a5e5',
    sapphire: '#209fb5',
    blue: '#1e66f5',
    lavender: '#7287fd',
    text: '#4c4f69',
    subtext1: '#5c5f77',
    subtext0: '#6c6f85',
    overlay2: '#7c7f93',
    overlay1: '#8c8fa1',
    overlay0: '#9ca0b0',
    surface2: '#acb0be',
    surface1: '#bcc0cc',
    surface0: '#ccd0da',
    base: '#eff1f5',
    mantle: '#e6e9ef',
    crust: '#dce0e8',
  },
};

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

function cssVars(p: Palette) {
  return {
    '--bg': p.base,
    '--side': p.mantle,
    '--panel': p.mantle,
    '--line': p.surface0,
    '--line-2': p.surface1,
    '--text': p.text,
    '--sub': p.subtext1,
    '--muted': p.subtext0,
    '--faint': p.dark ? p.overlay1 : p.overlay2,
    '--accent': p.blue,
    '--accent-bg': mix(p.blue, p.dark ? 14 : 12),
    '--on-accent': p.dark ? p.crust : p.base,
    '--work': p.yellow,
    '--idle': p.green,
    '--wait': p.blue,
    '--danger': p.red,
    '--danger-soft': p.maroon,
    '--git-mod': p.yellow,
    '--git-add': p.green,
    '--git-ren': p.blue,
    '--editor': p.base,
    '--chrome': p.mantle,
    '--status': p.crust,
    '--term': p.base,
    '--sel': p.surface0,
    '--input': p.dark ? p.crust : p.base,
    '--hover': mix(p.text, 6),
    '--hover-2': mix(p.text, 10),
    '--scroll': p.surface1,
    '--scrim': p.dark ? 'rgba(17, 17, 27, 0.6)' : 'rgba(76, 79, 105, 0.3)',
    '--shadow': p.dark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(76, 79, 105, 0.22)',
    '--hl-keyword': p.mauve,
    '--hl-string': p.green,
    '--hl-number': p.peach,
    '--hl-comment': p.overlay2,
    '--hl-fn': p.blue,
    '--hl-type': p.yellow,
    '--hl-attr': p.teal,
    '--hl-pink': p.pink,
    '--hl-op': p.sky,
    '--hl-punct': p.overlay2,
    '--code-bg': p.mantle,
    // Monaco's context menu lives in a body-level shadow root outside .monaco-editor, so it never sees the theme's vars
    '--vscode-menu-background': p.mantle,
    '--vscode-menu-foreground': p.text,
    '--vscode-menu-border': p.surface1,
    '--vscode-menu-selectionBackground': p.surface0,
    '--vscode-menu-selectionForeground': p.text,
    '--vscode-menu-separatorBackground': p.surface1,
  };
}

function xtermTheme(p: Palette) {
  return {
    background: p.base,
    foreground: p.text,
    cursor: p.rosewater,
    cursorAccent: p.base,
    selectionBackground: p.overlay2 + '40',
    black: p.dark ? p.surface1 : p.subtext1,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.pink,
    cyan: p.teal,
    white: p.dark ? p.subtext1 : p.surface2,
    brightBlack: p.dark ? p.surface2 : p.subtext0,
    brightRed: p.red,
    brightGreen: p.green,
    brightYellow: p.yellow,
    brightBlue: p.blue,
    brightMagenta: p.pink,
    brightCyan: p.teal,
    brightWhite: p.dark ? p.subtext0 : p.surface1,
  };
}

function monacoTheme(p: Palette) {
  const hex = (c: string) => c.slice(1);
  const rule = (token: string, c: string, fontStyle?: string) => ({
    token,
    foreground: hex(c),
    ...(fontStyle ? { fontStyle } : {}),
  });
  return {
    base: p.dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      rule('', p.text),
      rule('comment', p.overlay2, 'italic'),
      rule('keyword', p.mauve),
      rule('keyword.control', p.mauve),
      rule('storage', p.mauve),
      rule('string', p.green),
      rule('string.escape', p.pink),
      rule('regexp', p.pink),
      rule('number', p.peach),
      rule('constant', p.peach),
      rule('predefined', p.blue),
      rule('type', p.yellow),
      rule('type.identifier', p.yellow),
      rule('namespace', p.yellow),
      rule('identifier', p.text),
      rule('variable', p.text),
      rule('variable.predefined', p.red),
      rule('function', p.blue),
      rule('operator', p.sky),
      rule('delimiter', p.overlay2),
      rule('delimiter.bracket', p.overlay2),
      rule('tag', p.blue),
      rule('metatag', p.mauve),
      rule('attribute.name', p.yellow),
      rule('attribute.value', p.green),
      rule('key', p.blue),
      rule('annotation', p.peach),
      rule('string.key.json', p.blue),
      rule('string.value.json', p.green),
      rule('keyword.json', p.peach),
      rule('number.json', p.peach),
    ],
    colors: {
      'editor.background': p.base,
      'editor.foreground': p.text,
      'editorLineNumber.foreground': p.overlay0,
      'editorLineNumber.activeForeground': p.lavender,
      'editor.lineHighlightBackground': p.surface0 + '66',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': p.overlay2 + '40',
      'editor.inactiveSelectionBackground': p.overlay2 + '26',
      'editor.selectionHighlightBackground': p.overlay2 + '26',
      'editor.wordHighlightBackground': p.overlay2 + '26',
      'editor.findMatchBackground': p.peach + '55',
      'editor.findMatchHighlightBackground': p.sky + '33',
      'editorBracketMatch.background': p.overlay2 + '33',
      'editorBracketMatch.border': '#00000000',
      'editorCursor.foreground': p.rosewater,
      'editorIndentGuide.background1': p.surface0,
      'editorIndentGuide.activeBackground1': p.surface2,
      'editorWhitespace.foreground': p.surface1,
      'editorError.foreground': p.red,
      'editorWarning.foreground': p.yellow,
      'editorInfo.foreground': p.sky,
      'editorHint.foreground': p.teal,
      'editorWidget.background': p.mantle,
      'editorWidget.border': p.surface1,
      'editorSuggestWidget.background': p.mantle,
      'editorSuggestWidget.border': p.surface1,
      'editorSuggestWidget.selectedBackground': p.surface0,
      'editorSuggestWidget.highlightForeground': p.blue,
      'editorHoverWidget.background': p.mantle,
      'editorHoverWidget.border': p.surface1,
      'editorStickyScroll.background': p.mantle,
      'editorStickyScrollHover.background': p.surface0,
      'menu.background': p.mantle,
      'menu.foreground': p.text,
      'menu.border': p.surface1,
      'menu.selectionBackground': p.surface0,
      'menu.selectionForeground': p.text,
      'menu.separatorBackground': p.surface1,
      'input.background': p.surface0,
      'input.foreground': p.text,
      'input.border': p.surface1,
      'inputOption.activeBackground': p.blue + '33',
      'inputOption.activeBorder': p.blue,
      focusBorder: p.blue,
      'list.hoverBackground': p.surface0 + '80',
      'list.activeSelectionBackground': p.surface0,
      'scrollbarSlider.background': p.surface1 + '80',
      'scrollbarSlider.hoverBackground': p.surface2 + '99',
      'scrollbarSlider.activeBackground': p.surface2,
      'diffEditor.insertedTextBackground': p.green + '33',
      'diffEditor.insertedLineBackground': p.green + '1a',
      'diffEditor.removedTextBackground': p.red + '33',
      'diffEditor.removedLineBackground': p.red + '1a',
      'diffEditor.diagonalFill': p.surface1 + '80',
      'diffEditor.border': p.surface1,
      'diffEditorGutter.insertedLineBackground': p.green + '33',
      'diffEditorGutter.removedLineBackground': p.red + '33',
      'diffEditorOverview.insertedForeground': p.green + '99',
      'diffEditorOverview.removedForeground': p.red + '99',
      'minimap.background': p.base,
      'minimapSlider.background': p.surface1 + '40',
      'editorGutter.background': p.base,
      'editorOverviewRuler.border': '#00000000',
      'peekView.border': p.lavender,
      'peekViewEditor.background': p.mantle,
      'peekViewResult.background': p.mantle,
      'peekViewTitle.background': p.mantle,
      'peekViewEditor.matchHighlightBackground': p.sky + '33',
      'peekViewResult.matchHighlightBackground': p.sky + '33',
    },
  };
}

const KEY = 'harbor.theme';
const listeners: ((name: Name) => void)[] = [];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let pref: Pref = 'system';
let name: Name = 'mocha';
let applied = false;

const resolve = (pf: string): Name => (pf === 'mocha' || pf === 'latte' ? pf : darkQuery.matches ? 'mocha' : 'latte');

function apply() {
  const next = resolve(pref);
  const p = PALETTES[next];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVars(p))) root.style.setProperty(k, v);
  root.style.colorScheme = p.dark ? 'dark' : 'light';
  root.dataset.theme = next;
  if (next === name && applied) return;
  name = next;
  applied = true;
  for (const f of listeners) f(name);
}

function setPref(pf: string) {
  pref = pf === 'mocha' || pf === 'latte' ? pf : 'system';
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  apply();
}

try {
  pref = (localStorage.getItem(KEY) as Pref) || 'system';
} catch {
  /* storage unavailable */
}
darkQuery.addEventListener('change', () => {
  if (pref === 'system') apply();
});
apply(); // before first paint, from the cached pref (avoids a flash before settings arrive)

const harborTheme = {
  get pref() {
    return pref;
  },
  get name() {
    return name;
  },
  palette: () => PALETTES[name],
  xterm: () => xtermTheme(PALETTES[name]),
  monaco: () => ({ id: `catppuccin-${name}`, def: monacoTheme(PALETTES[name]) }),
  monacoThemes: () =>
    (Object.entries(PALETTES) as [Name, Palette][]).map(([n, p]) => ({ id: `catppuccin-${n}`, def: monacoTheme(p) })),
  sync: (pf?: string) => {
    if ((pf || 'system') !== pref) setPref(pf || 'system');
  }, // settings.theme from harbor.json
  onChange: (f: (name: Name) => void) => {
    listeners.push(f);
  },
};
window.harborTheme = harborTheme;
export type HarborTheme = typeof harborTheme;

// Disclosure arrow used everywhere (points right; `.open > .chev` / expanded rows rotate it down).
window.harborChevron =
  '<svg class="chev" viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
