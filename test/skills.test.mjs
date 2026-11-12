import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as z from 'zod';
import { Registry } from '../src/main/cli/registry.ts';
import { installStub, registerSkills, STUB_SKILL, stubPath, tawnyIntro } from '../src/main/cli/skills.ts';

function reg(confirm = async () => true) {
  const r = new Registry();
  r.add({
    name: 'chat.send',
    summary: 'Send a message.',
    params: z.object({ id: z.string(), message: z.string().optional().describe('Text') }),
    args: ['id'],
    stdin: 'message',
    handler: () => 1,
  });
  registerSkills(r, { version: '9.9.9', confirm });
  return r;
}

test('guide lists registered commands and the workflow rules', async () => {
  const r = reg();
  const g = await r.call('skills.get', { name: 'tawny' }, {});
  assert.match(g, /tawny chat send <id> \[--message <string>\]/);
  assert.match(g, /tawny skills get <name>/);
  assert.match(g, /Only drive chats you opened/);
  assert.match(g, /9\.9\.9/);
  await assert.rejects(r.call('skills.get', { name: 'x' }, {}), /unknown skill/);
});

test('install writes only after consent, under the given home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-skill-'));
  assert.equal(fs.existsSync(stubPath(home)), false);
  assert.equal(installStub(home), stubPath(home));
  assert.equal(fs.readFileSync(stubPath(home), 'utf8'), STUB_SKILL);
  fs.rmSync(home, { recursive: true });
  await assert.rejects(reg(async () => false).call('skills.install', {}, {}), /declined/);
});

test('intro names the tab and worktree', () => {
  assert.match(tawnyIntro('Fix bug', '/w/x'), /"Fix bug" in worktree \/w\/x/);
});
