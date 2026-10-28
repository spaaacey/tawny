import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareCodexModels, compatibleCatalog } from '../src/main/codex-models.ts';

const model = (slug, priority, visibility = 'list') => ({
  slug, priority, visibility, default_reasoning_level: 'max',
  supported_reasoning_levels: ['low', 'medium', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
});

test('new catalog retains model identities, omits unsupported efforts, and selects by priority', () => {
  const input = { models: [model('hidden', 0, 'hide'), model('luna', 3), model('sol', 1)] };
  const { models, preferred } = compatibleCatalog(input);
  assert.equal(preferred.slug, 'sol');
  assert.equal(preferred.default_reasoning_level, 'medium');
  assert.deepEqual(models[2].supported_reasoning_levels.map(l => l.effort), ['low', 'medium', 'xhigh']);
  assert.equal(input.models[2].supported_reasoning_levels.length, 5);
});

test('private catalog uses CODEX_HOME and leaves source cache intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-models-'));
  try {
    const source = JSON.stringify({ models: [model('sol', 1)] });
    fs.writeFileSync(path.join(dir, 'models_cache.json'), source);
    const { args } = prepareCodexModels(path.join(dir, 'data with spaces'), { CODEX_HOME: dir });
    assert.equal(args[3], 'model="sol"');
    const file = JSON.parse(args[1].slice('model_catalog_json='.length));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).models[0].slug, 'sol');
    assert.equal(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8'), source);
    assert.equal(prepareCodexModels(dir, { CODEX_HOME: path.join(dir, 'missing') }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid catalog fails clearly rather than silently selecting GPT-5.5', () => {
  assert.throws(() => compatibleCatalog({ models: [] }), /no selectable models/);
});


test('new model schema supplies all legacy catalog fields required by codex-acp', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-models.json', import.meta.url), 'utf8'));
  const { models } = compatibleCatalog(fixture);
  assert.equal(models[0].base_instructions, 'You are a coding assistant.');
  assert.equal(models[0].model_messages, null);
  assert.equal(models[0].supports_reasoning_summaries, false);
  assert.equal(models[0].supports_parallel_tool_calls, false);
  assert.equal(fixture.models[0].base_instructions, undefined);
  const legacy = compatibleCatalog({ models: [{ ...fixture.models[0], base_instructions: 'Legacy instructions', supports_reasoning_summaries: true, supports_parallel_tool_calls: true }] });
  assert.equal(legacy.models[0].base_instructions, 'Legacy instructions');
  assert.equal(legacy.models[0].supports_reasoning_summaries, true);
  assert.equal(legacy.models[0].supports_parallel_tool_calls, true);
});

// Config parsing + protocol handshake only: isolated HOME, no credentials, no
// session/new, and no prompt/inference. Set CODEX_ACP_BINARY to the native binary.
test('installed adapter accepts the converted catalog and initializes offline', {
  skip: !process.env.CODEX_ACP_BINARY,
  timeout: 10000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-acp-startup-'));
  let proc;
  try {
    fs.copyFileSync(new URL('./fixtures/codex-models.json', import.meta.url), path.join(dir, 'models_cache.json'));
    const { args } = prepareCodexModels(dir, { CODEX_HOME: dir });
    proc = spawn(process.env.CODEX_ACP_BINARY, args, {
      env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: dir, RUST_LOG: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error(`No initialize response: ${stderr}`)), 5000);
      const fail = err => { clearTimeout(timer); reject(err); };
      proc.on('error', fail);
      proc.on('exit', code => fail(new Error(`Adapter exited (${code}): ${stderr}`)));
      proc.stderr.on('data', data => { stderr += data; });
      proc.stdout.on('data', data => {
        stdout += data;
        const lines = stdout.split('\n');
        stdout = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.id === 1) { clearTimeout(timer); resolve(message); }
        }
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'tawny-startup-test', version: 'test' },
      } }) + '\n');
    });
    assert.equal(result.error, undefined);
    assert.equal(result.result.agentInfo.name, 'codex-acp');
    assert.equal(result.result.protocolVersion, 1);
  } finally {
    if (proc && proc.exitCode === null) {
      await new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
