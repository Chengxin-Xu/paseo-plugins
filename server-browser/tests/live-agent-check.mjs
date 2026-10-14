/** Actual Agent + installed plugin acceptance on the dedicated local demo workspace. */
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

import { invokeBrowserRpc, dataRoot, daemonUrl, testValue, testWorkspace } from './live-config.mjs';

const workspaceId=testWorkspace({aliases:['BROWSER_AGENT_WORKSPACE']});
const resuming=process.env.BROWSER_AGENT_RESUME==='1';
const profileId=resuming?undefined:testValue('BROWSER_AGENT_PROFILE');
const resumeAgentId=resuming?testValue('BROWSER_AGENT_ID'):undefined;
const output=path.resolve('artifacts');await mkdir(output,{recursive:true});
const daemon=new DaemonClient({url:daemonUrl,clientId:'shared-browser-agent-acceptance',clientType:'cli'});
const paseo=createPaseoApi(daemon);
const rpc=(method,input)=>invokeBrowserRpc(daemon,method,input);
const report=resuming?JSON.parse(await readFile(path.join(output,'live-agent-report.json'),'utf8')):{startedAt:new Date().toISOString(),workspaceId,approvedTestCalls:[]};
if(resuming){assert.equal(report.workspaceId,workspaceId,'Saved report workspace differs from explicit BROWSER_TEST_WORKSPACE');assert.equal(report.agentId,resumeAgentId,'Saved report Agent differs from explicit BROWSER_AGENT_ID');}
delete report.error;
let unsubscribe,oracle;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitRun(agent,result){
 for(let i=0;i<30&&result.status==='permission';i++){
  const requests=result.final?.pendingPermissions||[];
  assert(requests.length,'Permission result has no permission request');
  for(const request of requests){
   assert(request.kind==='tool'&&/server_browser/.test(request.name),'Unexpected permission outside browser acceptance: '+request.name);
   assert(/browser_(snapshot|find|read_page|diagnostics|click|type|fill_form|evaluate|take_screenshot|wait_for|tabs)/.test(request.name),'Unexpected browser test permission: '+request.name);
   await agent.respondToPermission({requestId:request.id,response:{behavior:'allow'}});
   report.approvedTestCalls.push(request.name);
  }
  await sleep(250);result=await agent.waitForFinish(600000);
 }
 assert.equal(result.status,'idle',JSON.stringify({status:result.status,error:result.error}));return result;
}
async function connectOracle(){
 const meta=JSON.parse(await readFile(path.join(dataRoot,workspaceId,'session.json'),'utf8'));
 const targets=await fetch(meta.cdpEndpoint+'/json/list').then(r=>r.json());
 const target=targets.find(t=>t.type==='page'&&/互动体验/.test(t.title));assert(target,'Local demo page missing');
 const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 const pending=new Map();let id=0;
 socket.addEventListener('message',event=>{const value=JSON.parse(String(event.data));const p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(new Error(value.error.message)):p.resolve(value.result);}});
 return {close:()=>socket.close(),read:async()=>{
  const next=++id;const result=await new Promise((resolve,reject)=>{pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method:'Runtime.evaluate',params:{expression:"({name:document.querySelector('#visitor').value,greeting:document.querySelector('#greeting').textContent,count:document.querySelector('#count').textContent,challenge:document.querySelector('#challenge').textContent,result:document.querySelector('#result').textContent,platform:navigator.platform})",returnByValue:true}}));});
  return result.result.value;
 }};
}
try{
 await daemon.connect();
 if(!resuming){await rpc('browser.start',{workspaceId});
  await rpc('browser.action',{workspaceId,action:{kind:'mode',mode:'manual'}});
  await rpc('browser.action',{workspaceId,action:{kind:'viewport',width:1120,height:720}});
  await rpc('browser.action',{workspaceId,action:{kind:'demo'}});
 }
 const created=resuming?{agentId:resumeAgentId}:await rpc('browser.agent',{workspaceId,profileId});
 report.agentId=created.agentId;const agent=paseo.agents.ref(created.agentId);await agent.refresh();
 unsubscribe=agent.timeline.subscribe(event=>{void appendFile(path.join(output,'shared-agent-timeline.jsonl'),JSON.stringify(event)+'\n');});await unsubscribe.ready;
 if(!resuming&&(agent.status==='running'||agent.status==='initializing'))await waitRun(agent,await agent.waitForFinish(600000));
 await rpc('browser.action',{workspaceId,action:{kind:'mode',mode:'agent'}});
 oracle=await connectOracle();
 const prompt='请实际验收0.2版共享服务器浏览器。只使用 server_browser MCP，禁止shell、脚本进程、Paseo原生浏览器或其他工具，也不要导航离开当前本地互动体验页。先必须调用新增browser_diagnostics检查当前页面，再调用browser_read_page(mode=visible,query=Agent,maxChars=1000)读取相关正文并汇报提取方法。然后用browser_snapshot读交互元素。把「你的名字」输入框填成「Agent 与手机同屏」，点击「打个招呼」；点击「计数 +1」恰好两次；读取页面随机六位验证码，填入「验证码」输入框并点击「验证」。最后再用快照确认问候语、计数2和PASS，并截图。不关闭浏览器、不创建Agent、不修改设置。仅根据真实工具结果中文汇报，失败要如实说。';
 const result=await waitRun(agent,resuming?await agent.waitForFinish(600000):await agent.run(prompt,{timeoutMs:600000}));report.agentMessage=result.lastMessage;
 const state=await oracle.read();report.serverPage=state;
 assert.equal(state.name,'Agent 与手机同屏');assert.match(state.greeting,/Agent 与手机同屏/);assert.equal(state.count,'2');assert.match(state.result,/PASS/);assert.match(state.platform,/Linux/);
 const frame=await rpc('browser.frame',{workspaceId});assert(frame.frame?.dataUrl.startsWith('data:image/jpeg'));
 await writeFile(path.join(output,'agent-shared-page.jpg'),Buffer.from(frame.frame.dataUrl.split(',')[1],'base64'));
 report.frame={width:frame.frame.width,height:frame.frame.height,bytes:Buffer.from(frame.frame.dataUrl.split(',')[1],'base64').length};
 const history=await agent.timeline.refetch({limit:160});await writeFile(path.join(output,'shared-agent-history.json'),JSON.stringify(history,null,2));
 // Test the actual Agent's normal tool path against the manual takeover guard.
 await rpc('browser.action',{workspaceId,action:{kind:'mode',mode:'manual'}});
 const blocked=await waitRun(agent,await agent.run('现在面板处于手动接管模式。请先调用一次 server_browser 的browser_snapshot：预期被拒绝，并提示改用截图。再用前面读到的「计数 +1」按钮引用实际调用一次browser_click进行接管保护验收：预期同样被拒绝，网页计数仍为2。不要切换模式、不要换用其他工具、不要重试。请报告两次的实际错误。',{timeoutMs:600000}));
 report.takeoverMessage=blocked.lastMessage;assert.equal((await oracle.read()).count,'2');
 assert(/手动|拒绝|阻止|接管/.test(blocked.lastMessage||''));
 report.passed=true;report.finishedAt=new Date().toISOString();
 console.log(JSON.stringify(report,null,2));
}catch(error){report.passed=false;report.error=error.stack||String(error);console.error(report.error);process.exitCode=1;}
finally{unsubscribe?.();oracle?.close();await writeFile(path.join(output,'live-agent-report.json'),JSON.stringify(report,null,2)+'\n');await daemon.close();}
