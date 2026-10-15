import { currentLanguage } from '../shared/i18n';
import { t } from '../shared/text';
import path from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import type { BrowserOverviewItem, BrowserProfile, BrowserService, BrowserWorkspace } from '../shared/browser';
import { BrowserManager } from './browser-manager';

type Paseo=PluginHandlerContext['paseo'];
/** The daemon's workspace descriptor, taken from the host SDK so the server bundle needs no installed packages. */
export type PaseoWorkspace=Awaited<ReturnType<Paseo['workspaces']['list']>>['entries'][number];
type AgentResult={agentId:string;created:boolean;session:Awaited<ReturnType<BrowserManager['state']>>};
type PaseoAgent=Awaited<ReturnType<Paseo['agents']['list']>>['entries'][number]['agent'];
type AgentLink={availability:'available'|'unavailable'|'unknown';agent:BrowserOverviewItem['agent']};

export async function listBrowserWorkspaces(paseo:Paseo):Promise<PaseoWorkspace[]> {
  const entries:PaseoWorkspace[]=[];let cursor:string|undefined;
  do {
    const page=await paseo.workspaces.list({page:{limit:200,...(cursor?{cursor}:{})}});
    entries.push(...page.entries);
    if(!page.pageInfo.hasMore)break;
    const next=page.pageInfo.nextCursor;
    // Orphan cleanup must not mistake an incomplete directory for a list of removed workspaces.
    if(!next||next===cursor||entries.length>=5000)throw new Error(t('serverError.workspaceListIncomplete'));
    cursor=next;
  }while(true);
  return entries.filter(workspace=>!workspace.archivingAt);
}

function checkedWorkspace(workspace:PaseoWorkspace|undefined):PaseoWorkspace {
  if(!workspace)throw new Error(t('serverError.workspaceUnavailable'));
  const cwd=workspace.workspaceDirectory??workspace.projectRootPath;
  if(!path.isAbsolute(cwd))throw new Error(t('serverError.workspacePathRelative'));
  return workspace;
}

export async function requireBrowserWorkspace(paseo:Paseo,workspaceId:string):Promise<PaseoWorkspace> {
  return checkedWorkspace((await listBrowserWorkspaces(paseo)).find(item=>item.id===workspaceId));
}

/**
 * The daemon rebuilds every workspace descriptor (with a synchronous paseo.json read each) per listing.
 * Frame polling and input validate on every call, so they share one short-lived listing instead.
 * workspace.created/archived hooks invalidate it; an unknown id is confirmed with one fresh read.
 * An archived workspace is retired until a listing that started after its archiving shows it again: the daemon restores
 * archived workspaces (and reopened directories) under the same id without a workspace.created event.
 */
export class WorkspaceDirectory {
  private cached?:{at:number;entries:PaseoWorkspace[]};
  private pending?:{generation:number;task:Promise<PaseoWorkspace[]>};
  private generation=0;
  /** Retired workspace → the listing generation of its retirement; only later listings can bring it back. */
  private retired=new Map<string,number>();
  private restored?:(workspaceId:string)=>Promise<void>|void;
  constructor(private readonly ttlMs=30_000,private readonly now:()=>number=Date.now,private readonly source:(paseo:Paseo)=>Promise<PaseoWorkspace[]>=listBrowserWorkspaces){}
  invalidate():void{this.generation++;this.cached=undefined;}
  retire(workspaceId:string):void{this.invalidate();this.retired.set(workspaceId,this.generation);}
  /** Called (and awaited) before a restored workspace is listed again. */
  onRestore(listener:(workspaceId:string)=>Promise<void>|void):void{this.restored=listener;}
  async list(paseo:Paseo):Promise<PaseoWorkspace[]>{return (await this.read(paseo,false)).entries.filter(item=>!this.retired.has(item.id));}
  async require(paseo:Paseo,workspaceId:string):Promise<PaseoWorkspace>{
    const first=await this.read(paseo,false);let workspace=first.entries.find(item=>item.id===workspaceId);
    if(!workspace&&first.cached)workspace=(await this.read(paseo,true)).entries.find(item=>item.id===workspaceId);
    return checkedWorkspace(this.retired.has(workspaceId)?undefined:workspace);
  }
  /** A fresh descriptor (scripts and their ports change while the cache lives). */
  async current(paseo:Paseo,workspaceId:string):Promise<PaseoWorkspace>{
    const workspace=(await this.read(paseo,true)).entries.find(item=>item.id===workspaceId);
    return checkedWorkspace(this.retired.has(workspaceId)?undefined:workspace);
  }
  private async restore(entries:PaseoWorkspace[],generation:number):Promise<void>{
    for(const entry of entries){
      const retiredAt=this.retired.get(entry.id);if(retiredAt===undefined||generation<retiredAt)continue;
      try{await this.restored?.(entry.id);}catch{continue;}
      if(this.retired.get(entry.id)===retiredAt)this.retired.delete(entry.id);
    }
  }
  private async read(paseo:Paseo,fresh:boolean):Promise<{entries:PaseoWorkspace[];cached:boolean}>{
    if(!fresh&&this.cached&&this.now()-this.cached.at<this.ttlMs)return {entries:this.cached.entries,cached:true};
    // Share an in-flight listing only if no invalidation happened after it started.
    if(this.pending?.generation!==this.generation){
      const generation=this.generation,task=this.source(paseo).then(async entries=>{await this.restore(entries,generation);if(generation===this.generation)this.cached={at:this.now(),entries};return entries;});
      const pending={generation,task};this.pending=pending;
      void task.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});
    }
    return {entries:await this.pending!.task,cached:false};
  }
}

/** Agent list reads metadata only; polling must never load an Agent session or its timeline. */
export class BrowserAgentDirectory {
  private cached=new Map<string,{at:number;agents:PaseoAgent[]}>();
  private pending=new Map<string,Promise<PaseoAgent[]>>();
  constructor(private readonly ttlMs=5000,private readonly now:()=>number=Date.now){}
  invalidate(workspaceId?:string):void{if(workspaceId){this.cached.delete(workspaceId);this.pending.delete(workspaceId);}else{this.cached.clear();this.pending.clear();}}
  async list(paseo:Paseo,workspaceId:string,fresh=false):Promise<PaseoAgent[]>{
    const cached=this.cached.get(workspaceId);
    if(!fresh&&cached&&this.now()-cached.at<this.ttlMs)return cached.agents;
    if(!fresh&&this.pending.has(workspaceId))return this.pending.get(workspaceId)!;
    const operation=this.read(paseo,workspaceId);this.pending.set(workspaceId,operation);
    try{const agents=await operation;if(this.pending.get(workspaceId)===operation)this.cached.set(workspaceId,{at:this.now(),agents});return agents;}
    finally{if(this.pending.get(workspaceId)===operation)this.pending.delete(workspaceId);}
  }
  private async read(paseo:Paseo,workspaceId:string):Promise<PaseoAgent[]>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error(t('serverError.agentStateTimeout')));},2500);});
    const read=async()=>{
      const agents:PaseoAgent[]=[];let cursor:string|undefined;
      do{
        const page=await paseo.agents.list({filter:{labels:{'server-browser.workspace':workspaceId},includeArchived:true},page:{limit:200,...(cursor?{cursor}:{})},signal:controller.signal,timeout:2500});
        if(controller.signal.aborted)throw new Error(t('serverError.agentStateTimeout'));
        agents.push(...page.entries.map(item=>item.agent));
        if(!page.pageInfo?.hasMore)return agents;
        const next=page.pageInfo.nextCursor;
        if(!next||next===cursor)throw new Error(t('serverError.agentListIncomplete'));
        cursor=next;
      }while(agents.length<5000);
      throw new Error(t('serverError.agentListIncomplete'));
    };
    try{return await Promise.race([read(),timeout]);}finally{if(timer)clearTimeout(timer);}
  }
  async inspect(paseo:Paseo,workspaceId:string,agentId:string|null):Promise<AgentLink>{
    if(!agentId)return {availability:'unavailable',agent:null};
    try{
      const current=(await this.list(paseo,workspaceId)).find(agent=>agent.id===agentId);
      // `closed` only means the daemon has not loaded the session (after a restart, say): opening or messaging it loads it.
      if(!current||current.workspaceId!==workspaceId||current.archivedAt)return {availability:'unavailable',agent:null};
      return {availability:'available',agent:{id:current.id,title:current.title||t('serverAgent.name'),status:current.status,provider:current.provider,needsPermission:Boolean(current.pendingPermissions?.length)}};
    }catch{return {availability:'unknown',agent:null};}
  }
}

/** The workspace's services (paseo.json scripts of type service): a running one opens straight from the daemon host. */
export function workspaceServices(workspace:PaseoWorkspace):BrowserService[]{
  return (workspace.scripts??[]).filter(script=>script.type==='service').map(script=>({
    name:script.scriptName.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,80),port:script.port,running:script.lifecycle==='running',health:script.health,
    url:script.port?`http://127.0.0.1:${script.port}/`:script.localProxyUrl??null,
  })).sort((a,b)=>Number(b.running)-Number(a.running)||a.name.localeCompare(b.name));
}

export async function browserOptions(paseo:Paseo,directory?:WorkspaceDirectory):Promise<{workspaces:BrowserWorkspace[];profiles:BrowserProfile[]}> {
  const [workspaces,{config}]=await Promise.all([directory?directory.list(paseo):listBrowserWorkspaces(paseo),paseo.config.get()]);
  return {
    // No directory paths: the client shows names only.
    workspaces:workspaces.map(item=>({id:item.id,title:item.title??item.name??item.projectDisplayName,projectId:item.projectId??null,projectTitle:item.projectDisplayName})),
    profiles:(config.agentProfiles??[]).map(profile=>({id:profile.id,name:profile.name,provider:profile.provider,model:profile.model??null})),
  };
}

/** Browser agents are created only by the explicit panel button, never during frame polling. */
export class BrowserAgentService {
  private creating=new Map<string,Promise<AgentResult>>();
  constructor(private readonly manager:BrowserManager,private readonly directory=new BrowserAgentDirectory()){}
  async create(paseo:Paseo,workspaceId:string,profileId?:string):Promise<AgentResult>{
    const pending=this.creating.get(workspaceId);if(pending)return pending;
    const operation=this.createOnce(paseo,workspaceId,profileId);this.creating.set(workspaceId,operation);
    try{return await operation;}finally{if(this.creating.get(workspaceId)===operation)this.creating.delete(workspaceId);}
  }
  private async createOnce(paseo:Paseo,workspaceId:string,profileId?:string):Promise<AgentResult>{
    const workspace=await requireBrowserWorkspace(paseo,workspaceId);
    await this.manager.start(workspaceId);
    const label='server-browser.workspace';
    // A failed or incomplete lookup stops here: reconnecting must not silently create a duplicate Agent.
    const existing=await this.directory.list(paseo,workspaceId,true),saved=await this.manager.getAgentId(workspaceId);
    // Unloaded (`closed`) Agents are reused too: the daemon loads them when opened. The linked one first, else the latest.
    const candidates=existing.filter(agent=>agent.workspaceId===workspaceId&&!agent.archivedAt).sort((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??'')));
    const reusable=candidates.find(agent=>agent.id===saved)??candidates[0];
    if(reusable){await this.manager.setAgentId(workspaceId,reusable.id);return {agentId:reusable.id,created:false,session:await this.manager.state(workspaceId)};}

    const cwd=workspace.workspaceDirectory??workspace.projectRootPath;
    const [{config},initialCatalog]=await Promise.all([paseo.config.get(),paseo.providers.snapshot({cwd})]);
    let catalog=initialCatalog;
    if(!catalog.entries.some(entry=>entry.enabled!==false&&entry.status==='ready'))catalog=await paseo.providers.waitForReady({cwd,timeoutMs:8000}).catch(()=>paseo.providers.snapshot({cwd}));
    const profiles=config.agentProfiles??[];
    const available=profiles.filter(profile=>catalog.entries.some(entry=>entry.provider===profile.provider&&entry.enabled!==false&&entry.status==='ready'));
    // The panel always sends its selection (the first profile by default); without one, use the first usable profile.
    const profile=profileId?profiles.find(item=>item.id===profileId):available[0];
    if(profileId&&!profile)throw new Error(t('serverError.profileMissing'));
    const provider=profile?catalog.entries.find(entry=>entry.provider===profile.provider&&entry.enabled!==false&&entry.status==='ready'):catalog.entries.find(entry=>entry.enabled!==false&&entry.status==='ready');
    if(!provider)throw new Error(t('serverError.noProvider'));
    const model=profile?.model??provider.models?.find(item=>item.isDefault&&item.isSelectable!==false)?.id??provider.models?.find(item=>item.isSelectable!==false)?.id;
    if(!model)throw new Error(t('serverError.noModel'));
    const agent=await paseo.workspaces.ref(workspace).agents.create({
      config:{
        provider:`${provider.provider}/${model}`,
        ...(profile?.modeId?{modeId:profile.modeId}:{}),
        ...(profile?.thinkingOptionId?{thinkingOptionId:profile.thinkingOptionId}:{}),
        ...(profile?.featureValues?{featureValues:profile.featureValues}:{}),
        systemPrompt:[t('serverAgent.systemPrompt'),t('serverAgent.responseLanguage',{language:currentLanguage()})].join('\n'),
        mcpServers:{server_browser:{type:'stdio',command:process.execPath,args:[this.manager.bridgePath,this.manager.metadataPath(workspaceId)],alwaysLoad:true}},
      },
      title:t('serverAgent.sharedTitle'),autoArchive:false,labels:{[label]:workspaceId},
    });
    await this.manager.setAgentId(workspaceId,agent.id);
    this.directory.invalidate(workspaceId);
    await this.manager.action(workspaceId,{kind:'mode',mode:'agent'});
    await agent.send(t('serverAgent.introduction'));
    return {agentId:agent.id,created:true,session:await this.manager.state(workspaceId)};
  }
}
