import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTawnyCall } from '../src/main/cli/tawny-call.ts';

test('plain tawny calls and one quoted heredoc are auto-allowed', () => {
  for (const c of ['tawny', 'tawny status', 'tawny pr get-pr --text', "tawny review resolve r-1 <<'EOF'\nnote Date.now()\nEOF"])
    assert.equal(isTawnyCall(c), true, c);
});

test('chaining, substitution, redirects, other commands still prompt', () => {
  for (const c of [
    'tawny status; rm -rf x',
    'tawny status && ls',
    'tawny status | cat',
    'tawny $(whoami)',
    'tawny `id`',
    'tawny status > /tmp/x',
    'tawnyx status',
    'ls',
    'rm tawny',
    "tawny x <<'EOF'\nhi\nEOF\nrm -rf x",
    'tawny x <<EOF\nhi\nEOF',
  ])
    assert.equal(isTawnyCall(c), false, c);
});
