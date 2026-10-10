import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aibox-receipt-'));
process.env.AIBOX_HOME=tmp;process.env.AIBOX_ROOT=path.join(tmp,'router');
try {
 const mgr=await import('../src/manager/core.mjs');
 const {localBase}=await import('../src/agent/service-client.mjs');
 const item=mgr.mailboxAdd('追加手机使用说明','note',{chat:'owner',runId:'r1'});
 assert.equal(mgr.mailboxUnread().length,1);
 mgr.receipt([item.id],'accepted',{sessionId:'s1',runId:'r1'});
 assert.equal(mgr.mailboxUnread().length,1,'RPC 接受不算已读');
 const cli=new URL('../src/tools/mailbox.mjs',import.meta.url);
 const run=(...args)=>spawnSync(process.execPath,[fileURLToPath(cli),...args],{encoding:'utf8',env:process.env});
 assert.notEqual(run('--ack',item.id,'--session','s1').status,0,'接入前不能声明已处理');
 mgr.receipt([item.id],'delivered',{sessionId:'s1'});
 assert.equal(mgr.mailboxUnread().length,0);
 assert.notEqual(run('--ack',item.id,'--session','s2').status,0,'其他会话不能确认');
 assert.equal(run('--session','s1').status,0);
 assert.equal(mgr.mailboxAll()[0].delivery,'delivered','阅读不自动确认已处理');
 assert.equal(run('--ack',item.id,'--session','s1').status,0);
 mgr.receipt([item.id],'pending');mgr.receipt([item.id],'accepted');
 assert.equal(mgr.mailboxAll()[0].delivery,'applied','回执不可倒退');
 const n=fs.readFileSync(path.join(tmp,'.aibox/mgr/delivery.jsonl'),'utf8').trim().split('\n').length;
 assert.equal(run('--ack',item.id,'--session','s1').status,0);
 assert.equal(fs.readFileSync(path.join(tmp,'.aibox/mgr/delivery.jsonl'),'utf8').trim().split('\n').length,n,'重复确认幂等');
 assert.throws(()=>localBase('http://192.0.2.10:3081'));   // 文档保留地址（RFC 5737）：非本机地址必须被拒
 assert.equal(localBase('http://127.0.0.1:3081/'),'http://127.0.0.1:3081');
 console.log('accepted≠delivered; reading≠applied; scope/idempotency/loopback verified');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
