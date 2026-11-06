import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { emptyModel, fold } from '../src/shared/chat-model.ts';

test('native child replay preserves hierarchy, resolved settings and one answer', () => {
  const m = emptyModel();
  fold(m, {sessionUpdate:'config_option_update',configOptions:[{id:'model',category:'model',currentValue:'root-model'}]}, 'root');
  const lines = fs.readFileSync(new URL('./fixtures/acp/claude-subagents-synthetic.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  for (const {msg,t} of lines) if (msg.method === 'session/update') fold(m, {...msg.params.update,timestamp:t},msg.params.sessionId);
  assert.deepEqual(m.items,[{type:'subagent',id:'child'}]);
  const c = m.subagents.child;
  assert.equal(c.model,'claude-haiku-5-5');
  assert.equal(c.effort,'low');
  assert.equal(c.agentType,'Explore');
  assert.equal(c.prompt,'Read notes.txt and summarize it.');
  assert.equal(c.startedAt,100);
  assert.equal(c.endedAt,13000);
  assert.equal(m.configOptions[0].currentValue,'root-model');
  assert.equal(m.subagents.nested.parentSessionId,'child');
  assert.equal(m.subagents.nested.effort,undefined);
  assert.deepEqual(c.items,[{type:'tool',id:'read'},{type:'subagent',id:'nested'},{type:'agent',text:'The notes say hello world.'}]);
  fold(m,{sessionUpdate:'subagent_update',sessionId:'child',state:{state:'running'},timestamp:14000},'root');
  assert.equal(m.items.length,1);
  assert.equal(c.endedAt,undefined);
});

test('legacy parentToolUseId routing stays nested', () => {
 const m = emptyModel();
 fold(m,{sessionUpdate:'tool_call',toolCallId:'launch'});
 fold(m,{sessionUpdate:'tool_call',toolCallId:'read',_meta:{claudeCode:{parentToolUseId:'launch'}}});
 assert.deepEqual(m.items,[{type:'tool',id:'launch'}]);
 assert.deepEqual(m.tools.launch.sub,[{type:'tool',id:'read'}]);
});

test('unannounced child options never overwrite root; structured errors display their message', () => {
 const m = emptyModel();
 fold(m,{sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:'root'}]},'root');
 fold(m,{sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:'child'}]},'unannounced');
 assert.equal(m.configOptions[0].currentValue,'root');
 fold(m,{sessionUpdate:'subagent_update',sessionId:'child',state:{state:'idle',stopReason:'error',error:{code:-1,message:'Read failed'}}},'root');
 assert.equal(m.subagents.child.error,'Read failed');
});
