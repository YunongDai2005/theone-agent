import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function withNative(startEnv,fn,options={}){const e=await startEnv({service:true,...options});try{await e.say('/dsh');await fn(e);}finally{await e.stop();e.cleanup();}}
export default [
 {name:'常驻 DSH：正常回复、历史快照不重发',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('测试常驻接口');await e.waitFor(()=>e.texts().some(t=>t==='service reply'));
     assert.equal(e.native.calls.filter(x=>x.method==='session/prompt').length,1);
     assert.equal(e.texts().filter(t=>t==='service reply').length,1);
   });
 }},
 {name:'常驻 DSH：插话在当前轮接入，回执不是排队即已读',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('开始工作 #sleep=1200');await e.waitFor(()=>[...e.native.sessions.values()].some(s=>s.running));
     await e.say('最后补一份手机说明');await e.waitFor(()=>e.native.calls.some(x=>x.method==='session/prompt'&&x.p.mode==='steer'));
     await e.waitFor(()=>e.texts().some(t=>t.includes('补充已接入当前任务')));
     const events=e.file('.aibox/mgr/delivery.jsonl');
     const fs=await import('node:fs');const r=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);
     assert.equal(r.filter(x=>x.state==='delivered').length,1);
     assert.equal(e.native.calls.filter(x=>x.method==='session/prompt'&&x.p.mode==='queue').length,1);
     assert.equal(e.dshCalls().length,0,'未重启 headless');
   });
 }},
 {name:'常驻 DSH：原生提问回答返回相同 event，失败保留待答',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('请问我颜色 #question #fail-answer');await e.waitFor(()=>e.texts().some(t=>t.includes('选什么颜色')));
     await e.say('2');await e.waitFor(()=>e.texts().some(t=>t.includes('回答提交失败')));
     const a=await (await fetch('http://127.0.0.1:'+e.apiPort+'/api/v2/interaction')).json();assert.equal(a.pending.length,1);
     await e.say('2');await e.waitFor(()=>e.texts().some(t=>t.includes('回答已送达')));
     await e.waitFor(()=>e.texts().some(t=>t==='question answered'));
     const calls=e.native.calls.filter(x=>x.method==='$events/result');assert.equal(calls.length,2);
     assert.equal(calls[0].p.eventId,calls[1].p.eventId);
     assert.deepEqual(calls[1].p.outcome.value.answers,[{id:'color',selected:['绿色']}]);
   });
 }},
 {name:'常驻 DSH：审批必须匹配编号，普通同意不能授权',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('测试审批 #approval');await e.waitFor(()=>e.texts().some(t=>t.includes('需要你确认')));
     await e.say('好');await e.waitFor(()=>e.texts().some(t=>t.includes('请回复 /通过')));
     assert.equal(e.native.calls.filter(x=>x.method==='$events/result').length,0);
     await e.say('/通过 wrong');await e.waitFor(()=>e.texts().some(t=>t.includes('编号不匹配')));
     const {pending}=await (await fetch('http://127.0.0.1:'+e.apiPort+'/api/v2/interaction')).json();await e.say('/拒绝 '+pending[0].id);
     await e.waitFor(()=>e.texts().some(t=>t.includes('已拒绝本次')));
     assert.equal(e.native.calls.filter(x=>x.method==='$events/result').at(-1).p.outcome.value,'rejected');
   });
 }},
 {name:'常驻 DSH：事件断线重连恢复完成状态，不重复执行',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('断线测试 #disconnect #sleep=100');
     await e.waitFor(()=>e.texts().some(t=>t==='service reply'),{timeout:6000});
     assert.equal(e.native.calls.filter(x=>x.method==='session/prompt').length,1);
     assert.equal(e.texts().filter(t=>t==='service reply').length,1);
   });
 }},
 {name:'常驻 DSH：叫停清队列、取消当前任务、旧回复不发',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('开始长任务 #sleep=3000');await e.waitFor(()=>[...e.native.sessions.values()].some(s=>s.running));
     await e.say('停');await e.waitFor(()=>e.texts().some(t=>t.includes('停')));
     await sleep(300);assert(e.native.calls.some(x=>x.method==='session/cancel'));
     assert(!e.texts().some(t=>t==='service reply'));
   });
 }},
 {name:'常驻 DSH：等待回答暂停 idle，经理自由回答仍回原 event',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('请提问 #question');await e.waitText('选什么颜色');
     await sleep(1500);assert(!e.native.calls.some(x=>x.method==='session/cancel'));
     await e.say('我选浅紫色');await e.waitText('回答已送达');await e.waitText('question answered');
     const r=e.native.calls.find(x=>x.method==='$events/result');assert.equal(r.p.outcome.value.answers[0].custom,'我选浅紫色');
   },{config:{dshIdleMs:500},llmRules:{manager:()=>({reply:'回答',action:'answer',to_worker:'我选浅紫色'})}});
 }},
 {name:'常驻 DSH：经理不能绕过审批编号，叫停后旧答案作废',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('测试审批 #approval');await e.waitText('需要你确认');
     const {pending}=await e.api('interaction');await e.say('我觉得可以执行');
     await e.waitFor(()=>e.llmCalls.some(x=>x.kind==='manager'));await sleep(100);
     assert.equal(e.native.calls.filter(x=>x.method==='$events/result').length,0);
     await e.say('停');await sleep(100);await e.say('/通过 '+pending[0].id);await e.waitText('这个问题已经结束');
     assert.equal(e.native.calls.filter(x=>x.method==='$events/result').length,0);
   },{llmRules:{manager:()=>({reply:'通过',action:'answer',to_worker:'通过'})}});
 }},
 {name:'常驻 DSH：叫停不再自动执行本地排队任务',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{await e.say('长任务 #sleep=3000');await e.waitFor(()=>[...e.native.sessions.values()].some(s=>s.running));
     await e.say('另外做第二件事');await e.waitFor(()=>e.llmCalls.some(x=>x.kind==='manager'));await sleep(100);
     await e.say('停');await e.waitText('⛔ 停了');await sleep(700);
     assert.equal(e.native.calls.filter(x=>x.method==='session/prompt'&&x.p.mode==='queue').length,1);
   });
 }},
 {name:'常驻 DSH：网关启动清除上次孤儿任务再接新消息',v1:false,noStart:true,async run(_, {startEnv}){
   await withNative(startEnv,async e=>{
     assert(e.native.calls.some(x=>x.method==='session/cancel'&&x.p.sessionId==='session-orphan'));
     assert.equal(e.native.sessions.get('session-orphan').running,false);
     assert.deepEqual(e.readJson('.aibox/mgr/service-runs.json'),{});
   },{setup:e=>{
     e.native.sessions.set('session-orphan',{id:'session-orphan',events:[],inbox:{'next-step':[],'next-turn':[{id:'queued-old'}]},running:true,turn:1,requests:new Set()});
     e.writeJson('.aibox/mgr/service-runs.json',{'orphan-run':{sessionId:'session-orphan',chat:'wxid_owner'}});
   }});
 }},
];
