import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { CodexAgent } from '../src/main/codex.ts';

async function fixture(t, env={}) {
 const updates=[], permissions=[];
 const proc=spawn(process.execPath,[new URL('./codex-mock-server.mjs',import.meta.url).pathname],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 const agent=new CodexAgent(proc,{update:u=>updates.push(u),permission:async p=>{permissions.push(p);return {outcome:{outcome:'cancelled'}};}});
 t.after(async()=>{if(proc.exitCode===null){const exited=once(proc,'exit');agent.close();await exited;}});
 await agent.request('initialize');
 return {agent,updates,permissions};
}
const prompt=(agent,text)=>agent.request('session/prompt',{prompt:[{type:'text',text}]});

test('native model pagination retains max/ultra; selected settings reach turn/start and response streams once',async t=>{
 const {agent,updates}=await fixture(t);
 const session=await agent.request('session/new',{cwd:'/tmp'});
 assert.equal(session.sessionId,'thread-1');
 assert.equal(session.configOptions[0].options.length,2);
 assert.ok(session.configOptions[1].options.some(e=>e.value==='ultra'));
 await agent.request('session/set_config_option',{configId:'model',value:'gpt-6-luna'});
 await agent.request('session/set_config_option',{configId:'effort',value:'max'});
 assert.equal((await prompt(agent,'hello')).stopReason,'end_turn');
 assert.deepEqual(updates.filter(u=>u.sessionUpdate==='agent_message_chunk').map(u=>u.content.text),['Fixture answer (gpt-6-luna, max)']);
 assert.equal(updates.find(u=>u.sessionUpdate==='usage_update').used,42);
});
test('backend failure retains the actual message',async t=>{
 const {agent}=await fixture(t);await agent.request('session/new',{cwd:'/tmp'});
 await assert.rejects(prompt(agent,'failure'),/Model access denied: actual backend error/);
});
test('command approval cancellation maps to denial and completes turn',async t=>{
 const {agent,permissions}=await fixture(t);await agent.request('session/new',{cwd:'/tmp'});
 await prompt(agent,'approval');assert.equal(permissions[0].toolCall.toolCallId,'command-1');
 assert.deepEqual(await agent.serverRequest('item/fileChange/requestApproval',{itemId:'file-1'}),{decision:'decline'});
 await assert.rejects(agent.serverRequest('unknown',{}),/does not yet support/);
});
test('interrupt before turn/start response does not leave a hanging turn',async t=>{
 const {agent}=await fixture(t);await agent.request('session/new',{cwd:'/tmp'});
 const running=prompt(agent,'cancel-early');await agent.notify('session/cancel');
 assert.equal((await running).stopReason,'cancelled');
});
test('history replays on load but not reconnect; sessions list and close use native methods',async t=>{
 const {agent,updates}=await fixture(t);
 await agent.request('session/load',{sessionId:'thread-1',cwd:'/tmp'});
 assert.deepEqual(updates.map(u=>u.content?.text).filter(Boolean),['Earlier question','Earlier answer']);
 updates.length=0;
 await agent.request('session/resume',{sessionId:'thread-1',cwd:'/tmp'});
 assert.equal(updates.filter(u=>u.content).length,0);
 assert.equal((await agent.request('session/list',{cwd:'/tmp'})).sessions[0].title,'Saved chat');
 await agent.request('session/close',{sessionId:'thread-1'});
});
test('signed-out native auth gives a usable sign-in state',async t=>{
 const {agent}=await fixture(t,{MOCK_SIGNED_OUT:'1'});
 await assert.rejects(agent.request('session/new',{cwd:'/tmp'}),e=>e.code===-32000&&/Authentication required/.test(e.message));
});
test('process exit rejects an in-flight turn',async t=>{
 const {agent}=await fixture(t);await agent.request('session/new',{cwd:'/tmp'});
 await assert.rejects(prompt(agent,'crash'),/Codex exited/);
});


test('/fork branches the native thread without submitting a model prompt',async t=>{
 const {agent,updates}=await fixture(t);await agent.request('session/new',{cwd:'/tmp'});
 let saved;agent.hooks.session=id=>{saved=id;};
 assert.equal((await prompt(agent,'/fork')).stopReason,'end_turn');
 assert.equal(saved,'thread-fork');assert.equal(agent.thread,'thread-fork');
 assert.ok(updates.some(u=>u.text?.includes('Forked')));
 assert.equal((await prompt(agent,'after fork')).stopReason,'end_turn');
});
