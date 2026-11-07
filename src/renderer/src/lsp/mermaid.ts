// `mermaid` language for Monaco: a small Monarch grammar. Registering it is also what highlights ```mermaid fences in
// markdown: Monaco's markdown grammar embeds a fenced block's language by its info string (nextEmbedded: '$1').
import type * as Monaco from 'monaco-editor';

declare const monaco: typeof Monaco;

const DIAGRAMS = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'classDiagram-v2',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantChart',
  'requirementDiagram',
  'gitGraph',
  'mindmap',
  'timeline',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'architecture-beta',
  'kanban',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic',
  'C4Deployment',
  'zenuml',
];
const KEYWORDS = [
  'subgraph',
  'end',
  'direction',
  'participant',
  'actor',
  'note',
  'Note',
  'over',
  'left',
  'right',
  'of',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'critical',
  'break',
  'rect',
  'activate',
  'deactivate',
  'autonumber',
  'box',
  'create',
  'destroy',
  'class',
  'style',
  'classDef',
  'linkStyle',
  'click',
  'callback',
  'link',
  'state',
  'as',
  'title',
  'section',
  'dateFormat',
  'axisFormat',
  'excludes',
  'includes',
  'todayMarker',
  'accTitle',
  'accDescr',
  'showData',
  'commit',
  'branch',
  'checkout',
  'merge',
  'cherry-pick',
  'namespace',
  'default',
];

export function registerMermaid() {
  if (monaco.languages.getLanguages().some((l) => l.id === 'mermaid')) return;
  monaco.languages.register({ id: 'mermaid', aliases: ['Mermaid', 'mermaid'] });
  monaco.languages.setLanguageConfiguration('mermaid', {
    comments: { lineComment: '%%' },
    brackets: [
      ['[', ']'],
      ['(', ')'],
      ['{', '}'],
    ],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
  });
  // longest names first so `stateDiagram-v2` isn't read as `stateDiagram`
  const header = new RegExp(`^\\s*(?:${[...DIAGRAMS].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`);
  monaco.languages.setMonarchTokensProvider('mermaid', {
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/%%\{/, { token: 'annotation', next: '@directive' }],
        [/%%.*$/, 'comment'],
        [header, 'keyword.type'],
        [/\b(?:TB|TD|BT|RL|LR)\b/, 'keyword.direction'],
        [/"/, 'string', '@string'],
        [/\|/, 'delimiter', '@edgeLabel'],
        // node shapes: [text] (text) {text} ([text]) [[text]] ((text)) {{text}} [/text/] >text]
        [/\(\(|\[\[|\{\{|\(\[|\[\(|\[\/|\[\\/, 'delimiter.bracket', '@nodeText'],
        [/[[({]/, 'delimiter.bracket', '@nodeText'],
        [/>(?=[^\]\n]*\])/, 'delimiter.bracket', '@nodeText'],
        // edges / arrows: --> --- -.-> ==> <--> --o --x ->> -) and sequence / class variants
        [/<?(?:-{2,}|={2,}|-\.+-|~~~)[>ox]?|<?-+>>?|<<?-+|-[)x]|\.\.>?|\*--|o--|<\|--|--\|>/, 'operator'],
        [/:::?\w+/, 'type'],
        [/[A-Za-z_][\w-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\d+(?:\.\d+)?/, 'number'],
        [/[:;,&]/, 'delimiter'],
        [/\s+/, ''],
        [/./, ''],
      ],
      string: [
        [/[^"]+/, 'string'],
        [/"/, 'string', '@pop'],
      ],
      edgeLabel: [
        [/[^|]+/, 'string'],
        [/\|/, 'delimiter', '@pop'],
      ],
      nodeText: [
        [/"[^"]*"/, 'string'],
        [/\)\)|\]\]|\}\}|\]\)|\)\]|\/\]|\\\]/, 'delimiter.bracket', '@pop'],
        [/[\])}]/, 'delimiter.bracket', '@pop'],
        [/[^"\])}/\\]+/, 'string'],
        [/./, 'string'],
      ],
      directive: [
        [/\}%%/, 'annotation', '@pop'],
        [/[^}]+/, 'annotation'],
        [/./, 'annotation'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);
}
