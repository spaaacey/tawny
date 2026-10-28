// Fixture-backed app-server: no model, credentials, network, or shell execution.
import readline from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message)+'\n');
const result = (id,value) => send({id,result:value});
let activeThread='thread-1';
const event = (method,params) => send({method,params:{threadId:activeThread,...params}});
const levels = ['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort,description:reasoningEffort}));
const model = (model,isDefault=false) => ({model,displayName:model,description:'Fixture model',supportedReasoningEfforts:levels,defaultReasoningEffort:'low',isDefault});
let turnId=0, approvalRequest=null;
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line), p=m.params||{};
 if(!m.method){if(m.id===approvalRequest){event('turn/completed',{turn:{id:`turn-${turnId}`,status:'completed'}});}continue;}
 switch(m.method) {
  case 'initialize':result(m.id,{userAgent:'fixture-codex'});break;
  case 'initialized':break;
  case 'model/list':result(m.id,p.cursor?{data:[model('gpt-6-luna')],nextCursor:null}:{data:[model('gpt-6.1-sol',true)],nextCursor:'page2'});break;
  case 'account/read':result(m.id,{account:process.env.MOCK_SIGNED_OUT?null:{type:'chatgpt'},requiresOpenaiAuth:true});break;
  case 'thread/start':
  case 'thread/resume':result(m.id,{thread:{id:'thread-1',name:null,turns:m.method==='thread/resume'?[{items:[{id:'user-old',type:'userMessage',content:[{type:'text',text:'Earlier question'}]},{id:'answer-old',type:'agentMessage',text:'Earlier answer'}]}]:[]},model:'gpt-6.1-sol',reasoningEffort:'low'});break;
  case 'thread/fork':activeThread='thread-fork';result(m.id,{thread:{id:activeThread}});break;
  case 'thread/list':result(m.id,{data:[{id:'thread-1',name:'Saved chat',updatedAt:123}],nextCursor:null});break;
  case 'thread/unsubscribe':result(m.id,{});break;
  case 'turn/start': {
   turnId++;
   const text=p.input.map(b=>b.text||'').join('');
   if(text==='crash'){process.exit(1);}
   const turn={id:`turn-${turnId}`,status:'inProgress'};
   // Deliberately stream before acknowledging turn/start to exercise races.
   if(text!=='cancel-early')event('turn/started',{turn});
   if(text==='cancel-early') {setTimeout(()=>result(m.id,{turn}),40);break;}
   result(m.id,{turn});
   if(text==='wait')break;
   if(text==='failure'){event('turn/completed',{turn:{...turn,status:'failed',error:{message:'Model access denied: actual backend error'}}});break;}
   if(text==='approval'){
    approvalRequest=900;
    send({id:900,method:'item/commandExecution/requestApproval',params:{itemId:'command-1',threadId:'thread-1',command:'echo fixture'}});
    break;
   }
   event('item/agentMessage/delta',{itemId:'answer',delta:`Fixture answer (${p.model}, ${p.effort})`});
   event('item/completed',{item:{type:'agentMessage',id:'answer',text:`Fixture answer (${p.model}, ${p.effort})`}});
   event('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:42},modelContextWindow:500000}});
   event('turn/completed',{turn:{...turn,status:'completed'}});break;
  }
  case 'turn/interrupt':result(m.id,{});event('turn/completed',{turn:{id:p.turnId,status:'interrupted'}});break;
  default:send({id:m.id,error:{code:-32601,message:`Unknown method ${m.method}`}});
 }
}
