// codex-acp 0.16 embeds an older Codex runtime. Its catalog parser rejects newer
// reasoning levels and silently falls back to obsolete built-in model names.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
interface Model {
  slug: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels: { effort: string; description?: string }[];
  [key: string]: unknown;
}

export function compatibleCatalog(catalog: { models?: Model[] }) {
  const models = (catalog.models || []).map((m) => {
    const levels = (m.supported_reasoning_levels || []).filter((l) => EFFORTS.has(l.effort));
    return {
      ...m,
      // Newer catalogs moved instructions into model_messages; the embedded
      // runtime still requires the legacy string and can't parse the new object.
      base_instructions:
        typeof m.base_instructions === 'string'
          ? m.base_instructions
          : (m.model_messages as { instructions_template?: string } | undefined)?.instructions_template || '',
      model_messages: null,
      supports_reasoning_summaries: m.supports_reasoning_summaries ?? false,
      supports_parallel_tool_calls: m.supports_parallel_tool_calls ?? false,
      supported_reasoning_levels: levels,
      default_reasoning_level: levels.some((l) => l.effort === m.default_reasoning_level)
        ? m.default_reasoning_level
        : levels.find((l) => l.effort === 'medium')?.effort || levels[0]?.effort,
    };
  });
  const preferred = models
    .filter((m) => m.visibility === 'list' && m.supported_reasoning_levels.length && m.slug)
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
  if (!preferred) throw new Error('The Codex model catalog has no selectable models. Open Codex to refresh it.');
  return { models, preferred };
}

/** Supply a private compatible catalog, never edit Codex's shared cache or auth files. */
export function prepareCodexModels(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cache = path.join(home, 'models_cache.json');
  if (!fs.existsSync(cache)) return null; // Standard installs without a cached catalog use the adapter's defaults.
  const { models, preferred } = compatibleCatalog(JSON.parse(fs.readFileSync(cache, 'utf8')));
  const file = path.join(dataDir, 'codex-acp-models.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ models }), { mode: 0o600 });
  const args = [
    '-c',
    `model_catalog_json=${JSON.stringify(file)}`,
    '-c',
    `model=${JSON.stringify(preferred.slug)}`,
    '-c',
    `model_reasoning_effort=${JSON.stringify(preferred.default_reasoning_level)}`,
  ];
  return { args, models, preferred };
}
