import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BrowserConnection as Browser, BrowserContext, BrowserPage as Page } from './browser-types';
import { browserSettingsSchema, readPageInputSchema, type BrowserAction, type BrowserFrameQuality, type BrowserFrameResult, type BrowserSession, type BrowserSettings, type BrowserHealth, type BrowserReading, type BrowserReadInput, type BrowserActivity } from '../shared/browser';
import { bridgeScript } from './bridge-source';
import { demoHtml } from './demo';
import { maintainArtifacts } from './artifacts';
import { readPageContent } from './reading';
import { BrowserActivityLog, type ActivityPage } from './activity';
import { setVerifiedViewport } from './viewport';
import { captureBrowserFrame, frameScale, type FrameLimits } from './frame';
import { sessionRevision } from './revision';
import { fitPageWidth } from './page-fit';
import { browserProxy, browserSandboxMode, chromiumArguments, chromiumEnvironment, defaultRuntimeRoot, missingChromium, missingRuntime, type SandboxMode } from './runtime';
import { BUDGETS, withTimeout, type Budgets } from './budgets';
import { normalizeNavigationUrl, restorableUrl } from './navigation';
import { ensurePrivateDirectory, readPrivateJson } from './private-files';

export { normalizeNavigationUrl } from './navigation';
type PlaywrightRuntime={chromium:{connectOverCDP(endpoint:string,options?:{timeout?:number}):Promise<Browser>;executablePath():string}};
/** expiresAt: revoked when not renewed in time. operation: an Agent tab change in progress; the lease outlives it. */
type Lease={id:string;owner:string;pid:number;write:boolean;targetId:string|null;epoch:number;activityId:string;activityTargetId:string|null;expiresAt:number;operation?:Promise<void>};
/** The Chromium that is running: whether its sandbox is on, and why not. */
type SandboxState={enabled:boolean;mode:SandboxMode;fallbackReason?:string};
type SavedTab={url:string;demo:boolean;pinned:boolean;active:boolean};
type PageState={url:string;title:string;demo:boolean;pinned:boolean;httpStatus:number|null;requestFailure:string|null};
type ControlInput={workspaceId?:string;owner?:string;pid?:number;write?:boolean;leaseId?:string;tabId?:string;tabIndex?:number;createTab?:boolean;closeTab?:boolean;mode?:string;selector?:string;query?:string;maxChars?:number;action?:string;url?:unknown;toolName?:string;tabAction?:string;failed?:boolean};
type SavedState={version:2;desiredRunning:boolean;mode:BrowserSession['mode'];width:number;height:number;tabs:SavedTab[];settings:BrowserSettings;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[]};
type LiveSession={
 workspaceId:string;status:BrowserSession['status'];mode:BrowserSession['mode'];width:number;height:number;agentId:string|null;error:string|null;
 browser?:Browser;context?:BrowserContext;child?:ChildProcess;cdpEndpoint?:string;
 pages:Map<string,Page>;pageState:Map<string,PageState>;pendingPages:Map<Page,Promise<string>>;trackTail:Promise<void>;activeId:string|null;
 starting?:Promise<void>;loading?:Promise<void>;tail:Promise<void>;persistTail:Promise<void>;loaded:boolean;desiredRunning:boolean;settings:BrowserSettings;savedTabs:SavedTab[];
 frameTask?:Promise<BrowserFrameResult['frame']>;resizing?:Promise<void>;lastFrame?:NonNullable<BrowserFrameResult['frame']>;frameKey?:string;frameTabId?:string;
 leases:Map<string,Lease>;controlPending:boolean;manualOps:number;stopping:boolean;generation:number;epoch:number;health:BrowserHealth|null;uptimeStart:number|null;
 token:Buffer|null;sandbox:SandboxState|null;
 activity:BrowserActivityLog;recoveryCount:number;lastRecoveredAt:number|null;lastFailure:string|null;recoveryAttempts:number[];recoveryTimer?:ReturnType<typeof setTimeout>;
 persistTimer?:ReturnType<typeof setTimeout>;artifactTask?:Promise<void>;artifactBytes:number;artifactCount:number;cleanedArtifacts:number;
};
/** budgets and now exist for tests: shorter limits and an injected clock for lease expiry. */
export type BrowserManagerOptions={runtimeRoot?:string;dataRoot?:string;executablePath?:string;budgets?:Partial<Budgets>;now?:()=>number};
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
const AGENT_ID=/^[A-Za-z0-9._:-]{1,128}$/;
const sandboxFailure=(log:string)=>/No usable sandbox/i.test(log)?'没有可用的沙箱，需要非特权用户命名空间或 setuid 沙箱':/Running as root/i.test(log)?'daemon 以 root 身份运行':'Chromium 带沙箱启动失败';

export class BrowserManager{
 readonly runtimeRoot:string;readonly dataRoot:string;readonly bridgePath:string;
 private sessions=new Map<string,LiveSession>();private gate?:Server;private gateEndpoint?:string;private gateStarting?:Promise<void>;
 private disposed=false;private runtime?:PlaywrightRuntime;private executableOverride?:string;
 private maintenanceTimer?:ReturnType<typeof setInterval>;private restoring?:Promise<void>;
 private readonly budgets:Budgets;private readonly now:()=>number;
 /** Workspace directories from the daemon, for session.json: the bridge confines file uploads to them. */
 private workspaceDirectories=new Map<string,string>();
 /** In automatic mode, set once Chromium failed to start with its sandbox and started without it on this host. */
 private sandboxUnavailable:string|null=null;
 constructor(options:BrowserManagerOptions={}){
  this.runtimeRoot=options.runtimeRoot??defaultRuntimeRoot();
  this.dataRoot=options.dataRoot??(process.env.PASEO_SERVER_BROWSER_DATA||path.join(this.runtimeRoot,'visual'));this.bridgePath=path.join(this.dataRoot,'mcp-bridge.mjs');
  this.executableOverride=options.executablePath??process.env.PASEO_SERVER_BROWSER_EXECUTABLE;
  this.budgets={...BUDGETS,...options.budgets};this.now=options.now??Date.now;
 }
 /** Called with the daemon's workspace descriptor whenever the panel or a restore confirms a workspace. */
 setWorkspaceDirectory(workspaceId:string,directory:string):void{
  safeId(workspaceId);if(!path.isAbsolute(directory)||this.workspaceDirectories.get(workspaceId)===directory)return;
  this.workspaceDirectories.set(workspaceId,directory);
  const session=this.sessions.get(workspaceId);if(session?.status==='running'&&!session.stopping)void this.writeMetadata(session).catch(()=>{});
 }
 metadataPath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'session.json');}
 private statePath(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'state.json');}
 private artifactDir(workspaceId:string):string{return path.join(this.dataRoot,safeId(workspaceId),'artifacts');}
 private session(workspaceId:string):LiveSession{
  safeId(workspaceId);let session=this.sessions.get(workspaceId);
  if(!session){session={workspaceId,status:'idle',mode:'manual',width:1120,height:720,agentId:null,error:null,pages:new Map(),pageState:new Map(),pendingPages:new Map(),trackTail:Promise.resolve(),activeId:null,tail:Promise.resolve(),persistTail:Promise.resolve(),loaded:false,desiredRunning:false,settings:{...DEFAULT_SETTINGS},savedTabs:[],leases:new Map(),controlPending:false,manualOps:0,stopping:false,generation:0,epoch:0,health:null,uptimeStart:null,token:null,sandbox:null,activity:new BrowserActivityLog(),recoveryCount:0,lastRecoveredAt:null,lastFailure:null,recoveryAttempts:[],artifactBytes:0,artifactCount:0,cleanedArtifacts:0};this.sessions.set(workspaceId,session);}return session;
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
   const saved=await readPrivateJson(file,1_048_576) as Partial<SavedState>;
   if(saved.version!==2)return;
   session.desiredRunning=saved.desiredRunning===true;session.mode=saved.mode==='agent'?'agent':'manual';
   session.width=Number.isInteger(saved.width)&&saved.width!>=320&&saved.width!<=2560?saved.width!:1120;
   session.height=Number.isInteger(saved.height)&&saved.height!>=320&&saved.height!<=1600?saved.height!:720;
   session.settings=browserSettingsSchema.parse({...DEFAULT_SETTINGS,...saved.settings});
   session.savedTabs=Array.isArray(saved.tabs)?saved.tabs.slice(0,session.settings.maxTabs).flatMap(tab=>{const url=restorableUrl(tab.url);return url||tab.demo?[{url:url??'about:blank',demo:!url,pinned:tab.pinned===true,active:tab.active===true}]:[]}):[];
   session.recoveryCount=Number.isInteger(saved.recoveryCount)&&saved.recoveryCount!>=0?saved.recoveryCount!:0;
   session.lastRecoveredAt=typeof saved.lastRecoveredAt==='number'?saved.lastRecoveredAt:null;session.lastFailure=typeof saved.lastFailure==='string'?safeFailure(saved.lastFailure):null;
   session.recoveryAttempts=Array.isArray(saved.recoveryAttempts)?saved.recoveryAttempts.filter(value=>typeof value==='number'&&Date.now()-value<300_000):[];
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')session.error='浏览器保存状态无法读取，将使用默认设置。';}
  // A small regular file with a well-formed Agent id; anything else is ignored.
  try{const saved=await readPrivateJson(path.join(path.dirname(this.metadataPath(session.workspaceId)),'agent.json'),4096) as {agentId?:unknown};if(typeof saved?.agentId==='string'&&AGENT_ID.test(saved.agentId))session.agentId=saved.agentId;}catch{}
 }
 private rememberTabs(session:LiveSession):void{
  if(!session.pages.size)return;
  session.savedTabs=[...session.pages.entries()].flatMap(([id,page])=>{if(page.isClosed())return [];const state=session.pageState.get(id),url=restorableUrl(page.url());return url||state?.demo?[{url:url??'about:blank',demo:!url,pinned:state?.pinned??false,active:id===session.activeId}]:[];});
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
 private async atomicPrivate(file:string,content:string):Promise<void>{const directory=path.dirname(file);await ensurePrivateDirectory(directory,directory===this.dataRoot?'服务器浏览器数据目录':'工作区浏览器目录');const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,content,{mode:0o600});await rename(tmp,file);await chmod(file,0o600);}
 /** session.json: everything the Agent bridge needs, with a token that only works for this workspace's browser. */
 private async writeMetadata(session:LiveSession):Promise<void>{
  if(!session.cdpEndpoint||!this.gateEndpoint||!session.token)return;
  await this.atomicPrivate(this.metadataPath(session.workspaceId),JSON.stringify({version:2,workspaceId:session.workspaceId,endpoint:this.gateEndpoint,token:session.token.toString('hex'),cdpEndpoint:session.cdpEndpoint,mcpCli:path.join(this.runtimeRoot,'node_modules/@playwright/mcp/cli.js'),artifactDir:this.artifactDir(session.workspaceId),workspaceDirectory:this.workspaceDirectories.get(session.workspaceId)??null,browserPid:session.child?.pid,epoch:session.epoch})+'\n');
 }
 private async ensureGate():Promise<void>{
  if(this.disposed)throw new Error('浏览器插件正在关闭。');if(this.gateEndpoint)return;if(this.gateStarting)return this.gateStarting;
  this.gateStarting=(async()=>{
   await ensurePrivateDirectory(this.dataRoot,'服务器浏览器数据目录');await this.atomicPrivate(this.bridgePath,bridgeScript(this.runtimeRoot));
   const server=createServer((request,response)=>{void this.handleControl(request,response);});this.gate=server;
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
   const address=server.address();if(!address||typeof address==='string')throw new Error('浏览器控制接口启动失败。');this.gateEndpoint=`http://127.0.0.1:${address.port}`;
   this.maintenanceTimer=setInterval(()=>{for(const session of this.sessions.values())void this.cleanArtifacts(session).catch(()=>{});},5*60_000);this.maintenanceTimer.unref?.();
  })();try{await this.gateStarting;}finally{this.gateStarting=undefined;}
 }
 /** A lease ends when its bridge process is gone or when it was not renewed in time, but never while a tab change it started still runs. */
 private purgeLeases(session:LiveSession):void{
  const now=this.now();
  for(const [id,lease]of session.leases){
   if(lease.operation)continue;
   let gone=lease.expiresAt<=now;
   if(!gone){try{process.kill(lease.pid,0);}catch(error){gone=(error as NodeJS.ErrnoException).code==='ESRCH';}}
   if(gone)this.revokeLease(session,id);
  }
 }
 private revokeLease(session:LiveSession,id:string):void{const lease=session.leases.get(id);if(!lease)return;session.activity.finish(lease.activityId,true);session.leases.delete(id);}
 private agentBusy(session:LiveSession):boolean{this.purgeLeases(session);return session.leases.size>0||session.controlPending;}
 /** The page title, or the last known one when the page does not answer in time (for example while a script blocks it). */
 private pageTitle(session:LiveSession,id:string,page:Page):Promise<string>{const known=session.pageState.get(id)?.title??'';return withTimeout(page.title().catch(()=>known),this.budgets.titleMs,()=>known);}
 private async targets(session:LiveSession):Promise<{id:string;index:number;title:string;url:string;active:boolean;pinned:boolean}[]>{await this.syncPages(session);const pages=session.context?.pages()??[];return (await Promise.all([...session.pages].filter(([,page])=>!page.isClosed()).map(async([id,page])=>({id,index:pages.indexOf(page),title:await this.pageTitle(session,id,page),url:page.url(),active:session.activeId===id,pinned:session.pageState.get(id)?.pinned??false})))).filter(target=>target.index>=0).sort((a,b)=>a.index-b.index);}
 private async leaseView(session:LiveSession,lease:Lease){
  const targets=await this.targets(session);const target=lease.targetId?targets.find(item=>item.id===lease.targetId):null;
  if(lease.targetId&&!target)throw new Error('指定标签页已经关闭，请重新读取标签页列表；不会操作其他页面。');
  return {leaseId:lease.id,activeTargetId:lease.targetId,activeIndex:target?.index??-1,epoch:session.epoch,targets,maxTabs:session.settings.maxTabs,tabCount:targets.length};
 }
 /** The workspace browser a control token belongs to. Each running browser has its own token, compared in constant time. */
 private sessionForToken(header:string|undefined):LiveSession|undefined{
  const match=/^Bearer ([0-9a-f]{64})$/.exec(header??'');if(!match)return undefined;
  const given=Buffer.from(match[1],'hex');let found:LiveSession|undefined;
  for(const session of this.sessions.values())if(session.token&&timingSafeEqual(session.token,given))found=session;
  return found;
 }
 /** Server work behind one control request ends before the bridge stops waiting, so the bridge always gets an answer. */
 private serverWork<T>(operation:Promise<T>):Promise<T>{return withTimeout(operation,this.budgets.controlServerMs,()=>{throw new Error('浏览器暂时没有响应，请稍后重试。');});}
 private async handleControl(request:IncomingMessage,response:ServerResponse):Promise<void>{
  const reply=(status:number,value:unknown)=>{if(response.destroyed)return;response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  try{
   const session=request.method==='POST'?this.sessionForToken(request.headers.authorization):undefined;
   if(!session){reply(401,{error:'Unauthorized'});return;}
   let body='';for await(const chunk of request){body+=chunk.toString();if(body.length>32768){reply(413,{error:'Request too large'});return;}}
   const input=JSON.parse(body) as ControlInput;
   // A token only works for its own workspace's browser.
   if(input.workspaceId!==session.workspaceId){reply(403,{error:'Forbidden'});return;}
   if(session.status!=='running'||session.stopping){reply(409,{error:'服务器浏览器尚未就绪，请等待自动恢复或在面板启动。'});return;}
   if(!input.owner||typeof input.owner!=='string'||!Number.isInteger(input.pid)||input.pid!<=0){reply(400,{error:'Invalid control owner'});return;}
   this.purgeLeases(session);const route=request.url;
   if(route==='/read'){reply(200,await this.read(session.workspaceId,readPageInputSchema.parse({...input,workspaceId:session.workspaceId}),'agent'));return;}
   if(route==='/diagnostics'){reply(200,await this.diagnostics(session.workspaceId,'agent'));return;}
   if(route==='/acquire'){
    if(input.url!==undefined&&typeof input.url!=='string')throw new Error('请输入有效的网页地址。');
    // Agent navigation follows the panel's address rules; the bridge hands Playwright MCP only this normalized address.
    const url=input.url!==undefined?normalizeNavigationUrl(input.url):undefined;
    if(input.write&&session.mode!=='agent')throw new Error('当前为手动接管模式。Agent 只能查看页面，请等用户切换到「Agent 操作」。');
    if(this.agentBusy(session)||session.manualOps>0)throw new Error('另一个浏览器操作正在进行，请稍后重试。');
    session.controlPending=true;
    // A bridge that stopped waiting closes its request; it must not be left holding a lease it never received.
    let abandoned=false;response.once('close',()=>{abandoned=true;});
    const lease:Lease={id:randomUUID(),owner:input.owner,pid:input.pid!,write:Boolean(input.write),targetId:null,epoch:session.epoch,activityId:'',activityTargetId:null,expiresAt:0};
    const failedActivity=()=>session.activity.finish(session.activity.start('agent',input.toolName,this.activityPage(session,lease.activityTargetId),input.tabAction),true);
    try{
     let view:Awaited<ReturnType<BrowserManager['leaseView']>>;
     try{
      view=await this.serverWork((async()=>{
       await this.syncPages(session);
       if(input.write&&session.mode!=='agent')throw new Error('用户已手动接管，尚未开始的写操作已停止。');
       if(input.createTab&&session.pages.size>=session.settings.maxTabs)throw new Error(`已达到 ${session.settings.maxTabs} 个标签页上限，请先关闭不需要的页面。不会自动关闭现有任务。`);
       const target=input.tabId?this.requirePage(session,input.tabId):this.activePage(session);
       if(input.closeTab&&input.tabId&&session.pageState.get(input.tabId)?.pinned)throw new Error('该标签页已固定，请先在面板取消固定，再关闭。');
       lease.targetId=target?this.pageId(session,target):null;lease.activityTargetId=input.createTab?null:lease.targetId;lease.epoch=session.epoch;
       return this.leaseView(session,lease);
      })());
     }catch(error){failedActivity();throw error;}
     if(abandoned||response.destroyed){failedActivity();return;}
     lease.activityId=session.activity.start('agent',input.toolName,this.activityPage(session,lease.activityTargetId),input.tabAction);
     lease.expiresAt=this.now()+this.budgets.leaseTtlMs;session.leases.set(lease.id,lease);
     response.once('close',()=>{if(!response.writableFinished)this.revokeLease(session,lease.id);});
     reply(200,{...view,...(url?{url}:{})});
    }finally{session.controlPending=false;}return;
   }
   if(route==='/validate'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error('浏览器操作租约已失效，请重试。');
    if(lease.write&&session.mode!=='agent')throw new Error('用户已手动接管，尚未开始的写操作已停止。');
    const view=await this.serverWork(this.leaseView(session,lease));
    // Validation comes right before each Playwright MCP call, so it renews the lease for that call.
    lease.expiresAt=this.now()+this.budgets.leaseTtlMs;reply(200,view);return;
   }
   if(route==='/tabs'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;if(!lease||lease.owner!==input.owner)throw new Error('浏览器操作租约已失效，请重试。');
    if(input.action!=='list'&&(!lease.write||session.mode!=='agent'))throw new Error('用户已手动接管，标签页写操作已停止。');
    if(lease.operation)throw new Error('这个浏览器操作已在进行中。');
    // The lease stays until the tab change itself has finished or timed out, even if the bridge stops waiting.
    const operation=this.changeTabs(session,lease,input);lease.operation=operation.then(()=>{},()=>{});
    try{reply(200,await operation);}finally{lease.operation=undefined;lease.expiresAt=this.now()+this.budgets.leaseTtlMs;}return;
   }
   if(route==='/release'){
    const lease=input.leaseId?session.leases.get(input.leaseId):undefined;
    if(lease?.owner===input.owner){
     if(lease.operation)await lease.operation;
     let failed=input.failed===true;
     try{await this.serverWork((async()=>{
      await this.syncPages(session);
      const switching=input.tabId!==undefined||input.tabIndex!==undefined;
      if(switching&&(!lease.write||session.mode!=='agent'))throw new Error('只有 Agent 模式下的写操作可以切换当前标签页。');
      if(input.tabId){this.requirePage(session,input.tabId);session.activeId=input.tabId;}
      else if(Number.isInteger(input.tabIndex)){const page=session.context?.pages()[input.tabIndex!];if(!page)throw new Error('所选标签页已经关闭。');session.activeId=this.pageId(session,page);}
      session.lastFrame=undefined;await this.persist(session);
     })());}catch(error){failed=true;throw error;}finally{await this.finishActivity(session,lease.activityId,failed,lease.activityTargetId);session.leases.delete(lease.id);}
    }
    reply(200,{ok:true});return;
   }
   if(route==='/disconnect'){
    const owned=[...session.leases.values()].filter(lease=>lease.owner===input.owner);
    await Promise.all(owned.map(lease=>lease.operation));for(const lease of owned)this.revokeLease(session,lease.id);
    reply(200,{ok:true});return;
   }
   reply(404,{error:'Not found'});
  }catch(error){reply(409,{error:safeFailure(error)});}
 }
 /** An Agent's browser_tabs action. A new tab's page gets the same navigation time limit as the bridge budget allows. */
 private async changeTabs(session:LiveSession,lease:Lease,input:ControlInput){
  await this.syncPages(session);
  session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
  if(input.action==='new'){
   if(input.url!==undefined&&typeof input.url!=='string')throw new Error('请输入有效的网页地址。');
   const url=input.url!==undefined?normalizeNavigationUrl(input.url):null;
   if(session.pages.size>=session.settings.maxTabs)throw new Error(`已达到 ${session.settings.maxTabs} 个标签页上限，请先关闭不需要的页面。`);
   const page=await session.context!.newPage();session.activeId=await this.trackPage(session,page);lease.activityTargetId=session.activeId;if(url)await page.goto(url,{waitUntil:'domcontentloaded',timeout:this.budgets.tabNavigationMs});else await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});
  }else if(input.action==='select'||input.action==='close'){
   const tabId=input.tabId??(input.action==='close'?lease.targetId:null);
   if(!tabId)throw new Error('请提供标签页的稳定 tabId。');const page=this.requirePage(session,tabId);
   lease.activityTargetId=tabId;
   if(input.action==='select'){session.activeId=tabId;await page.bringToFront();}
   else{if(session.pageState.get(tabId)?.pinned)throw new Error('该标签页已固定，请先在面板取消固定。');await page.close();if(!session.pages.size){const created=await session.context!.newPage();session.activeId=await this.trackPage(session,created);await created.setContent(demoHtml(),{waitUntil:'domcontentloaded'});}}
  }else if(input.action!=='list')throw new Error('不支持的标签页操作。');
  if(lease.activityTargetId&&session.pages.has(lease.activityTargetId))session.activity.update(lease.activityId,this.activityPage(session,lease.activityTargetId),input.action);
  session.lastFrame=undefined;session.health=null;await this.persist(session);return {tabs:await this.targets(session),session:await this.state(session.workspaceId)};
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
 private async viewport(page:Page,session:LiveSession):Promise<{width:number;height:number}>{try{const size=await withTimeout(page.evaluate<{width:number;height:number}|null>('({width:window.innerWidth,height:window.innerHeight})'),this.budgets.viewportProbeMs,()=>null);if(size&&Number.isFinite(size.width)&&Number.isFinite(size.height)&&size.width>0&&size.height>0)return size;}catch{}return page.viewportSize()??{width:session.width,height:session.height};}
 /** Start Chromium and wait for its DevTools port. An exit before that is the caller's to handle, not a crash to recover from. */
 private async launchChromium(session:LiveSession,generation:number,launch:{executable:string;args:string[];environment:NodeJS.ProcessEnv;activePortFile:string},spawned:ChildProcess[]):Promise<{child:ChildProcess;port:number}>{
  await unlink(launch.activePortFile).catch(()=>{});
  const child=spawn(launch.executable,launch.args,{stdio:['ignore','ignore','pipe'],env:launch.environment});session.child=child;spawned.push(child);
  let launchError:string|null=null,startupLog='',listening=false;
  child.stderr?.on('data',chunk=>{if(!listening)startupLog=(startupLog+chunk.toString()).slice(-3000);});
  child.on('error',error=>{launchError=safeFailure(error);});
  child.on('exit',()=>{if(!listening||session.child!==child||generation!==session.generation)return;const unexpectedly=!session.stopping&&!this.disposed;session.activity.failRunning();session.child=undefined;session.browser=undefined;session.context=undefined;session.pages.clear();session.pageState.clear();session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.leases.clear();session.health=null;session.uptimeStart=null;if(unexpectedly){session.status='error';session.lastFailure=launchError??'Chromium 进程意外退出。';session.error=session.lastFailure;void this.persist(session).catch(()=>{});if(!session.starting)this.scheduleRecovery(session);}});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
   if(launchError)throw new Error(launchError);if(this.disposed||session.stopping)throw new Error('浏览器启动已停止。');
   if(child.exitCode!==null||child.signalCode!==null)throw Object.assign(new Error(startupLog.includes('error while loading shared libraries')?'Chromium 缺少系统运行库，请检查 runtime/lib。':'Chromium 启动失败。'),{exitedEarly:true,startupLog});
   try{const candidate=Number((await readFile(launch.activePortFile,'utf8')).split('\n')[0]);if(Number.isInteger(candidate)&&candidate>0&&candidate<65536){listening=true;return {child,port:candidate};}}catch{}
   await sleep(100);
  }
  throw new Error('Chromium 启动超时。');
 }
 private async boot(session:LiveSession,recovery=false):Promise<void>{
  await this.ensureGate();session.status=recovery?'recovering':'starting';session.error=null;session.stopping=false;session.health=null;session.generation++;const generation=session.generation;
  // Every directory the browser uses must be a real directory owned by the daemon user, set to 0700, before Chromium or runtime code starts.
  const directory=path.dirname(this.metadataPath(session.workspaceId)),profileDir=path.join(directory,'profile');
  await ensurePrivateDirectory(this.runtimeRoot,'服务器浏览器运行时目录');await ensurePrivateDirectory(directory,'工作区浏览器目录');await ensurePrivateDirectory(profileDir,'浏览器 Profile 目录');await ensurePrivateDirectory(this.artifactDir(session.workspaceId),'Agent 产物目录');
  const savedTabs=session.savedTabs.length?session.savedTabs.slice(0,session.settings.maxTabs):[{url:'about:blank',demo:true,pinned:false,active:true}];
  const exists=(file:string)=>access(file).then(()=>true,()=>false),libDirectory=path.join(this.runtimeRoot,'lib'),fontsConf=path.join(this.runtimeRoot,'fonts.conf');
  const environment=chromiumEnvironment(process.env,{libDirectory:await exists(libDirectory)?libDirectory:undefined,fontsConf:await exists(fontsConf)?fontsConf:undefined});
  const proxy=browserProxy(),mode=browserSandboxMode(),executable=await this.executable(),activePortFile=path.join(profileDir,'DevToolsActivePort');
  // Automatic mode tries Chromium's sandbox first and, if Chromium exits before it starts listening, starts it once more without.
  const attempts=mode==='on'?[true]:mode==='off'||this.sandboxUnavailable?[false]:[true,false];
  const spawned:ChildProcess[]=[];
  try{
   let launched:{child:ChildProcess;port:number}|undefined,sandboxed=false,fallbackReason:string|undefined;
   for(const [index,sandbox] of attempts.entries()){
    try{launched=await this.launchChromium(session,generation,{executable,args:chromiumArguments({profileDir,width:session.width,height:session.height,proxy,sandbox}),environment,activePortFile},spawned);sandboxed=sandbox;break;}
    catch(error){
     const failure=error as Error&{exitedEarly?:boolean;startupLog?:string};
     if(!(sandbox&&mode==='auto'&&failure.exitedEarly&&index<attempts.length-1))throw error;
     fallbackReason=sandboxFailure(failure.startupLog??'');
    }
   }
   if(!launched)throw new Error('Chromium 启动失败。');
   if(fallbackReason)this.sandboxUnavailable=fallbackReason;
   session.sandbox={enabled:sandboxed,mode,...(!sandboxed&&mode==='auto'&&this.sandboxUnavailable?{fallbackReason:this.sandboxUnavailable}:{})};
   session.cdpEndpoint=`http://127.0.0.1:${launched.port}`;
   const browser=await this.playwright().chromium.connectOverCDP(session.cdpEndpoint,{timeout:15000});session.browser=browser;const context=browser.contexts()[0];if(!context)throw new Error('Chromium 未提供持久浏览器会话。');session.context=context;context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(30000);
   context.on('page',page=>{if(generation===session.generation)void this.trackPage(session,page).catch(()=>{});});await this.syncPages(session);
   let activeId:string|null=null;
   for(let index=0;index<savedTabs.length;index++){
    if(this.disposed||session.stopping||generation!==session.generation||!session.desiredRunning)return;
    const saved=savedTabs[index],page=index===0?(session.context.pages()[0]??await context.newPage()):await context.newPage();const id=await this.trackPage(session,page);const state=session.pageState.get(id)!;state.pinned=saved.pinned;
    if(saved.demo){await page.goto('about:blank');await page.setContent(demoHtml(),{waitUntil:'domcontentloaded'});state.demo=true;}
    else{const url=restorableUrl(saved.url);if(url){try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}catch(error){state.requestFailure=safeFailure(error);state.url=url;session.lastFailure=state.requestFailure;}}}
    if(saved.active)activeId=id;
   }
   if(this.disposed||session.stopping||generation!==session.generation||!session.desiredRunning)return;
   if(activeId)session.activeId=activeId;session.status='running';session.uptimeStart=Date.now();session.epoch++;
   if(recovery){session.recoveryCount++;session.lastRecoveredAt=Date.now();}
   // A fresh control token for every start: the previous one stops working with the previous browser.
   session.token=randomBytes(32);
   await this.writeMetadata(session);await this.persist(session);await this.cleanArtifacts(session);
  }catch(error){
   const kill=()=>{for(const child of spawned)child.kill('SIGTERM');};
   if(this.disposed||generation!==session.generation||!session.desiredRunning){kill();return;}
   session.lastFailure=safeFailure(error);session.error=session.lastFailure;session.status='error';session.stopping=true;kill();throw error;
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
  // Titles and the viewport are read in parallel, each with its own time limit, so a page stuck in a script cannot hold up polling.
  const [tabs,size]=await Promise.all([Promise.all([...session.pages.entries()].filter(([,page])=>!page.isClosed()).map(async([id,page])=>{const title=await this.pageTitle(session,id,page),saved=session.pageState.get(id);if(saved)saved.title=title;return {id,title,url:page.url(),active:id===session.activeId,pinned:saved?.pinned??false};})),active?this.viewport(active,session):null]);
  const selected=tabs.find(tab=>tab.active);if(size){session.width=size.width;session.height=size.height;}
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
  // Stopping or restarting ends the browser itself, so it never queues behind a page call that does not return.
  const lifecycle=action.kind==='stop'||action.kind==='restart';
  const run=async()=>{
  if(action.kind==='settings'||action.kind==='cleanup')return this.performAction(workspaceId,action);
  if(!lifecycle)await this.syncPages(session);
  const originalTarget='tabId'in action?action.tabId:action.kind==='newTab'?null:session.activeId;
  const activityId=session.activity.start('manual',action.kind,this.activityPage(session,originalTarget));
  try{const result=await this.performAction(workspaceId,action,originalTarget);await this.finishActivity(session,activityId,false,originalTarget??(action.kind==='newTab'?session.activeId:null));result.activity=session.activity.snapshot();return result;}
  catch(error){await this.finishActivity(session,activityId,true,originalTarget);throw error;}
  };
  return lifecycle?run():this.serialized(session,run);
 }
 private async performAction(workspaceId:string,action:BrowserAction,originalTarget?:string|null):Promise<BrowserSession>{
  const session=this.session(workspaceId);await this.load(session);
   if(action.kind==='mode'){session.mode=action.mode;await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='settings'){session.settings=browserSettingsSchema.parse({...session.settings,...action.settings});if(!session.settings.autoRecover&&session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;session.status='error';}await this.persist(session);return this.state(workspaceId);}
   if(action.kind==='cleanup'){await this.cleanArtifacts(session);return this.state(workspaceId);}
   if(session.mode!=='manual')throw new Error('请先切换到「手动接管」再操作浏览器。');if(this.agentBusy(session))throw new Error('Agent 的浏览器操作正在结束，请稍后再操作。');
   session.manualOps++;const generation=session.generation;
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
      const fitted=await fitPageWidth(page!,2560,this.budgets.measureMs);
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
   }}catch(error){
    // A call cut short by stopping or restarting the browser is not this browser's error.
    if(generation===session.generation&&!session.stopping){if(['navigate','back','forward','reload'].includes(action.kind)){const state=session.activeId?session.pageState.get(session.activeId):undefined;if(state)state.requestFailure=safeFailure(error);session.health=null;}session.error=safeFailure(error);await this.persist(session);}
    throw error;}
   session.lastFrame=undefined;session.error=null;await this.persist(session);return this.state(workspaceId);
   }finally{session.manualOps--;}
 }
 async read(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>,source:BrowserActivity['source']='manual'):Promise<BrowserReading>{
  const session=this.session(workspaceId),tabId=input.tabId??session.activeId,activityId=session.activity.start(source,'browser_read_page',this.activityPage(session,tabId));
  try{const result=await this.performRead(workspaceId,input);await this.finishActivity(session,activityId,false,tabId);return result;}
  catch(error){await this.finishActivity(session,activityId,true,tabId);throw error;}
 }
 private async performRead(workspaceId:string,input:Omit<BrowserReadInput,'workspaceId'>):Promise<BrowserReading>{
  const session=this.session(workspaceId);if(session.status!=='running')throw new Error('请先启动服务器浏览器。');await this.syncPages(session);const parsed=readPageInputSchema.parse({...input,workspaceId});const page=parsed.tabId?this.requirePage(session,parsed.tabId):this.activePage(session);if(!page)throw new Error('当前没有可读取的标签页。');const id=this.pageId(session,page)!;return readPageContent(page,id,parsed,this.runtimeRoot,this.budgets.pageReadMs);
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
  checks.push({name:'浏览器与 CDP',status:cdpOk?'ok':'error',detail:cdpOk?'Chromium 与本机 CDP 只读探测正常。':'浏览器或 CDP 尚未就绪，可启动或等待恢复。'});
  checks.push(this.sandboxCheck(session));
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
   try{signals=await withTimeout(page.evaluate<{password:boolean;loginForm:boolean;hasContent:boolean}|null>(`(()=>{const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};const password=[...document.querySelectorAll('input[type=password]')].some(visible);const forms=[...document.querySelectorAll('form')].filter(visible);const loginForm=forms.some(f=>f.querySelector('input')&&/登录|登入|sign[ -]?in|log[ -]?in/i.test(f.innerText.slice(0,1500)));return{password,loginForm,hasContent:!!document.body?.innerText.trim()}})()`),this.budgets.diagnosticsScriptMs,()=>null);}catch{}
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
 /** Page diagnostics: is Chromium's sandbox on for the running browser, or will it be for the next start. */
 private sandboxCheck(session:LiveSession):BrowserDiagnostics['checks'][number]{
  const name='Chromium 沙箱',running=session.status==='running'&&session.sandbox;
  const mode=running?session.sandbox!.mode:browserSandboxMode(),fallback=running?session.sandbox!.fallbackReason:mode==='auto'?this.sandboxUnavailable??undefined:undefined;
  if(running&&session.sandbox!.enabled)return {name,status:'ok',detail:'已开启：网页进程在独立的用户命名空间和系统调用过滤中运行。'};
  if(mode==='off')return {name,status:'warning',detail:'已按 PASEO_SERVER_BROWSER_SANDBOX=0 关闭，网页进程拥有 daemon 用户的全部权限。'};
  if(fallback)return {name,status:'warning',detail:`这台主机无法开启（${fallback}），已自动改用 --no-sandbox 运行，网页进程拥有 daemon 用户的全部权限。启用非特权用户命名空间后重启浏览器即可开启。`};
  return {name,status:'ok',detail:mode==='on'?'浏览器启动时开启（PASEO_SERVER_BROWSER_SANDBOX=1，主机不支持时启动失败）。':'浏览器启动时开启；主机不支持时自动改用 --no-sandbox 并在这里提示。'};
 }
 async setAgentId(workspaceId:string,agentId:string|null):Promise<void>{const session=this.session(workspaceId);session.agentId=agentId;await this.atomicPrivate(path.join(path.dirname(this.metadataPath(workspaceId)),'agent.json'),JSON.stringify({agentId})+'\n');}
 async getAgentId(workspaceId:string):Promise<string|null>{const session=this.session(workspaceId);await this.load(session);return session.agentId;}
 private async stopSession(session:LiveSession,preserveDesired:boolean):Promise<void>{
  if(session.recoveryTimer){clearTimeout(session.recoveryTimer);session.recoveryTimer=undefined;}if(session.persistTimer){clearTimeout(session.persistTimer);session.persistTimer=undefined;}
  this.rememberTabs(session);session.stopping=true;if(!preserveDesired)session.desiredRunning=false;session.activity.failRunning(true);session.leases.clear();await this.persist(session);
  const child=session.child;session.generation++;session.token=null;session.sandbox=null;
  // Disconnecting must not wait on a page that stopped answering; the process is ended below either way.
  if(session.browser)await withTimeout(session.browser.close().catch(()=>{}),3000,()=>undefined);
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  session.browser=undefined;session.context=undefined;session.child=undefined;session.pages.clear();session.pageState.clear();session.pendingPages.clear();session.trackTail=Promise.resolve();session.activeId=null;session.lastFrame=undefined;session.status='idle';session.error=null;session.health=null;session.uptimeStart=null;await unlink(this.metadataPath(session.workspaceId)).catch(()=>{});
 }
 async close():Promise<void>{this.disposed=true;if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);await Promise.allSettled([...this.sessions.values()].map(async session=>{if(session.recoveryTimer)clearTimeout(session.recoveryTimer);session.stopping=true;await session.starting?.catch(()=>{});await this.stopSession(session,true);}));if(this.gate)await new Promise<void>(resolve=>{this.gate!.close(()=>resolve());this.gate!.closeAllConnections();});this.gate=undefined;this.gateEndpoint=undefined;}
}
