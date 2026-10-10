/** Deterministic local DSH fixture: real HTTP envelopes and websocket frames, no external models. */
import http from 'node:http';
import crypto from 'node:crypto';
function frame(j) {
  const b=Buffer.from(JSON.stringify(j));
  if(b.length<126)return Buffer.concat([Buffer.from([0x81,b.length]),b]);
  const h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(b.length,2);return Buffer.concat([h,b]);
}
export async function startService() {
  const sessions=new Map(), calls=[], sockets=new Set(), timers=new Set();
  let sequence=0;
  const send=(ws,j)=>{if(!ws.destroyed)ws.write(frame(j));};
  const publish=(s,type,data)=>{
    const e={seq:s.events.length,type,data,time:Date.now(),surfaceOp:'append'};s.events.push(e);
    for(const ws of sockets)for(const [id,sid] of ws.follows||[])if(sid===s.id)send(ws,{type:'item',streamId:id,value:{type:'event',event:e}});
  };
  const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;};
  const finish=(s,text='service reply',reason='completed')=>{
    if(!s.running)return;
    for(const m of s.inbox['next-step'])publish(s,'user/message',m);s.inbox['next-step']=[];
    publish(s,'assistant/message',{turn:s.turn,step:2,message:{content:[{type:'text',text}]},usage:{inputTokens:100,outputTokens:2}});
    publish(s,'step/end',{turn:s.turn,step:2});s.running=false;
    publish(s,'turn/end',{turn:s.turn,reason:{kind:reason}});
  };
  const srv=http.createServer(async(req,res)=>{
    let text='';for await(const b of req)text+=b;
    let j;try{j=JSON.parse(text);}catch{res.writeHead(400);res.end();return;}
    const method=j.method,p=j.payload?.args?.request||j.payload?.args||{};
    calls.push({method,p});
    const ok=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:j.rpcId,result:{ok:true,value}}));};
    const fail=code=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:j.rpcId,result:{ok:false,error:{code,message:code}}}));};
    if(!req.headers.cookie)return fail('unauthorized');
    if(method==='session/create'){
      const id=p.sessionId||'session-fake-'+(++sequence);
      if(!sessions.has(id))sessions.set(id,{id,events:[],inbox:{'next-step':[],'next-turn':[]},running:false,turn:0,requests:new Set()});
      return ok({sessionId:id});
    }
    if(method==='$events/result'){
      const s=[...sessions.values()].find(s=>s.pending?.eventId===p.eventId);
      if(!s)return fail('events/not-found');
      if(s.failAnswer){s.failAnswer=false;return fail('temporary');}
      s.pending=null;later(()=>finish(s,'question answered'),20);return ok(null);
    }
    if(method==='session/list')return ok({items:[...sessions.values()].map(s=>({sessionId:s.id,running:s.running}))});
    const s=sessions.get(p.sessionId);if(!s)return fail('session/not-found');
    if(method==='session/selectModel')return ok(null);
    if(method==='session/projections')return ok({values:{inbox:s.inbox}});
    if(method==='session/updateQueue'){
      for(const k of ['next-step','next-turn'])s.inbox[k]=s.inbox[k].filter(x=>x.id!==p.itemId);
      return ok(null);
    }
    if(method==='session/cancel'){if(s.running)finish(s,'','interrupted');return ok(null);}
    if(method==='session/prompt'){
      if(s.requests.has(p.requestId))return ok({accepted:true});s.requests.add(p.requestId);
      const msg={id:'m-'+p.requestId,role:'user',content:p.content,source:{kind:'user',rpcId:p.requestId}};
      const task=p.content?.[0]?.text||'';
      if(p.mode==='steer'){
        s.inbox['next-step'].push(msg);publish(s,'agent/inbox/spliced',{target:'next-step',inserted:[msg]});
        later(()=>{if(s.running&&s.inbox['next-step'].includes(msg)){publish(s,'user/message',msg);s.inbox['next-step']=s.inbox['next-step'].filter(x=>x!==msg);}},30);
        return ok({accepted:true});
      }
      s.turn++;s.running=true;
      publish(s,'turn/start',{turn:s.turn});publish(s,'step/start',{turn:s.turn,step:1});publish(s,'user/message',msg);
      if(task.includes('#question')||task.includes('#approval')){
        const q={type:'waterfall',event:task.includes('#approval')?'approval/request':'user-questions/request',agentId:s.id,eventId:'event-'+s.id,
          request:task.includes('#approval')?{toolName:'test-tool',reason:'test operation'}:{questions:[{id:'color',question:'选什么颜色？',options:[{label:'蓝色'},{label:'绿色'}]}]}};
        s.pending=q;s.failAnswer=task.includes('#fail-answer');
        for(const ws of sockets)if(ws.eventsId)send(ws,{type:'item',streamId:ws.eventsId,value:q});
      }else{
        const ms=Number((task.match(/#sleep=(\d+)/)||[])[1]||100);
        later(()=>finish(s,'service reply'),ms);
        if(task.includes('#disconnect'))for(const ws of sockets)ws.destroy();
      }
      return ok({accepted:true});
    }
    return fail('not-found');
  });
  srv.on('upgrade',(req,ws)=>{
    sockets.add(ws);ws.follows=new Map();
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let buffer=Buffer.alloc(0);
    ws.on('data',b=>{
      buffer=Buffer.concat([buffer,b]);
      while(buffer.length>=2){
        const op=buffer[0]&15,masked=!!(buffer[1]&128);let n=buffer[1]&127,offset=2;
        if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);offset=4;}
        if(n===127){ws.destroy();return;}
        if(buffer.length<offset+(masked?4:0)+n)return;
        const key=masked?buffer.subarray(offset,offset+4):null;offset+=masked?4:0;
        const payload=Buffer.from(buffer.subarray(offset,offset+n));buffer=buffer.subarray(offset+n);
        if(masked)for(let i=0;i<payload.length;i++)payload[i]^=key[i%4];
        if(op===8){ws.end(Buffer.from([0x88,0]));return;}if(op!==1)continue;
        let j;try{j=JSON.parse(payload);}catch{continue;}
        if(j.type==='cancel'){ws.follows.delete(j.streamId);continue;}
        if(j.endpoint==='$events'){ws.eventsId=j.streamId;send(ws,{type:'item',streamId:j.streamId,value:{type:'ready',clientId:'client-test'}});}
        if(j.endpoint==='session/follow'){
          const id=j.payload.args.request.address.sessionId,s=sessions.get(id);ws.follows.set(j.streamId,id);
          send(ws,{type:'item',streamId:j.streamId,value:{type:'snapshot',cursor:(s?.events.length||0)-1,records:(s?.events||[]).map(event=>({type:'event',event})),projections:{values:{inbox:s?.inbox}}}});
        }
      }
    });
    ws.on('error',()=>{});ws.on('close',()=>sockets.delete(ws));
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  return {base:'http://127.0.0.1:'+srv.address().port,calls,sessions,disconnect:()=>{for(const w of sockets)w.destroy();},
    stop(){for(const t of timers)clearTimeout(t);for(const w of sockets)w.destroy();srv.close();}};
}
