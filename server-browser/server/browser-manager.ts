import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BrowserConnection as Browser, BrowserContext, BrowserPage as Page } from './browser-types';
import { browserSettingsSchema, readPageInputSchema, type BrowserAction, type BrowserFrameQuality, type BrowserFrameResult, type BrowserSession, type BrowserSettings, type BrowserHealth, type BrowserReading, type BrowserReadInput, type BrowserActivity } from '../shared/browser';
import { bridgeSource } from './bridge-source';
import { demoHtml } from './demo';
import { maintainArtifacts } from './artifacts';
import { readPageContent } from './reading';
import { BrowserActivityLog, type ActivityPage } from './activity';
import { setVerifiedViewport } from './viewport';
import { captureBrowserFrame, frameScale, type FrameLimits } from './frame';
import { sessionRevision } from './revision';
import { fitPageWidth } from './page-fit';
import { browserProxy, browserSandbox, chromiumArguments, defaultRuntimeRoot, missingChromium, missingRuntime } from './runtime';

type PlaywrightRuntime={chromium:{connectOverCDP(endpoint:string,options?:{timeout?:number}):Promise<Browser>;executablePath():string}};
type Lease={id:string;owner:string;pid:number;write:boolean;targetId:string|null;epoch:number;activityId:string;activityTargetId:string|null};
type SavedTab={url:string;demo:boolean;pinned:boolean;active:boolean};
type PageState={url:string;title:string;demo:boolean;pinned:boolean;httpStatus:number|null;requestFailure:string|null};
type SavedState={version:2;desiredRunning:boolean;mode:BrowserSession['mode'];width:number;height:number;tabs:SavedTab[];settings:BrowserSettings;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[]};
type LiveSession={
 workspaceId:string;status:BrowserSession['status'];mode:BrowserSession['mode'];width:number;height:number;agentId:string|null;error:string|null;
 browser?:Browser;context?:BrowserContext;child?:ChildProcess;cdpEndpoint?:string;
 pages:Map<string,Page>;pageState:Map<string,PageState>;pendingPages:Map<Page,Promise<string>>;trackTail:Promise<void>;activeId:string|null;
 starting?:Promise<void>;loading?:Promise<void>;tail:Promise<void>;persistTail:Promise<void>;loaded:boolean;desiredRunning:boolean;settings:BrowserSettings;savedTabs:SavedTab[];
 frameTask?:Promise<BrowserFrameResult['frame']>;resizing?:Promise<void>;lastFrame?:NonNullable<BrowserFrameResult['frame']>;frameKey?:string;frameTabId?:string;
 leases:Map<string,Lease>;controlPending:boolean;manualBusy:boolean;stopping:boolean;generation:number;epoch:number;health:BrowserHealth|null;uptimeStart:number|null;
 activity:BrowserActivityLog;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[];recoveryTimer?:ReturnType<typeof setTimeout>;
 persistTimer?:ReturnType<typeof setTimeout>;artifactTask?:Promise<void>;artifactBytes:number;artifactCount:number;cleanedArtifacts:number;
};
export type BrowserManagerOptions={runtimeRoot?:string;dataRoot?:string;executablePath?:string};
export type BrowserDiagnostics={session:BrowserSession;checks:{name:string;status:'ok'|'warning'|'error';detail:string}[];health:BrowserHealth};
const DEFAULT_SETTINGS:BrowserSettings={autoRecover:true,maxTabs:20,maxArtifactMB:256,artifactMaxAgeHours:48};
const FRAME_QUALITY:Record<BrowserFrameQuality,{quality:number;cache:number}>={smooth:{quality:35,cache:180},balanced:{quality:55,cache:450},sharp:{quality:80,cache:900}};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const safeId=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw new Error('工作区标识无效。');return id;};
const safeFailure=(error:unknown)=>{
 const text=error instanceof Error?error.message:String(error??'');
 if(/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(text))return 'DNS 域名解析失败，请检查服务器网络与 DNS。';
 if(/CERT_|SSL_|TLS|certificate/i.test(text))return 'TLS / 证书校验失败，请检查服务器证书与网络。';
 if(/timed? ?out|Timeout/i.test(text))return '页面或浏览器连接超时，请检查服务器网络和目标站点。';
 if(/ERR_CONNECTION|ECONN|ENETUNREACH|ERR_INTERNET|ERR_PROXY/i.test(text))return '网络连接失败，请检查服务器网络或代理配置。';
 return text.replace(/https?:\/\/[^\s"'<>]+/gi,'[网页地址]').slice(0,220)||'浏览器操作失败。';
};
function safeRestoreUrl(value:unknown):string|null{
 if(typeof value!=='string')return null;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():null;}catch{return null;}
}
export function normalizeNavigationUrl(value:string):string{
 const trimmed=value.trim();if(!trimmed||/[\u0000-\u001f]/.test(trimmed))throw new Error('请输入有效的网页地址。');
 const explicitScheme=/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed),hostWithPort=/^(localhost|[\w.-]+):\d+(?:[/?#]|$)/i.test(trimmed);
 const url=new URL(explicitScheme&&!hostWithPort?trimmed:`https://${trimmed}`);
 if(!['http:','https:'].includes(url.protocol))throw new Error('只支持 HTTP 或 HTTPS 网页。');
 if(url.username||url.password)throw new Error('请在网页内登录，不要在地址中填写密码。');return url.toString();
}

export class BrowserManager{
 readonly runtimeRoot:string;readonly dataRoot:string;readonly bridgePath:string;
 private sessions=new Map<string,LiveSession>();private gate?:Server;private gateEndpoint?:string;private gateStarting?:Promise<void>;
 private token=randomBytes(32).toString('hex');private disposed=false;private runtime?:PlaywrightRuntime;private executableOverride?:string;
 private maintenanceTimer?:ReturnType<typeof setInterval>;private restoring?:Promise<void>;
 constructor(options:BrowserManagerOptions={}){
  this.runtimeRoot=options.runtimeRoot??defaultRuntimeRoot();
  this.dataRoot=options.dataRoot??(process.env.PASEO_SERVER_BROWSER_DATA||path.join(this.runtimeRoot,'visual'));this.bridgePath=path.join(this.dataRoot,'mcp-bridge.mjs');
  this.executableOverride=options.executablePath??process.env.PASEO_SERVER_BROWSER_EXECUTABLE;
 }
 metadataPath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'session.json');}
 private statePath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'state.json');}
 private artifactDir(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'artifacts');}
 private session(workspaceId:string):LiveSession{
  safeId(workspaceId);let session=this.sessions.get(workspaceId);
  if(!session){session={workspaceId,status:'idle',mode:'manual',width:1120,height:720,agentId:null,error:null,pages:new Map(),pageState:new Map(),pendingPages:new Map(),trackTail:Promise.resolve(),activeId:null,tail:Promise.resolve(),persistTail:Promise.resolve(),loaded:false,desiredRunning:false,settings:{...DEFAULT_SETTINGS},savedTabs:[],leases:new Map(),controlPending:false,manualBusy:false,stopping:false,generation:0,epoch:0,health:null,uptimeStart:null,activity:new BrowserActivityLog(),recoveryCount:0,lastRecoveredAt:null,lastFailure:null,recoveryAttempts:[],artifactBytes:0,artifactCount:0,cleanedArtifacts:0};this.sessions.set(workspaceId,session);}return session;
 }
 private activityPage(session:LiveSession,tabId:string|null):ActivityPage{
  const page=tabId?session.pages.get(tabId):undefined,info=tabId?session.pageState.get(tabId):undefined;
  return {tabId,pageTitle:info?.title??'',pageUrl:page&&!page.isClosed()?page.url():info?.url??''};
 }
 private async finishActivity(session:LiveSession,id:string,failed:boolean,tabId:string|null):Promise<void>{
  const page=tabId?session.pages.get(tabId):undefined,info=tabId?session.pageState.get(tabId):undefined;
  let metadata:ActivityPage|undefined;
  if(page&&!page.isClosed()){
   metadata=this.activityPage(session,tabId);let timer:ReturnType<typeof setTimeout>|undefined;
   try{metadata.pageTitle=await Promise.race([page.title().catch(()=>metadata!.pageTitle),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve(metadata!.pageTitle),200);})]);}finally{if(timer)clearTimeout(timer);}
  }else if(info)metadata=this.activityPage(session,tabId);
  session.activity.finish(id,failed,metadata);
 }
 private async load(session:LiveSession):Promise<void>{
  if(session.loading)return session.loading;if(session.loaded)return;
  session.loading=this.loadSavedState(session);
  try{await session.loading;}finally{session.loaded=true;session.loading=undefined;}
 }
 private async loadSavedState(session:LiveSession):Promise<void>{
  try{
   const file=this.statePath(session.workspaceId),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())return;
   const saved=JSON.parse(await readFile(file,'utf8')) as Partial<SavedState>;
   if(saved.version!==2)return;
   session.desiredRunning=saved.desiredRunning===true;session.mode=saved.mode==='agent'?'agent':'manual';
   session.width=Number.isInteger(saved.width)&&saved.width!>=320&&saved.width!<=2560?saved.width!:1120;
   session.height=Number.isInteger(saved.height)&&saved.height!>=320&&saved.height!<=1600?saved.height!:720;
   session.settings=browserSettingsSchema.parse({...DEFAULT_SETTINGS,...saved.settings});
   session.savedTabs=Array.isArray(saved.tabs)?saved.tabs.slice(0,session.settings.maxTabs).flatMap(tab=>{const url=safeRestoreUrl(tab.url);return url||tab.demo?[{url:url??'about:blank',demo:!url,pinned:tab.pinned===true,active:tab.active===true}]:[]}):[];
   session.recoveryCount=Number.isInteger(saved.recoveryCount)&&saved.recoveryCount!>=0?saved.recoveryCount!:0;
   session.lastRecoveredAt=typeof saved.lastRecoveredAt==='number'?saved.lastRecoveredAt:null;session.lastFailure=typeof saved.lastFailure==='string'?safeFailure(saved.lastFailure):null;
   session.recoveryAttempts=Array.isArray(saved.recoveryAttempts)?saved.recoveryAttempts.filter(value=>typeof value==='number'&&Date.now()-value<300_000):[];
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')session.error='浏览器保存状态无法读取，将使用默认设置。';}
  try{const saved=JSON.parse(await readFile(path.join(path.dirname(this.metadataPath(session.workspaceId)),'agent.json'),'utf8'));if(typeof saved.agentId==='string')session.agentId=saved.agentId;}catch{}
 }
 private rememberTabs(session:LiveSession):void{
  if(!session.pages.size)return;
  session.savedTabs=[...session.pages.entries()].flatMap(([id,page])=>{if(page.isClosed())return [];const state=session.pageState.get(id),url=safeRestoreUrl(page.url());return url||state?.demo?[{url:url??'about:blank',demo:!url,pinned:state?.pinned??false,active:id===session.activeId}]:[];});
 }
 private async persist(session:LiveSession):Promise<void>{
  if(session.persistTimer){clearTimeout(session.persistTimer);session.persistTimer=undefined;}
  if(!session.stopping)this.rememberTabs(session);
  const saved:SavedState={version:2,desiredRunning:session.desiredRunning,mode:session.mode,width:session.width,height:session.height,tabs:session.savedTabs,settings:session.settings,recoveryCount:session.recoveryCount,lastRecoveredAt:session.lastRecoveredAt,lastFailure:session.lastFailure,recoveryAttempts:session.recoveryAttempts};
  const content=JSON.stringify(saved)+'\n';const operation=session.persistTail.then(()=>this.atomicPrivate(this.statePath(session.workspaceId),content));session.persistTail=operation.catch(()=>{});await operation;
 }
 private schedulePersist(session:LiveSession):void{
  if(this.disposed||session.stopping||session.status==='starting'||session.status==='recovering')return;
  if(session.persistTimer)clearTimeout(session.persistTimer);session.persistTimer=setTimeout(()=>{session.persistTimer=undefined;void this.persist(session).catch(()=>{});},250);session.persistTimer.unref?.();
 }
 private playwright():PlaywrightRuntime{
  if(!this.runtime){
   const load=createRequire(path.join(this.runtimeRoot,'package.json'));
   try{this.runtime=load('playwright') as PlaywrightRuntime;}catch(error){if((error as NodeJS.ErrnoException).code==='MODULE_NOT_FOUND')throw new Error(missingRuntime(this.runtimeRoot));throw error;}
  }
  return this.runtime;
 }
 private async executable():Promise<string>{
  if(this.executableOverride){try{await access(this.executableOverride);}catch{throw new Error('PASEO_SERVER_BROWSER_EXECUTABLE 指定的 Chromium 不存在。');}return this.executableOverride;}
  const cache=process.env.PLAYWRIGHT_BROWSERS_PATH??path.join(homedir(),'.cache/ms-playwright');
  const candidates=(await readdir(cache).catch(()=>[] as string[])).filter(item=>/^chromium_headless_shell-\d+$/.test(item)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
  for(const candidate of candidates){const file=path.join(cache,candidate,'chrome-headless-shell-linux64/chrome-headless-shell');try{await access(file);return file;}catch{}}
  const file=this.playwright().chromium.executablePath();try{await access(file);}catch{throw new Error(missingChromium);}return file;
 }
 private async atomicPrivate(file:string,content:string):Promise<void>{await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);await chmod(file,0o600);}
 private async writeMetadata(session:LiveSession):Promise<void>{
  if(!session.cdpEndpoint||!this.gateEndpoint)return;
  await this.atomicPrivate(this.metadataPath(session.workspaceId),JSON.stringify({version:2,workspaceId:session.workspaceId,endpoint:this.gateEndpoint,token:this.token,cdpEndpoint:session.cdpEndpoint,mcpCli:path.join(this.runtimeRoot,'node_modules/@playwright/mcp/cli.js'),artifactDir:this.artifactDir(session.workspaceId),browserPid:session.child?.pid,epoch:session.epoch})+'\n');
 }
 private async ensureGate():Promise<void>{
  if(this.disposed)throw new Error('浏览器插件正在关闭。');if(this.gateEndpoint)return;if(this.gateStarting)return this.gateStarting;
  this.gateStarting=(async()=>{
   await mkdir(this.dataRoot,{recursive:true,mode:0o700});await this.atomicPrivate(this.bridgePath,bridgeSource);
   const server=createServer((request,response)=>{void this.handleControl(request,response);});this.gate=server;
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
   const address=server.address();if(!address||typeof address==='string')throw new Error('浏览器控制接口启动失败。');this.gateEndpoint=`http://127.0.0.1:${address.port}`;
   this.maintenanceTimer=setInterval(()=>{for(const session of this.sessions.values())void this.cleanArtifacts(session).catch(()=>{});},5*60_000);this.maintenanceTimer.unref?.();
  })();try{await this.gateStarting;}finally{this.gateStarting=undefined;}
 }
 private purgeLeases(session:LiveSession):void{for(const [id,lease]of session.leases){try{process.kill(lease.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){session.activity.finish(lease.activityId,true);session.leases.delete(id);}}}}
 private agentBusy(session:LiveSession):boolean{this.purgeLeases(session);return session.leases.size>0||session.controlPending;}
 private async targets(session:LiveSession):Promise<{id:string;index:number;title:string;url:string;active:boolean;pinned:boolean}[]>{await this.syncPages(session);const pages=session.context?.pages()??[];return (await Promise.all([...session.pages].filter(([,page])=>!page.isClosed()).map(async([id,page])=>({id,index:pages.indexOf(page),title:await page.title().catch(()=>''),url:page.url(),active:session.activeId===id,pinned:session.pageState.get(id)?.pinned??false})))).filter(target=>target.index>=0).sort((a,b)=>a.index-b.index);}
 private async leaseView(session:LiveSession,lease:Lease){
  const targets=await this.targets(session);const target=lease.targetId?targets.find(item=>item.id===lease.targetId):null;
  if(lease.targetId&&!target)throw new Error('指定标签页已经关闭，请重新读取标签页列表；不会操作其他页面。');
  return {leaseId:lease.id,activeTargetId:lease.targetId,activeIndex:target?.index??-1,epoch:session.epoch,targets,maxTabs:session.settings.maxTabs,tabCount:targets.length};
 }
 private async handleControl(request:IncomingMessage,response:ServerResponse):Promise<void>{
  const reply=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  try{
   const auth=Buffer.from(request.headers.authorization??''),expected=Buffer.from(`Bearer ${this.token}`);if(request.method!=='POST'||auth.length!==expected.length||!timingSafeEqual(auth,expected)){reply(401,{error:'Unauthorized'});return;}
   let body='';for await(const chunk of request){body+=chunk.toString();if(body.length>32768){reply(413,{error:'Request too large'});return;}}
   const input=JSON.parse(body) as {workspaceId?:string;owner?:string;pid?:number;write?:boolean;leaseId?:string;tabId?:string;tabIndex?:number;createTab?:boolean;closeTab?:boolean;mode?:string;selector?:string;query?:string;maxChars?:number;action?:string;url?:string;toolName?:string;tabAction?:string;failed?:boolean};
   const session=input.workspaceId?this.sessions.get(safeId(input.workspaceId)):undefined;
   if(!session||session.status!=='running'||session.stopping){reply(409,{error:'服务器浏览器尚未就绪，请等待自动恢复或在面板启动。'});return;}
   if(!input.owner||typeof input.owner!=='string'||!Number.isInteger(input.pid)||input.pid!<=0){reply(400,{error:'Invalid control owner'});return;}
   this.purgeLeases(session);const route=request.url;
   if(route==='/read'){reply(200,await this.read(session.workspaceId,readPageInputSchema.parse({...input,workspaceId:session.workspaceId}),'agent'));return;}
   if(route==='/diagnostics'){reply(200,await this.diagnostics(session.workspaceId,'agent'));return;}
   if(route==='/acquire'){
    if(input.write&&session.mode!=='agent')throw new Error('当前为手动接管模式。Agent 只能查看页面，请等用户切换到「Agent 操作」。');
    if(this.agentBusy(session)||session.manualBusy)throw new Error('另一个浏览器操作正在进行，请稍后重试。');
    session.controlPending=true;
    try{
    await this.syncPages(session);
    if(input.write&&session.mode!=='agent')throw new Error('用户已手动接管，尚未开始的写操作已停止。');
    if(input.createTab&&session.pages.size>=session.settings.maxTabs)throw new Error(`已达到 ${session.settings.maxTabs} 个标签页上限，请先关闭不需要的页面。不会自动关闭现有任务。`);
    const target=input.tabId?this.requirePage(session,input.tabId):this.activePage(session);
    if(input.closeTab&&input.tabId&&session.pageState.get(input.tabId)?.pinned)throw new Error('该标签页已固定，请先在面板取消固定，再关闭。');
    const targetId=target?this.pageId(session,target):null;
    const activityTargetId=input.createTab?null:targetId;
    const activityId=session.activity.start('agent',input.toolName,this.activityPage(session,activityTargetId),input.tabAction);
    const lease:Lease={id:randomUUID(),owner:input.owner,pid:input.pid!,write:Boolean(input.write),targetId,epoch:session.epoch,activityId,activityTargetId};session.leases.set(lease.id,lease);
    try{reply(200,await this.leaseView(session,lease));}catch(error){session.activity.finish(activityId,true);session.leases.delete(lease.id);throw error;}
    }finally{session.controlPending=false;}return;
   }
   if(route==='/validate'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error('浏览器操作租约已失效，请重试。');
    if(lease.write&&session.mode!=='agent')throw new Error('用户已手动接管，尚未开始的写操作已停止。');reply(200,await this.leaseView(session,lease));return;
   }
   if(route==='/tabs'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error('浏览器操作租约已失效，请重试。');
    if(input.action!=='list'&&(!lease.write||session.mode!=='agent'))throw new Error('用户已手动接管，标签页写操作已停止。');
    await this.syncPages(session);
    session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
    if(input.action==='new'){
     const url=input.url!==undefined?normalizeNavigationUrl(input.url):null;
     if(session.pages.size>=session.settings.maxTabs)throw new Error(`已达到 ${session.settings.maxTabs} 个标签页上限，请先关闭不需要的页面。`);
     const page=await session.context!.newPage();session.activeId=await this.trackPage(session,page);lease.activityTargetId=session.activeId;if(url)await page.goto(url,{waitUntil:'domcontentloaded'});else await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});
    }else if(input.action==='select'||input.action==='close'){
     const tabId=input.tabId??(input.action==='close'?lease.targetId:null);
     if(!tabId)throw new Error('请提供标签页的稳定 tabId。');const page=this.requirePage(session,tabId);
     lease.activityTargetId=tabId;
     if(input.action==='select'){session.activeId=tabId;await page.bringToFront();}
     else{if(session.pageState.get(tabId)?.pinned)throw new Error('该标签页已固定，请先在面板取消固定。');await page.close();if(!session.pages.size){const created=await session.context!.newPage();session.activeId=await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});}}
    }else if(input.action!=='list')throw new Error('不支持的标签页操作。');
    if(lease.activityTargetId&&session.pages.has(lease.activityTargetId))session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
    session.lastFrame=undefined;session.health=null;await this.persist(session);reply(200,{tabs:await this.targets(session),session:await this.state(session.workspaceId)});return;
   }
   if(route==='/release'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;
    if(lease?.owner===input.owner){let failed=input.failed===true;try{await this.syncPages(session);
     if(input.tabId){this.requirePage(session,input.tabId);session.activeId=input.tabId;}
     else if(Number.isInteger(input.tabIndex)){const page=session.context?.pages()[input.tabIndex!];if(!page)throw new Error('所选标签页已经关闭。');session.activeId=this.pageId(session,page);}
     session.lastFrame=undefined;await this.persist(session);
    }catch(error){failed=true;throw error;}finally{await this.finishActivity(session,lease.activityId,failed,lease.activityTargetId);session.leases.delete(lease.id);}}reply(200,{ok:true});return;
   }
   if(route==='/disconnect'){for(const[id,lease]of session.leases)if(lease.owner===input.owner){session.activity.finish(lease.activityId,true);session.leases.delete(id);}reply(200,{ok:true});return;}
   reply(404,{error:'Not found'});
  }catch(error){reply(409,{error:safeFailure(error)});}
 }
 private pageId(session:LiveSession,page:Page):string|null{for(const[id,item]of session.pages)if(item===page)return id;return null;}
 private requirePage(session:LiveSession,id:string):Page{const page=session.pages.get(id);if(!page||page.isClosed())throw new Error('指定标签页已经关闭或不存在；不会自动切换到其他页面。');return page;}
 private activePage(session:LiveSession):Page|undefined{
  if(session.activeId){const page=session.pages.get(session.activeId);if(page&&!page.isClosed())return page;}
  return undefined;
 }
 private trackPage(session:LiveSession,page:Page):Promise<string>{
  const existing=this.pageId(session,page);if(existing)return Promise.resolve(existing);const pending=session.pendingPages.get(page);if(pending)return pending;
  const generation=session.generation,context=session.context;
  const operation=session.trackTail.then(async()=>{
   if(!context||context!==session.context||generation!==session.generation||page.isClosed()||session.stopping)throw new Error('浏览器页面已失效。');
   if(session.pages.size>=session.settings.maxTabs){await page.close().catch(()=>{});session.error=`已达到 ${session.settings.maxTabs} 个标签页上限，新的弹出窗口已阻止；现有页面保持打开。`;throw new Error(session.error);}
   const cdp=await context.newCDPSession(page);let id:string;
   try{const result=await cdp.send<{targetInfo:{targetId:string}}>('Target.getTargetInfo');id=result.targetInfo.targetId;}finally{await cdp.detach().catch(()=>{});}
   if(!id||page.isClosed()||generation!==session.generation||session.stopping)throw new Error('浏览器页面已失效。');
   session.pages.set(id,page);session.pageState.set(id,{url:page.url(),title:'',demo:page.url()==='about:blank',pinned:false,httpStatus:null,requestFailure:null});session.activeId=id;session.epoch++;session.lastFrame=undefined;
   page.on('close',()=>{if(generation!==session.generation)return;session.pages.delete(id);session.pageState.delete(id);if(session.activeId===id)session.activeId=[...session.pages.keys()].at(-1)??null;session.epoch++;session.health=null;session.lastFrame=undefined;if(!session.stopping)this.schedulePersist(session);});
   page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});
   page.on('framenavigated',frame=>{if(generation!==session.generation||frame!==page.mainFrame())return;const state=session.pageState.get(id);if(state){state.url=page.url();state.demo=state.url==='about:blank';if(state.demo){state.httpStatus=null;state.requestFailure=null;}}session.health=null;session.lastFrame=undefined;this.schedulePersist(session);});
   page.on('response',response=>{try{if(generation!==session.generation||response.frame()!==page.mainFrame()||!response.request().isNavigationRequest())return;const state=session.pageState.get(id);if(state){state.httpStatus=response.status();state.requestFailure=null;}session.health=null;}catch{}});
   page.on('requestfailed',request=>{try{if(generation!==session.generation||request.frame()!==page.mainFrame()||!request.isNavigationRequest())return;const failure=request.failure()?.errorText;if(failure&&!/ERR_ABORTED/.test(failure)){const state=session.pageState.get(id);if(state)state.requestFailure=safeFailure(failure);session.health=null;}}catch{}});
   await page.setViewportSize({width:session.width,height:session.height}).catch(()=>{});this.schedulePersist(session);return id;
  });
  session.trackTail=operation.then(()=>{},()=>{});session.pendingPages.set(page,operation);void operation.finally(()=>{if(session.pendingPages.get(page)===operation)session.pendingPages.delete(page);}).catch(()=>{});return operation;
 }
 private async syncPages(session:LiveSession):Promise<void>{if(!session.context||session.stopping)return;await Promise.allSettled(session.context.pages().filter(page=>!page.isClosed()).map(page=>this.trackPage(session,page)));}
 private async viewport(page:Page,session:LiveSession):Promise<{width:number;height:number}>{try{const size=await page.evaluate<{width:number;height:number}>('({width:window.innerWidth,height:window.innerHeight})');if(Number.isFinite(size.width)&&Number.isFinite(size.height)&&size.width>0&&size.height>0)return size;}catch{}return page.viewportSize()??{width:session.width,height:session.height};}
 private async boot(session:LiveSession,recovery=false):Promise<void>{
  await this.ensureGate();session.status=recovery?'recovering':'starting';session.error=null;session.stopping=false;session.health=null;session.generation++;const generation=session.generation;
  const directory=path.dirname(this.metadataPath(session.workspaceId)),profileDir=path.join(directory,'profile');await mkdir(profileDir,{recursive:true,mode:0o700});await mkdir(this.artifactDir(session.workspaceId),{recursive:true,mode:0o700});
  const savedTabs=session.savedTabs.length?session.savedTabs.slice(0,session.settings.maxTabs):[{url:'about:blank',demo:true,pinned:false,active:true}];
  const activePortFile=path.join(profileDir,'DevToolsActivePort');await unlink(activePortFile).catch(()=>{});let launchError:string|null=null;
  const environment:NodeJS.ProcessEnv={...process.env,LD_LIBRARY_PATH:[path.join(this.runtimeRoot,'lib'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')};
  try{await access(path.join(this.runtimeRoot,'fonts.conf'));environment.FONTCONFIG_FILE=path.join(this.runtimeRoot,'fonts.conf');}catch{}delete environment.DISPLAY;delete environment.WAYLAND_DISPLAY;
  const args=chromiumArguments({profileDir,width:session.width,height:session.height,proxy:browserProxy(),sandbox:browserSandbox()});
  const child=spawn(await this.executable(),args,{stdio:['ignore','ignore','pipe'],env:environment});session.child=child;
  let startupLog='';child.stderr?.on('data',chunk=>{if(session.status==='starting'||session.status==='recovering')startupLog=(startupLog+chunk.toString()).slice(-3000);});
  child.on('error',error=>{launchError=safeFailure(error);});
  child.on('exit',()=>{if(session.child!==child||generation!==session.generation)return;const unexpectedly=!session.stopping&&!this.disposed;session.activity.failRunning();session.child=undefined;session.browser=undefined;session.context=undefined;session.pages.clear();session.pageState.clear();session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.leases.clear();session.health=null;session.uptimeStart=null;if(unexpectedly){session.status='error';session.lastFailure=launchError??'Chromium 进程意外退出。';session.error=session.lastFailure;void this.persist(session).catch(()=>{});if(!session.starting)this.scheduleRecovery(session);}});
  try{
   const deadline=Date.now()+20000;let port:number|undefined;
   while(Date.now()<deadline){if(launchError)throw new Error(launchError);if(this.disposed||session.stopping)throw new Error('浏览器启动已停止。');if(child.exitCode!==null||child.signalCode!==null)throw new Error(startupLog.includes('error while loading shared libraries')?'Chromium 缺少系统运行库，请检查 runtime/lib。':'Chromium 启动失败。');try{const candidate=Number((await readFile(activePortFile,'utf8')).split('\n')[0]);if(Number.isInteger(candidate)&&candidate>0&&candidate<65536){port=candidate;break;}}catch{}await sleep(100);}
   if(!port)throw new Error('Chromium 启动超时。');session.cdpEndpoint=`http://127.0.0.1:${port}`;
   const browser=await this.playwright().chromium.connectOverCDP(session.cdpEndpoint,{timeout:15000});session.browser=browser;const context=browser.contexts()[0];if(!context)throw new Error('Chromium 未提供持久浏览器会话。');session.context=context;context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);
   context.on('page',page=>{if(generation===session.generation)void this.trackPage(session,page).catch(()=>{});});await this.syncPages(session);
   let activeId:string|null=null;
   for(let index=0;index<savedTabs.length;index++){
    if(this.disposed||session.stopping||generation!==session.generation||!session.desiredRunning)return;
    const saved=savedTabs[index],page=index===0?(session.context.pages()[0]??await context.newPage()):await context.newPage();const id=await this.trackPage(session,page);const state=session.pageState.get(id)!;state.pinned=saved.pinned;
    if(saved.demo){await page.goto('about:blank');await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});state.demo=true;}
    else{const url=safeRestoreUrl(saved.url);if(url){try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}catch(error){state.requestFailure=safeFailure(error);state.url=url;session.lastFailure=state.requestFailure;}}}
    if(saved.active)activeId=id;
   }
   if(this.disposed||session.stopping||generation!==session.generation||!session.desiredRunning)return;
   if(activeId)session.activeId=activeId;session.status='running';session.uptimeStart=Date.now();session.epoch++;
   if(recovery){session.recoveryCount++;session.lastRecoveredAt=Date.now();}
   await this.writeMetadata(session);await this.persist(session);await this.cleanArtifacts(session);
  }catch(error){
   if(this.disposed||generation!==session.generation||!session.desiredRunning){child.kill('SIGTERM');return;}
   session.lastFailure=safeFailure(error);session.error=session.lastFailure;session.status='error';session.stopping=true;child.kill('SIGTERM');throw error;
  }
 }
 private scheduleRecovery(session:LiveSession):void{
  if(this.disposed||!session.desiredRunning||!session.settings.autoRecover||session.recoveryTimer||session.starting)return;
  session.recoveryAttempts=session.recoveryAttempts.filter(time=>Date.now()-time<300_000);
  if(session.recoveryAttempts.length>=3){session.status='error';session.error='5 分钟内恢复已尝试 3 次，已停止自动重试。请查看诊断后手动启动。';void this.persist(session).catch(()=>{});return;}
  const delay=[1000,3000,8000][session.recoveryAttempts.length];session.recoveryAttempts.push(Date.now());session.status='recovering';void this.persist(session).catch(()=>{});
  session.recoveryTimer=setTimeout(()=>{session.recoveryTimer=undefined;if(this.disposed||!session.desiredRunning||!session.settings.autoRecover)return;session.starting=(async()=>{try{await this.stopSession(session,true);await this.boot(session,true);}catch(error){session.status='error';session.error=safeFailure(error);}})();void session.starting.finally(()=>{session.starting=undefined;if(session.status!=='running')this.scheduleRecovery(session);}).catch(()=>{});},delay);session.recoveryTimer.unref?.();
 }
 async restore(validWorkspaceIds:string[]):Promise<void>{
  if(this.disposed)return;if(this.restoring)return this.restoring;const allowed=new Set(validWorkspaceIds.filter(id=>/^[A-Za-z0-9_-]{1,120}$/.test(id)));
  this.restoring=(async()=>{let entries;try{entries=await readdir(this.dataRoot,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   const pending:LiveSession[]=[];
   for(const entry of entries){if(this.disposed)break;if(!entry.isDirectory()||entry.isSymbolicLink()||!allowed.has(entry.name))continue;const session=this.session(entry.name);await this.load(session);if(!session.desiredRunning||session.status==='running'||session.starting||session.recoveryTimer)continue;
    session.recoveryAttempts=session.recoveryAttempts.filter(time=>Date.now()-time<300_000);if(session.recoveryAttempts.length>=3){session.status='error';session.error='最近恢复失败次数已达到上限，请手动启动。';continue;}
    session.status='recovering';pending.push(session);
   }
   for(const session of pending){
    if(this.disposed)break;if(!session.desiredRunning||session.status==='running'||session.starting||session.recoveryTimer)continue;
    session.starting=this.boot(session,true);try{await session.starting;}catch(error){session.status='error';session.error=safeFailure(error);}finally{session.starting=undefined;}if((session.status as BrowserSession['status'])!=='running')this.scheduleRecovery(session);
   }
  })();try{await this.restoring;}finally{this.restoring=undefined;}
 }
 async start(workspaceId:string):Promise<BrowserSession>{
  if(this.disposed)throw new Error('浏览器插件正在关闭。');const session=this.session(workspaceId);await this.load(session);session.desiredRunning=true;
  if(session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;}
  if(session.starting)await session.starting;
  else if(session.status!=='running'){session.recoveryAttempts=[];session.starting=(async()=>{if(session.child)await this.stopSession(session,true);try{await this.boot(session);}catch(error){session.status='error';session.error=safeFailure(error);await this.persist(session);throw error;}})();try{await session.starting;}finally{session.starting=undefined;}}
  await this.persist(session);return this.state(workspaceId);
 }
 async state(workspaceId:string):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);await this.syncPages(session);const active=this.activePage(session);
  const tabs=await Promise.all([...session.pages.entries()].filter(([,page])=>!page.isClosed()).map(async([id,page])=>{const title=await page.title().catch(()=>''),saved=session.pageState.get(id);if(saved)saved.title=title;return {id,title,url:page.url(),active:id===session.activeId,pinned:saved?.pinned??false};}));
  const selected=tabs.find(tab=>tab.active),size=active?await this.viewport(active,session):null;if(size){session.width=size.width;session.height=size.height;}
  return {workspaceId,status:session.status,title:selected?.title??'服务器浏览器',url:selected?.url??'',mode:session.mode,width:session.width,height:session.height,tabs,agentId:session.agentId,error:session.error,agentBusy:this.agentBusy(session),settings:{...session.settings},runtime:{recoveryCount:session.recoveryCount,lastRecoveredAt:session.lastRecoveredAt,lastFailure:session.lastFailure,artifactBytes:session.artifactBytes,artifactCount:session.artifactCount,cleanedArtifacts:session.cleanedArtifacts,uptimeSeconds:session.uptimeStart?Math.max(0,Math.floor((Date.now()-session.uptimeStart)/1000)):0},health:session.health,activity:session.activity.snapshot()};
 }
 async frame(workspaceId:string,after?:string|null,quality:BrowserFrameQuality='balanced',options:FrameLimits&{sessionRevision?:string}={}):Promise<BrowserFrameResult>{
  const session=this.session(workspaceId);if(session.resizing)await session.resizing.catch(()=>{});await this.syncPages(session);const page=this.activePage(session);if(session.status!=='running'||!page)return this.frameResult(workspaceId,null,options.sessionRevision);
  const choice=FRAME_QUALITY[quality],limits={maxWidth:options.maxWidth,maxHeight:options.maxHeight},key=`${quality}:${frameScale({width:session.width,height:session.height},limits)}`;
  if(!session.frameTask){session.frameTask=(async()=>{if(session.lastFrame&&session.frameKey===key&&session.frameTabId===session.activeId&&Date.now()-session.lastFrame.capturedAt<choice.cache)return session.lastFrame;
   const tabId=session.activeId,shot=await captureBrowserFrame(session.context!,page,choice.quality,limits),size=shot.width>0&&shot.height>0?shot:await this.viewport(page,session),id=createHash('sha256').update(shot.bytes).digest('hex').slice(0,24);
   if(session.activeId!==tabId||page.isClosed())return null;
   const frame={id,dataUrl:`data:image/jpeg;base64,${shot.bytes.toString('base64')}`,width:size.width,height:size.height,capturedAt:Date.now(),...(shot.scale<1?{scale:shot.scale}:{})};session.lastFrame=frame;session.frameKey=key;session.frameTabId=tabId??undefined;return frame;})().finally(()=>{session.frameTask=undefined;});}
  try{const frame=await session.frameTask;return this.frameResult(workspaceId,frame?.id===after?null:frame,options.sessionRevision);}catch(error){if(page.isClosed()||session.status!=='running')return this.frameResult(workspaceId,null,options.sessionRevision);throw error;}
 }
 /** Frame polling re-sends the session only when it changed since the revision the viewer holds. */
 private async frameResult(workspaceId:string,frame:BrowserFrameResult['frame'],knownRevision?:string):Promise<BrowserFrameResult>{
  const session=await this.state(workspaceId),revision=sessionRevision(session);
  return knownRevision===revision?{sessionRevision:revision,frame}:{session,sessionRevision:revision,frame};
 }
 private async serialized<T>(session:LiveSession,operation:()=>Promise<T>):Promise<T>{const result=session.tail.then(operation,operation);session.tail=result.then(()=>{},()=>{});return result;}
 private async cleanArtifacts(session:LiveSession):Promise<void>{if(session.artifactTask)return session.artifactTask;session.artifactTask=(async()=>{const result=await maintainArtifacts(this.artifactDir(session.workspaceId),session.settings);session.artifactBytes=result.bytes;session.artifactCount=result.count;session.cleanedArtifacts+=result.cleaned;})().finally(()=>{session.artifactTask=undefined;});return session.artifactTask;}
 async action(workspaceId:string,action:BrowserAction):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);
  return this.serialized(session,async()=>{
  if(action.kind==='settings'||action.kind==='cleanup')return this.performAction(workspaceId,action);
  await this.syncPages(session);
  const originalTarget='tabId'in action?action.tabId:action.kind==='newTab'?null:session.activeId;
  const activityId=session.activity.start('manual',action.kind,this.activityPage(session,originalTarget));
  try{const result=await this.performAction(workspaceId,action,originalTarget);await this.finishActivity(session,activityId,false,originalTarget??(action.kind==='newTab'?session.activeId:null));result.activity=session.activity.snapshot();return result;}
  catch(error){await this.finishActivity(session,activityId,true,originalTarget);throw error;}
  });
 }
 private async performAction(workspaceId:string,action:BrowserAction,originalTarget?:string|null):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);
   if(action.kind==='mode'){session.mode=action.mode;await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='settings'){session.settings=browserSettingsSchema.parse({...session.settings,...action.settings});if(!session.settings.autoRecover&&session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;session.status='error';}await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='cleanup'){await this.cleanArtifacts(session);return this.state(workspaceId);}
   if(session.mode!=='manual')throw new Error('请先切换到「手动接管」再操作浏览器。');if(this.agentBusy(session))throw new Error('Agent 的浏览器操作正在结束，请稍后再操作。');
   session.manualBusy=true;
   try{
   if(action.kind==='stop'){session.desiredRunning=false;await this.stopSession(session,false);return this.state(workspaceId);}
   if(action.kind==='restart'){session.desiredRunning=true;await this.stopSession(session,true);await this.start(workspaceId);return this.state(workspaceId);}
   if(session.status!=='running')throw new Error('请先启动服务器浏览器。');await this.syncPages(session);const page=originalTarget?this.requirePage(session,originalTarget):this.activePage(session);if(!page&&action.kind!=='newTab')throw new Error('当前没有网页，请新建标签页。');
   try{switch(action.kind){
    case 'navigate':session.health=null;await page!.goto(normalizeNavigationUrl(action.url),{waitUntil:'domcontentloaded'});break;
    case 'back':session.health=null;await page!.goBack({waitUntil:'domcontentloaded'});break;
    case 'forward':session.health=null;await page!.goForward({waitUntil:'domcontentloaded'});break;
    case 'reload':session.health=null;await page!.reload({waitUntil:'domcontentloaded'});break;
    case 'demo':await page!.goto('about:blank');await page!.setContent(demoHtml(),{waitUntil:'domcontentloaded'});break;
    case 'click':{const size=await this.viewport(page!,session);if(action.x<0||action.y<0||action.x>=size.width||action.y>=size.height)throw new Error('点击位置超出了浏览器画面。');await page!.mouse.click(action.x,action.y);break;}
    case 'scroll':await page!.mouse.wheel(action.deltaX,action.deltaY);break;
    case 'text':await page!.keyboard.insertText(action.text);break;
    case 'key':await page!.keyboard.press(action.key);break;
    case 'viewport':{
     session.resizing=(async()=>{
      await session.frameTask?.catch(()=>{});
      await Promise.all([...session.pages.values()].filter(p=>!p.isClosed()).map(p=>setVerifiedViewport(p,{width:action.width,height:action.height})));
      session.width=action.width;session.height=action.height;
     })();
     try{await session.resizing;}finally{session.resizing=undefined;}
     break;
    }
    case 'fitWidth':{
     let remaining=false;
     session.resizing=(async()=>{
      await session.frameTask?.catch(()=>{});
      const fitted=await fitPageWidth(page!);
      session.width=fitted.width;session.height=fitted.height;remaining=fitted.limitReached;
     })();
     try{await session.resizing;}finally{session.resizing=undefined;session.lastFrame=undefined;}
     if(remaining)throw new Error('已扩大视口，部分超宽内容仍需横向滚动。');
     break;
    }
    case 'newTab':{if(session.pages.size>=session.settings.maxTabs)throw new Error(`已达到 ${session.settings.maxTabs} 个标签页上限，请先关闭不需要的页面。`);const created=await session.context!.newPage();await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});break;}
    case 'tab':{const target=this.requirePage(session,action.tabId);session.activeId=action.tabId;session.health=null;await target.bringToFront();break;}
    case 'pin':this.requirePage(session,action.tabId);session.pageState.get(action.tabId)!.pinned=action.pinned;break;
    case 'closeTab':{const target=this.requirePage(session,action.tabId);if(session.pageState.get(action.tabId)?.pinned)throw new Error('该标签页已固定，请先取消固定再关闭。');await target.close();if(!session.pages.size){const created=await session.context!.newPage();await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});}break;}
   }}catch(error){if(['navigate','back','forward','reload'].includes(action.kind)){const state=session.activeId?session.pageState.get(session.activeId):undefined;if(state)state.requestFailure=safeFailure(error);session.health=null;}session.error=safeFailure(error);await this.persist(session);throw error;}
   session.lastFrame=undefined;session.error=null;await this.persist(session);return this.state(workspaceId);
   }finally{session.manualBusy=false;}
 }
 async read(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>,source:BrowserActivity['source']='manual'):Promise<BrowserReading>{
  const session=this.session(workspaceId),tabId=input.tabId??session.activeId,activityId=session.activity.start(source,'browser_read_page',this.activityPage(session,tabId));
  try{const result=await this.performRead(workspaceId,input);await this.finishActivity(session,activityId,false,tabId);return result;}
  catch(error){await this.finishActivity(session,activityId,true,tabId);throw error;}
 }
 private async performRead(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>):Promise<BrowserReading>{
  const session=this.session(workspaceId);if(session.status!=='running')throw new Error('请先启动服务器浏览器。');await this.syncPages(session);const parsed=readPageInputSchema.parse({...input,workspaceId});const page=parsed.tabId?this.requirePage(session,parsed.tabId):this.activePage(session);if(!page)throw new Error('当前没有可读取的标签页。');const id=this.pageId(session,page)!;return readPageContent(page,id,parsed,this.runtimeRoot);
 }
 async diagnostics(workspaceId:string,source:BrowserActivity['source']='manual'):Promise<BrowserDiagnostics>{
  const session=this.session(workspaceId),tabId=session.activeId,activityId=session.activity.start(source,'browser_diagnostics',this.activityPage(session,tabId));
  try{const result=await this.performDiagnostics(workspaceId);await this.finishActivity(session,activityId,false,tabId);result.session.activity=session.activity.snapshot();return result;}
  catch(error){await this.finishActivity(session,activityId,true,tabId);throw error;}
 }
 private async performDiagnostics(workspaceId:string):Promise<BrowserDiagnostics>{
  const session=this.session(workspaceId);await this.load(session);await this.syncPages(session);const page=this.activePage(session),info=session.activeId?session.pageState.get(session.activeId):undefined;
  const checks:BrowserDiagnostics['checks']=[];let cdpOk=false;
  if(page&&session.context&&session.status==='running'){
   let cdp:Awaited<ReturnType<BrowserContext['newCDPSession']>>|undefined;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{cdp=await session.context.newCDPSession(page);await Promise.race([cdp.send('Target.getTargetInfo'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP timeout')),5000);})]);cdpOk=true;}catch{}finally{if(timer)clearTimeout(timer);await cdp?.detach().catch(()=>{});}
  }
  checks.push({name:'浏览器与 CDP',status:cdpOk?'ok':'error',detail:cdpOk?`Chromium 与本机 CDP 只读探测正常；Chromium 沙箱${browserSandbox()?'已开启':'未开启'}。`:'浏览器或 CDP 尚未就绪，可启动或等待恢复。'});
  const profile=path.join(path.dirname(this.metadataPath(workspaceId)),'profile');const writable=await access(profile,constants.W_OK).then(()=>true,()=>false);checks.push({name:'持久化 Profile',status:writable?'ok':'warning',detail:writable?'独立 Profile 可写；已有 Cookie 可持久保存，但有效期由网站决定。':'Profile 尚未建立或不可写。'});
  // Optional runtime extras: lib/ joins LD_LIBRARY_PATH and fonts.conf becomes FONTCONFIG_FILE; otherwise the system's own are used.
  const exists=(file:string)=>access(file).then(()=>true,()=>false),fonts=await exists(path.join(this.runtimeRoot,'fonts.conf')),libs=await exists(path.join(this.runtimeRoot,'lib'));
  checks.push({name:'字体与运行库',status:cdpOk?'ok':'warning',detail:`${cdpOk?'Chromium 已正常启动':'浏览器未运行，暂时无法确认运行库'}；字体：${fonts?'运行时目录的 fonts.conf':'系统字体（中文显示为方块时请安装中文字体）'}；运行库：${libs?'系统与运行时目录的 lib/':'系统'}。`});
  const agentTools=await exists(path.join(this.runtimeRoot,'node_modules/@playwright/mcp/cli.js'));
  checks.push({name:'Agent 工具',status:agentTools?'ok':'warning',detail:agentTools?'已找到 Playwright MCP，浏览器 Agent 可以连接。':'运行时目录中没有 Playwright MCP，浏览器 Agent 无法连接；请运行 scripts/setup-runtime.mjs。'});
  try{checks.push({name:'网络与代理',status:'ok',detail:browserProxy()?'Chromium 使用 PASEO_SERVER_BROWSER_PROXY 指定的代理。':['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy'].some(key=>process.env[key])?'Chromium 沿用 daemon 环境中的 HTTP(S)_PROXY / ALL_PROXY 代理设置。':'未配置代理，Chromium 直接使用服务器网络。'});}
  catch(error){checks.push({name:'网络与代理',status:'error',detail:safeFailure(error)});}
  let origin='';try{origin=page?new URL(page.url()).origin:'';if(origin==='null')origin='本地体验页';}catch{}
  let state:BrowserHealth['state']='unknown',summary='未能判断页面状态。';let signals:{password:boolean;loginForm:boolean;hasContent:boolean}|null=null;
  if(page&&session.status==='running'&&cdpOk){
   try{signals=await page.evaluate<{password:boolean;loginForm:boolean;hasContent:boolean}>(`(()=>{const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};const password=[...document.querySelectorAll('input[type=password]')].some(visible);const forms=[...document.querySelectorAll('form')].filter(visible);const loginForm=forms.some(f=>f.querySelector('input')&&/登录|登入|sign[ -]?in|log[ -]?in/i.test(f.innerText.slice(0,1500)));return{password,loginForm,hasContent:!!document.body?.innerText.trim()}})()`);}catch{}
   if(info?.requestFailure){state='network_error';summary=info.requestFailure;}
   else if(info?.httpStatus===401){state='login_required';summary='网站返回 HTTP 401，通常需要登录或重新认证，请人工确认。';}
   else if(info?.httpStatus===403){state='unknown';summary='网站返回 HTTP 403，可能是权限或访问策略限制，不能仅据此判断登录过期。';}
   else if(signals?.password||signals?.loginForm){state='login_required';summary='检测到可见密码框或明显登录表单，疑似需要登录，请人工确认。';}
   else if(signals?.hasContent){state='accessible';summary='当前页面内容可读取；这不代表已通过所有登录或权限校验。';}
   else{summary='页面尚无明显可读内容，暂无法判断登录状态。';}
  }
  // A failed navigation can replace the document while the read-only CDP probe runs.
  // Preserve its known failure instead of obscuring it with a transient probe result.
  if(session.status==='running'&&info?.requestFailure){state='network_error';summary=info.requestFailure;}
  const health:BrowserHealth={state,summary,checkedAt:Date.now(),httpStatus:info?.httpStatus??null,origin};session.health=health;checks.push({name:'页面与登录提示',status:state==='accessible'?'ok':state==='network_error'?'error':'warning',detail:summary});return {session:await this.state(workspaceId),checks,health};
 }
 async setAgentId(workspaceId:string,agentId:string|null):Promise<void>{const session=this.session(workspaceId);session.agentId=agentId;await this.atomicPrivate(path.join(path.dirname(this.metadataPath(workspaceId)),'agent.json'),JSON.stringify({agentId})+'\n');}
 async getAgentId(workspaceId:string):Promise<string|null>{const session=this.session(workspaceId);await this.load(session);return session.agentId;}
 private async stopSession(session:LiveSession,preserveDesired:boolean):Promise<void>{
  if(session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;}if(session.persistTimer){clearTimeout(session.persistTimer);session.persistTimer=undefined;}
  this.rememberTabs(session);session.stopping=true;if(!preserveDesired)session.desiredRunning=false;session.activity.failRunning(true);session.leases.clear();await this.persist(session);
  const child=session.child;session.generation++;await session.browser?.close().catch(()=>{});
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  session.browser=undefined;session.context=undefined;session.child=undefined;session.pages.clear();session.pageState.clear();session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.status='idle';session.error=null;session.health=null;session.uptimeStart=null;await unlink(this.metadataPath(session.workspaceId)).catch(()=>{});
 }
 async close():Promise<void>{this.disposed=true;if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);await Promise.allSettled([...this.sessions.values()].map(async session=>{if(session.recoveryTimer)clearTimeout(session.recoveryTimer);session.stopping=true;await session.starting?.catch(()=>{});await this.stopSession(session,true);}));if(this.gate)await new Promise<void>(resolve=>{this.gate!.close(()=>resolve());this.gate!.closeAllConnections();});this.gate=undefined;this.gateEndpoint=undefined;}
}
