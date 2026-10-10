import { bridgeBudgets, BUDGETS } from './budgets';
import { MCP_ENVIRONMENT } from './runtime';

/**
 * The MCP bridge an Agent runs, written into the plugin's data directory so plugin bundling need not retain source files.
 * runtimeRoot is baked in: the bridge starts Playwright MCP only from that runtime directory.
 */
export function bridgeScript(runtimeRoot:string):string{
 // Replacer functions: a "$" in a path must not be read as a replacement pattern.
 return bridgeSource
  .replace('__SERVER_BROWSER_RUNTIME_ROOT__',()=>JSON.stringify(runtimeRoot))
  .replace('__SERVER_BROWSER_BUDGETS__',()=>JSON.stringify(bridgeBudgets(BUDGETS)))
  .replace('__SERVER_BROWSER_MCP_ENVIRONMENT__',()=>JSON.stringify(MCP_ENVIRONMENT));
}

export const bridgeSource = String.raw`import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const runtimeRoot=__SERVER_BROWSER_RUNTIME_ROOT__;
const budgets=__SERVER_BROWSER_BUDGETS__;
const mcpEnvironment=__SERVER_BROWSER_MCP_ENVIRONMENT__;
const metadataPath=process.argv[2];
if(!metadataPath) throw new Error('Browser session metadata is required.');
const owner=randomUUID();
let metadata;
let child;
let ending=false;
let sequence=0;
let initializeParams;
let initialized=false;
let tabSnapshot=new Map();
const pending=new Map();
let queue=Promise.resolve();
function send(value){if(!ending)process.stdout.write(JSON.stringify(value)+'\n');}
// The plugin writes these files itself: never follow a symbolic link, never block on a FIFO, never read a large file.
async function readJson(file,maxBytes){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)throw new Error('Browser session file is not a small regular file.');
  const buffer=Buffer.alloc(maxBytes+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>maxBytes)throw new Error('Browser session file is too large.');
  return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
 }finally{await handle.close();}
}
async function readMetadata(){
 let value;
 try{value=await readJson(metadataPath,65536);}
 catch(error){if(error&&error.code==='ENOENT'){const missing=new Error('服务器浏览器尚未启动或正在恢复，请在 Paseo「服务器浏览器」面板查看状态后重试。');missing.code='ENOENT';throw missing;}throw error;}
 for(const key of ['endpoint','cdpEndpoint']){const url=new URL(value[key]);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Browser endpoints must be loopback.');}
 return value;
}
// Saved intent next to the connection file: running, and not already out of automatic recovery attempts.
async function restoring(){
 try{const saved=await readJson(join(dirname(metadataPath),'state.json'),1048576);const recent=Array.isArray(saved.recoveryAttempts)?saved.recoveryAttempts.filter(time=>typeof time==='number'&&Date.now()-time<300000).length:0;return saved.desiredRunning===true&&recent<3;}
 catch{return false;}
}
// After a plugin reload or daemon restart the panel plugin restores browsers in the background, and an Agent
// session may start first. Wait a bounded time for the connection file instead of failing MCP startup.
async function awaitMetadata(timeoutMs){
 const deadline=Date.now()+timeoutMs;
 for(;;){
  try{return await readMetadata();}
  catch(error){if(!error||error.code!=='ENOENT'||Date.now()>=deadline||!(await restoring()))throw error;await new Promise(resolve=>setTimeout(resolve,250));}
 }
}
function inside(root,file){const path=relative(root,file);return path!==''&&path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);}
// Only node_modules/@playwright/mcp/cli.js inside the runtime directory is started, whatever session.json says.
async function mcpCli(value){
 const expected=join(runtimeRoot,'node_modules','@playwright','mcp','cli.js');
 let real,wanted,root;
 try{[real,wanted,root]=await Promise.all([realpath(typeof value==='string'&&value?value:expected),realpath(expected),realpath(runtimeRoot)]);}
 catch{throw new Error('服务器浏览器的运行时目录里没有 Playwright MCP，请在 daemon 主机运行插件目录里的 scripts/setup-runtime.mjs。');}
 if(real!==wanted||!inside(root,real))throw new Error('只能启动运行时目录里的 node_modules/@playwright/mcp/cli.js，已拒绝其他脚本。');
 return real;
}
// The workspace directory is Playwright MCP's file root and the only place uploads may come from.
async function workspaceRoot(){
 const value=metadata&&metadata.workspaceDirectory;if(typeof value!=='string'||!isAbsolute(value))return null;
 try{const real=await realpath(value);return (await stat(real)).isDirectory()?real:null;}catch{return null;}
}
function childEnvironment(){
 const names=new Set(mcpEnvironment.names),env={};
 for(const [key,value] of Object.entries(process.env))if(value!==undefined&&(names.has(key)||mcpEnvironment.prefixes.some(prefix=>key.startsWith(prefix))))env[key]=value;
 return env;
}
async function launch(value){
 const cli=await mcpCli(value.mcpCli);
 const previous=child;
 child=undefined;
 previous?.kill('SIGTERM');
 metadata=value;
 const cwd=await workspaceRoot();
 const processChild=spawn(process.execPath,[cli,'--cdp-endpoint',metadata.cdpEndpoint,'--headless','--idle-timeout','0','--no-webmcp','--output-dir',metadata.artifactDir,'--timeout-action','15000','--timeout-navigation','45000'],{stdio:['pipe','pipe','pipe'],env:childEnvironment(),...(cwd?{cwd}:{})});
 child=processChild;
 processChild.stderr.on('data',chunk=>process.stderr.write(chunk));
 const output=createInterface({input:processChild.stdout});
 output.on('line',line=>{
  if(processChild!==child)return;
  let value;try{value=JSON.parse(line);}catch{return;}
  const item=pending.get(value.id);
  if(item){clearTimeout(item.timer);pending.delete(value.id);value.error?item.reject(new Error(value.error.message||'Browser call failed.')):item.resolve(value.result);}
  else send(value);
 });
 function stopped(){if(processChild!==child)return;child=undefined;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Browser MCP exited. Please retry.'));}pending.clear();output.close();}
 processChild.on('error',error=>{process.stderr.write(error.message+'\n');stopped();});
 processChild.on('exit',stopped);
}
function callChild(method,params,timeoutMs){
 if(!child)return Promise.reject(new Error('Browser MCP is unavailable.'));
 const id='server-browser-internal-'+(++sequence);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser tool timed out.'));child?.kill('SIGTERM');},timeoutMs);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
}
async function ensureChild(){
 const fresh=await awaitMetadata(5000);
 if(child&&fresh.cdpEndpoint===metadata?.cdpEndpoint&&fresh.endpoint===metadata?.endpoint&&fresh.workspaceDirectory===metadata?.workspaceDirectory){metadata=fresh;return;}
 await launch(fresh);
 if(initializeParams){await callChild('initialize',initializeParams,budgets.mcpCallMs);if(initialized)child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');}
}
// Each route has its own wait, a little longer than the server spends on it, so a lease is never left with nobody holding it.
const controlTimeouts={read:budgets.readMs,diagnostics:budgets.readMs,tabs:budgets.tabsMs};
async function control(action,extra={}){
 const fresh=await readMetadata();
 const response=await fetch(fresh.endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+fresh.token},body:JSON.stringify({...extra,workspaceId:fresh.workspaceId,owner,pid:process.pid}),signal:AbortSignal.timeout(controlTimeouts[action]||budgets.controlMs)});
 const data=await response.json(); if(!response.ok)throw new Error(data.error||'Browser control request failed.'); return data;
}
// Playwright MCP 0.0.82 tools the shared browser offers. Any other tool, including ones a later MCP adds, is refused.
const readonlyTools=new Set(['browser_snapshot','browser_find','browser_wait_for','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_network_request']);
const writeTools=new Set(['browser_navigate','browser_navigate_back','browser_click','browser_type','browser_fill_form','browser_press_key','browser_select_option','browser_hover','browser_drag','browser_drop','browser_file_upload','browser_handle_dialog','browser_evaluate','browser_resize','browser_emulate_media','browser_tabs']);
// These read local files and hand them to the page.
const fileTools=new Set(['browser_file_upload','browser_drop']);
// Arbitrary Node.js in the Playwright MCP process is not a browsing tool: it would outlive manual takeover and act as the daemon user.
const unsafeTools=new Set(['browser_run_code_unsafe','browser_run_code']);
const serverInstructions='This MCP controls the shared browser running on the Linux server, visible in the Paseo Server Browser panel. Prefer it for shared-browser tasks; other browser servers have separate sessions. Manual takeover blocks writes: wait for the user, never bypass with shell or another browser. Use browser_read_page for article text and browser_diagnostics for page/network/login problems. Missing explicit tab targets fail instead of selecting another page. File uploads must be regular files inside the workspace directory.';
const extraTools=[
 {name:'browser_read_page',description:'Read the current or explicit shared tab as clean article Markdown or visible text, optionally filtered by literal text. No navigation or modification. Reports truncation and extraction method.',inputSchema:{type:'object',properties:{tabId:{type:'string'},mode:{type:'string',enum:['article','visible'],default:'article'},selector:{type:'string',maxLength:500},query:{type:'string',maxLength:200},maxChars:{type:'integer',minimum:500,maximum:60000,default:16000}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
 {name:'browser_diagnostics',description:'Inspect shared browser/runtime and visible network/login signals. Does not navigate, refresh or expose cookies. Accessible pages do not prove successful authentication.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}},
];
function textResult(value){return {content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]};}
function refusal(id,text){send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text}]}});}
function toolCatalog(result){return {...result,tools:[...(result.tools||[]).filter(t=>readonlyTools.has(t.name)||writeTools.has(t.name)).map(tool=>tool.name==='browser_tabs'?{...tool,description:'List, create, select or close shared tabs. Prefer stable tabId from list for select/close. Index refers to the last listed snapshot; closed targets fail rather than selecting another page.',inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,tabId:{type:'string',description:'Stable tab ID from browser_tabs list; preferred over index'}}}}:tool),...extraTools]};}
function rememberTabs(result){const tabs=result.tabs||result.session?.tabs||[];tabSnapshot=new Map(tabs.map((tab,index)=>[index,tab.id]));return result;}
// Every path must be a regular file (not a symbolic link) whose real path is inside the workspace directory.
// Relative paths are read from the workspace directory, as Playwright MCP does. The checked real paths are what MCP receives.
async function workspaceFiles(paths){
 if(!Array.isArray(paths))throw new Error('paths 必须是文件路径数组。');
 const root=await workspaceRoot();
 if(!root)throw new Error('服务器浏览器没有这个工作区的目录信息，不能上传文件。请在 Paseo 面板重新启动这个工作区的浏览器后重试。');
 const checked=[];
 for(const item of paths){
  if(typeof item!=='string'||!item||item.includes('\u0000'))throw new Error('上传路径无效。');
  const candidate=resolve(root,item);
  let info;try{info=await lstat(candidate);}catch{throw new Error('找不到要上传的文件：'+item);}
  if(info.isSymbolicLink())throw new Error('不能上传符号链接：'+item+'。请改用工作区里的真实文件。');
  if(!info.isFile())throw new Error('只能上传普通文件：'+item);
  const real=await realpath(candidate);
  if(!inside(root,real))throw new Error('只能上传当前工作区目录里的文件：'+item);
  checked.push(real);
 }
 return checked;
}
function withoutRoots(params){const capabilities={...(params&&params.capabilities||{})};delete capabilities.roots;return {...params,capabilities};}
async function handle(message){
 if(!message.method){child?.stdin.write(JSON.stringify(message)+'\n');return;}
 if(message.method==='initialize'){
  // Playwright MCP resolves and confines file names against its working directory, the workspace; not the client's roots.
  initializeParams=withoutRoots(message.params);
  await launch(await awaitMetadata(Number(process.env.PASEO_SERVER_BROWSER_BRIDGE_WAIT_MS)||20000));
  const result=await callChild(message.method,initializeParams,budgets.mcpCallMs);
  send({jsonrpc:'2.0',id:message.id,result:{...result,instructions:serverInstructions+'\n'+(result.instructions||'')}});return;
 }
 if(message.method==='notifications/roots/list_changed')return;
 if(message.method!=='tools/call'){
  if(message.method==='notifications/initialized')initialized=true;
  await ensureChild();
  if(message.id!==undefined){const result=await callChild(message.method,message.params,budgets.mcpCallMs);send({jsonrpc:'2.0',id:message.id,result:message.method==='tools/list'?toolCatalog(result):result});}
  else child.stdin.write(JSON.stringify(message)+'\n');
  return;
 }
 const name=message.params?.name;
 const args=message.params?.arguments||{};
 if(name==='browser_diagnostics'||name==='browser_read_page'){
  try{const value=await control(name==='browser_diagnostics'?'diagnostics':'read',{...args,toolName:name});send({jsonrpc:'2.0',id:message.id,result:textResult(value)});}
  catch(error){refusal(message.id,error.message||'Browser inspection failed.');}
  return;
 }
 if(name==='browser_close'||name==='browser_install'){refusal(message.id,'浏览器由 Paseo 共享面板管理。请通过面板停止或启动，不能由 Agent 关闭共享浏览器。');return;}
 if(unsafeTools.has(name)){refusal(message.id,'共享浏览器不提供在 MCP 进程中执行任意代码的工具。请改用 browser_evaluate（只在网页内执行）或其他浏览器工具。');return;}
 if(!readonlyTools.has(name)&&!writeTools.has(name)){refusal(message.id,'共享浏览器不提供工具 '+String(name)+'。请使用工具列表里的浏览器工具。');return;}
 const write=!readonlyTools.has(name)&&!(name==='browser_tabs'&&args.action==='list');
 let lease;
 try{
  await ensureChild();
  let forwarded=args;
  if(fileTools.has(name)&&args.paths!==undefined)forwarded={...args,paths:await workspaceFiles(args.paths)};
  let tabId=args.tabId;
  if(name==='browser_tabs'&&['select','close'].includes(args.action)&&args.index!==undefined&&!tabId){
   if(!Number.isInteger(args.index)||!tabSnapshot.has(args.index))throw new Error('标签序号没有对应的已确认目标。请先 browser_tabs list，再使用返回的稳定 tabId。');
   tabId=tabSnapshot.get(args.index);
  }
  // The server checks the address with the panel's rules and returns the normalized one; MCP only ever gets that.
  lease=await control('acquire',{write,toolName:name,...(name==='browser_navigate'?{url:args.url}:{}),...(name==='browser_tabs'?{tabAction:args.action}:{}),...(tabId?{tabId}:{}),createTab:name==='browser_tabs'&&args.action==='new',closeTab:name==='browser_tabs'&&args.action==='close'});
  if(name==='browser_navigate'){if(typeof lease.url!=='string')throw new Error('服务器没有确认导航地址，已停止。');forwarded={...args,url:lease.url};}
  if(name==='browser_tabs'){
   const result=await control('tabs',{leaseId:lease.leaseId,action:args.action,tabId,url:args.url});
   await control('release',{leaseId:lease.leaseId,failed:false});lease=undefined;
   send({jsonrpc:'2.0',id:message.id,result:textResult(rememberTabs(result))});return;
  }
  const selected=await control('validate',{leaseId:lease.leaseId});
  if(!Number.isInteger(selected.activeIndex)||selected.activeIndex<0)throw new Error('目标标签页已经关闭，请重新查看标签列表。不会自动切换到其他网页。');
  // Populate Playwright MCP's lazy tab list before selecting an existing CDP target.
  const listing=await callChild('tools/call',{name:'browser_tabs',arguments:{action:'list'}},budgets.mcpInternalMs);
  if(listing.isError)throw new Error('无法读取共享浏览器标签页，请重试连接。');
  const selection=await callChild('tools/call',{name:'browser_tabs',arguments:{action:'select',index:selected.activeIndex}},budgets.mcpInternalMs);
  if(selection.isError)throw new Error('无法选择共享浏览器的目标标签页：'+(selection.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\n'));
  const validated=await control('validate',{leaseId:lease.leaseId});
  if(validated.activeTargetId!==selected.activeTargetId||validated.activeIndex!==selected.activeIndex)throw new Error('标签列表在操作前发生变化，请刷新后重试。');
  const result=await callChild(message.method,{...message.params,arguments:forwarded},budgets.mcpCallMs);
  await control('release',{leaseId:lease.leaseId,failed:result.isError===true});lease=undefined;
  send({jsonrpc:'2.0',id:message.id,result});
 }catch(error){refusal(message.id,error instanceof Error?error.message:'Browser call failed.');}
 finally{if(lease)await control('release',{leaseId:lease.leaseId,failed:true}).catch(()=>{});}
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 let value;try{value=JSON.parse(line);}catch{return;}
 // Replies to child-initiated requests must not sit behind the request waiting on them.
 if(!value.method){child?.stdin.write(JSON.stringify(value)+'\n');return;}
 queue=queue.then(()=>handle(value)).catch(error=>{if(value.id!==undefined)send({jsonrpc:'2.0',id:value.id,error:{code:-32603,message:error.message}});});
});
async function shutdown(){if(ending)return;ending=true;child?.kill('SIGTERM');await control('disconnect').catch(()=>{});input.close();}
input.on('close',()=>{void shutdown();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void shutdown().finally(()=>process.exit(0));});
`;
