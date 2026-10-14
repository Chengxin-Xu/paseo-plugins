import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserActivityLog, activityAction, activityUrl } from '../server/activity';
import { TestBrowserManager as BrowserManager } from './manual-action';
import { defaultRuntimeRoot } from '../server/runtime';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('activity metadata is bounded, fixed-label, and excludes URL credentials, query and fragment',()=>{
 const log=new BrowserActivityLog();
 assert.equal(activityAction('browser_type'),'输入文字');
 assert.equal(activityAction('browser_tabs','select'),'切换标签');
 assert.equal(activityAction('secret arbitrary input'),'浏览器操作');
 assert.equal(activityAction('__proto__'),'浏览器操作');
 assert.equal(activityUrl('https://name:password@example.test/work?token=private#fragment'),'https://example.test/work');
 for(let i=0;i<20;i++){
  const id=log.start('manual','text',{tabId:'one',pageTitle:'A'.repeat(240),pageUrl:'https://example.test/work?token=private#fragment'});
  log.finish(id,false);
 }
 assert.equal(log.snapshot().length,12);
 assert(log.snapshot().every(item=>item.pageTitle.length===160&&item.action==='输入文字'&&item.status==='completed'&&item.endedAt!==null));
 const active=log.start('agent',undefined,{tabId:'two',pageTitle:'Page https://example.test/work?secret=yes#hidden',pageUrl:'file:///private/path'});
 log.failRunning();
 const result=log.snapshot().find(item=>item.id===active)!;
 assert.equal(result.status,'failed');assert.equal(result.pageUrl,'本地页面');
 assert(!JSON.stringify(result).includes('secret'));assert(!JSON.stringify(result).includes('hidden'));
});

test('manual and Agent browser activity remains private, per-workspace, and completes or fails with its original target', {timeout:45_000},async()=>{
 const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-activity-test-'));
 const manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
 const workspaceId='activity-test',otherWorkspace='activity-other';
 const secret='sensitive-'+randomBytes(16).toString('hex');
 const site=createServer((request,response)=>{
  const second=request.url?.startsWith('/second');
  response.setHeader('content-type','text/html; charset=utf-8');
  response.setHeader('set-cookie',`activity_test_cookie=${secret}; HttpOnly; SameSite=Lax`);
  response.end(`<!doctype html><title>${second?'Second activity page':'First activity page'}</title><main><h1>Activity test</h1><p>A synthetic local website for activity verification.</p><input autofocus aria-label="Text"><button>Continue</button></main>`);
 });
 await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
 const address=site.address();assert(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 let processForLease:ReturnType<typeof spawn>|undefined;
 async function control(route:string,extra:Record<string,unknown>={}){
  const metadata=JSON.parse(await readFile(manager.metadataPath(workspaceId),'utf8'));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
  try{const response=await fetch(`${metadata.endpoint}/${route}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${metadata.token}`},body:JSON.stringify({workspaceId,owner:'activity-test-owner',pid:process.pid,...extra}),signal:controller.signal});return {status:response.status,body:await response.json() as Record<string,any>};}
  finally{clearTimeout(timer);}
 }
 try{
  await manager.start(workspaceId);
  await manager.action(workspaceId,{kind:'navigate',url:`${origin}/first?token=${secret}#fragment-${secret}`});
  await manager.action(workspaceId,{kind:'text',text:secret});
  let state=await manager.state(workspaceId);const firstId=state.tabs.find(tab=>tab.active)!.id;
  const typed=state.activity?.find(item=>item.action==='输入文字');assert(typed);assert.equal(typed.source,'manual');assert.equal(typed.status,'completed');
  assert.equal(typed.pageUrl,`${origin}/first`);
  assert(!JSON.stringify(state.activity).includes(secret),'Text values, query/fragment and cookies never enter activity');
  const beforePoll=state.activity!.map(item=>item.id);
  await manager.frame(workspaceId);await manager.state(workspaceId);
  assert.deepEqual((await manager.state(workspaceId)).activity!.map(item=>item.id),beforePoll,'Polling never creates activity');

  await manager.action(workspaceId,{kind:'newTab'});
  await manager.action(workspaceId,{kind:'navigate',url:`${origin}/second?token=${secret}`});
  const secondId=(await manager.state(workspaceId)).tabs.find(tab=>tab.active)!.id;
  const beforeSwitch=await manager.state(workspaceId),seen={tabId:secondId,viewRevision:beforeSwitch.viewRevision!};
  const queued=await Promise.allSettled([manager.action(workspaceId,{kind:'tab',tabId:firstId},seen),manager.action(workspaceId,{kind:'text',text:secret},seen)]);
  assert.equal(queued[0].status,'fulfilled');assert.equal(queued[1].status,'rejected','The queued input cannot silently switch to the preceding action\'s target');
  await manager.action(workspaceId,{kind:'text',text:secret});
  const queuedInput=(await manager.state(workspaceId)).activity![0];
  assert.equal(queuedInput.action,'输入文字');assert.equal(queuedInput.tabId,firstId,'A newly refreshed input records the page the viewer actually selected');
  await manager.action(workspaceId,{kind:'tab',tabId:secondId});
  await manager.action(workspaceId,{kind:'mode',mode:'agent'});
  const lease=await control('acquire',{write:true,tabId:firstId,toolName:'browser_click'});assert.equal(lease.status,200);
  state=await manager.state(workspaceId);
  const running=state.activity!.find(item=>item.source==='agent'&&item.status==='running')!;
  assert(running);assert.equal(running.action,'点击页面');assert.equal(running.tabId,firstId);assert.equal(state.tabs.find(tab=>tab.active)?.id,secondId);
  assert.equal((await control('release',{leaseId:lease.body.leaseId,failed:false})).status,200);
  const completed=(await manager.state(workspaceId)).activity!.find(item=>item.id===running.id)!;
  assert.equal(completed.status,'completed');assert.equal(completed.tabId,firstId);assert.equal(completed.pageTitle,'First activity page');assert.equal(completed.pageUrl,`${origin}/first`);

  const oldBridge=await control('acquire',{write:false,tabId:firstId});assert.equal(oldBridge.status,200);
  await control('release',{leaseId:oldBridge.body.leaseId,failed:true,error:secret});
  const generic=(await manager.state(workspaceId)).activity![0];assert.equal(generic.action,'浏览器操作');assert.equal(generic.status,'failed');
  assert(!JSON.stringify(generic).includes(secret));
  await manager.action(workspaceId,{kind:'mode',mode:'manual'});
  await assert.rejects(manager.action(workspaceId,{kind:'click',x:-10,y:0}));
  assert.equal((await manager.state(workspaceId)).activity![0].status,'failed');
  await control('read',{tabId:firstId,mode:'visible',maxChars:1000});
  let latest=(await manager.state(workspaceId)).activity![0];assert.equal(latest.source,'agent');assert.equal(latest.action,'阅读网页');assert.equal(latest.status,'completed');
  await manager.diagnostics(workspaceId);latest=(await manager.state(workspaceId)).activity![0];assert.equal(latest.source,'manual');assert.equal(latest.action,'查看页面诊断');

  await manager.start(otherWorkspace);assert.deepEqual((await manager.state(otherWorkspace)).activity,[]);
  assert(!(await readFile(path.join(dataRoot,workspaceId,'state.json'),'utf8')).includes('activity'),'Activities are not persisted');

  processForLease=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});assert(processForLease.pid);
  const orphan=await control('acquire',{write:false,tabId:firstId,toolName:'browser_take_screenshot',pid:processForLease.pid});assert.equal(orphan.status,200);
  const orphanId=(await manager.state(workspaceId)).activity![0].id;
  const exited=new Promise<void>(resolve=>processForLease!.once('exit',()=>resolve()));processForLease.kill('SIGTERM');await exited;
  assert.equal((await manager.state(workspaceId)).activity!.find(item=>item.id===orphanId)?.status,'failed','Dead bridge processes cannot leave activities running');
  processForLease=undefined;

  await manager.action(workspaceId,{kind:'settings',settings:{autoRecover:false}});
  const crashLease=await control('acquire',{write:false,toolName:'browser_take_screenshot'});assert.equal(crashLease.status,200);
  const crashActivity=(await manager.state(workspaceId)).activity![0].id;
  const metadata=JSON.parse(await readFile(manager.metadataPath(workspaceId),'utf8'));
  const argv=(await readFile(`/proc/${metadata.browserPid}/cmdline`,'utf8')).split('\0');
  const actual=argv.join(' ').match(/(?:^| )--user-data-dir=([^\s]+)/)?.[1];assert(actual,'Missing test profile argument');
  assert.equal(await realpath(actual),await realpath(path.join(dataRoot,workspaceId,'profile')),'Only the temporary test Chromium may be signalled');
  process.kill(metadata.browserPid,'SIGKILL');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&(await manager.state(workspaceId)).status!=='error')await pause(50);
  const failedState=await manager.state(workspaceId);
  assert.equal(failedState.activity!.find(item=>item.id===crashActivity)?.status,'failed');
  assert(failedState.activity!.every(item=>item.status!=='running'));
  assert.deepEqual((await manager.state(otherWorkspace)).activity,[],'Another workspace never receives the crashed workspace activity');
 }finally{
  processForLease?.kill('SIGTERM');await manager.close();site.closeAllConnections();await new Promise<void>(resolve=>site.close(()=>resolve()));await rm(dataRoot,{recursive:true,force:true});
 }
});
