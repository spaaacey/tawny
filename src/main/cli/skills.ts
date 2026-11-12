// `tawny skills get|install`: the agent guide for the CLI, generated from the registry schema plus the workflow rules,
// and the stub skill that points Claude at it. Also the one-paragraph system prompt line for Tawny-launched Claude chats.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod';
import type { Registry } from './registry';

interface SchemaEntry {
  name: string;
  summary: string;
  params: {
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  args?: string[];
  stdin?: string;
}

/** Appended to the system prompt of every Tawny-launched Claude chat. */
export function tawnyIntro(tabName: string, worktree: string) {
  return `You are running in a Tawny chat tab named "${tabName}" in worktree ${worktree}. The \`tawny\` CLI controls the app: \`tawny --help\` lists what you can do, and \`tawny skills get tawny\` prints the full guide (read it before opening or driving other chats).`;
}

/** The rules of driving other chats; not derivable from the schema. */
const WORKFLOW_RULES = [
  'Only drive chats you opened yourself (`tawny chat new`). Never message, read or close a chat the user opened unless they asked.',
  'Do not message a chat that is mid-turn or waiting on a permission: `chat send` errors then (there is no queueing). Run `tawny chat wait <id>` first, which blocks until it is idle.',
  'Use `tawny chat wait` instead of polling `chat list` or `chat read` in a loop.',
  'Read summaries, not transcripts: `tawny chat read <id> --last 1` is usually enough. The plan doc is the shared state; tell chats to write notes there.',
  'Parallel tasks get their own worktree (create it, then `tawny chat new --workspace <path>`); sequential tasks share one.',
  'New chats open in the background. Pass `--focus` only if the user should see it now; `tawny notify` flags your own chat tab when you need the user (chat tabs only).',
  "Pass multi-line text on stdin with a quoted heredoc (`<<'EOF'`) rather than in arguments: `tawny` calls with plain arguments are auto-allowed, chained or substituted ones prompt.",
];

const kebab = (s: string) => s.replace(/_/g, '-');
const cmd = (name: string) => `tawny ${name.replace('.', ' ').replace(/_/g, '-')}`;

function commandLine(m: SchemaEntry) {
  const props = m.params.properties ?? {};
  const required = new Set(m.params.required ?? []);
  const parts = [cmd(m.name)];
  for (const a of m.args ?? []) parts.push(required.has(a) ? `<${kebab(a)}>` : `[<${kebab(a)}>]`);
  for (const [k, p] of Object.entries(props)) {
    if ((m.args ?? []).includes(k)) continue;
    const flag =
      p.type === 'boolean' ? `--${kebab(k)}` : `--${kebab(k)} <${p.enum ? p.enum.join('|') : (p.type ?? 'value')}>`;
    parts.push(required.has(k) ? flag : `[${flag}]`);
  }
  return parts.join(' ');
}

/** The guide `tawny skills get tawny` prints: commands from the live registry, so it always matches this version. */
export function skillGuide(schema: SchemaEntry[], version: string) {
  const groups = new Map<string, SchemaEntry[]>();
  for (const m of schema) {
    const g = m.name.includes('.') ? m.name.split('.')[0] : 'general';
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  const out = [
    `# Driving Tawny with the \`tawny\` CLI (Tawny ${version})`,
    '',
    'Only applies inside Tawny (`TAWNY=1`). `tawny` talks to the running app; commands print JSON (add `--text` for plain text), errors go to stderr with a non-zero exit. In a Tawny chat or terminal, commands act on your own worktree and chat by default; `--workspace <path|name>` targets another (see `tawny workspace list`).',
    '',
    '## Rules',
    '',
    ...WORKFLOW_RULES.map((r) => `- ${r}`),
  ];
  for (const [g, list] of groups) {
    out.push('', `## ${g}`, '');
    for (const m of list) {
      out.push(`- \`${commandLine(m)}\`${m.stdin ? ` (${kebab(m.stdin)} may be piped on stdin)` : ''}: ${m.summary}`);
      for (const [k, p] of Object.entries(m.params.properties ?? {}))
        if (p.description)
          out.push(`  - \`${(m.args ?? []).includes(k) ? kebab(k) : `--${kebab(k)}`}\`: ${p.description}`);
    }
  }
  out.push(
    '',
    '## Typical flow',
    '',
    '```sh',
    "tawny chat new --prompt 'Read docs/plan.md and do ticket 2' --workspace /path/to/worktree   # prints { chatId, ... }",
    'tawny chat wait <chatId> --timeout 1800',
    'tawny chat read <chatId> --last 1',
    "tawny chat send <chatId> --message 'Also update the docs'",
    '```',
    '',
    '`tawny agent-context` prints the full command schema as JSON.',
  );
  return out.join('\n');
}

export const STUB_SKILL = `---
name: tawny
description: Control the Tawny app (open chats, files, diffs, tabs, flag attention) through the tawny CLI. Use only when the TAWNY environment variable is 1.
---

Only if \`TAWNY=1\` is set in your environment (you are running inside Tawny). Otherwise ignore this skill.

Run \`tawny skills get tawny\` and follow the guide it prints; it matches the installed Tawny version.
`;

export function stubPath(home = os.homedir()) {
  return path.join(home, '.claude', 'skills', 'tawny', 'SKILL.md');
}

/** Write the stub skill. Callers must have the user's consent first. */
export function installStub(home = os.homedir()) {
  const file = stubPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, STUB_SKILL);
  return file;
}

export interface SkillsDeps {
  version: string;
  /** Ask the human (native dialog); resolves true only on an explicit yes. */
  confirm(message: string, detail: string): Promise<boolean>;
}

export function registerSkills(reg: Registry, deps: SkillsDeps) {
  reg.add({
    name: 'skills.get',
    summary: 'Print the agent guide for this version of the CLI (`tawny skills get tawny`).',
    params: z.object({ name: z.string().describe('Skill name: tawny') }),
    args: ['name'],
    handler: (p) => {
      if (p.name !== 'tawny') throw new Error(`unknown skill "${p.name}" (available: tawny)`);
      return skillGuide(reg.schema() as SchemaEntry[], deps.version);
    },
  });
  reg.add({
    name: 'skills.install',
    summary:
      'Install the stub skill at ~/.claude/skills/tawny/SKILL.md so Claude finds the guide. Asks the user to confirm in the app first.',
    params: z.object({}),
    handler: async () => {
      const file = stubPath();
      const ok = await deps.confirm(
        'Install the Tawny skill for Claude?',
        `This writes ${file}, which tells Claude to run "tawny skills get tawny" when it runs inside Tawny.`,
      );
      if (!ok) throw new Error('not installed: the user declined');
      return { installed: installStub() };
    },
  });
}
