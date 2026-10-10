import path from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import type { BrowserProfile, BrowserWorkspace } from '../shared/browser';
import { BrowserManager } from './browser-manager';

type Paseo=PluginHandlerContext['paseo'];
/** The daemon's workspace descriptor, taken from the host SDK so the server bundle needs no installed packages. */
export type PaseoWorkspace=Awaited<ReturnType<Paseo['workspaces']['list']>>['entries'][number];
type AgentResult={agentId:string;created:boolean;session:Awaited<ReturnType<BrowserManager['state']>>};

export async function listBrowserWorkspaces(paseo:Paseo):Promise<PaseoWorkspace[]> {
  const entries:PaseoWorkspace[]=[];let cursor:string|undefined;
  do {
    const page=await paseo.workspaces.list({page:{limit:200,...(cursor?{cursor}:{})}});
    entries.push(...page.entries);
    const next=page.pageInfo.hasMore?page.pageInfo.nextCursor:null;
    if(!next||next===cursor)break;cursor=next;
  }while(entries.length<5000);
  return entries.filter(workspace=>!workspace.archivingAt);
}

function checkedWorkspace(workspace:PaseoWorkspace|undefined):PaseoWorkspace {
  if(!workspace)throw new Error('该工作区已不可用，请选择当前服务器上的工作区。');
  const cwd=workspace.workspaceDirectory??workspace.projectRootPath;
  if(!path.isAbsolute(cwd))throw new Error('工作区目录不是服务器上的绝对路径。');
  return workspace;
}

export async function requireBrowserWorkspace(paseo:Paseo,workspaceId:string):Promise<PaseoWorkspace> {
  return checkedWorkspace((await listBrowserWorkspaces(paseo)).find(item=>item.id===workspaceId));
}

/**
 * The daemon rebuilds every workspace descriptor (with a synchronous paseo.json read each) per listing.
 * Frame polling and input validate on every call, so they share one short-lived listing instead.
 * workspace.created/archived hooks invalidate it; an unknown id is confirmed with one fresh read.
 */
export class WorkspaceDirectory {
  private cached?:{at:number;entries:PaseoWorkspace[]};
  private pending?:{generation:number;task:Promise<PaseoWorkspace[]>};
  private generation=0;
  constructor(private readonly ttlMs=30_000,private readonly now:()=>number=Date.now,private readonly source:(paseo:Paseo)=>Promise<PaseoWorkspace[]>=listBrowserWorkspaces){}
  invalidate():void{this.generation++;this.cached=undefined;}
  async list(paseo:Paseo):Promise<PaseoWorkspace[]>{return (await this.read(paseo,false)).entries;}
  async require(paseo:Paseo,workspaceId:string):Promise<PaseoWorkspace>{
    const first=await this.read(paseo,false);let workspace=first.entries.find(item=>item.id===workspaceId);
    if(!workspace&&first.cached)workspace=(await this.read(paseo,true)).entries.find(item=>item.id===workspaceId);
    return checkedWorkspace(workspace);
  }
  private async read(paseo:Paseo,fresh:boolean):Promise<{entries:PaseoWorkspace[];cached:boolean}>{
    if(!fresh&&this.cached&&this.now()-this.cached.at<this.ttlMs)return {entries:this.cached.entries,cached:true};
    // Share an in-flight listing only if no invalidation happened after it started.
    if(this.pending?.generation!==this.generation){
      const generation=this.generation,task=this.source(paseo).then(entries=>{if(generation===this.generation)this.cached={at:this.now(),entries};return entries;});
      const pending={generation,task};this.pending=pending;
      void task.finally(()=>{if(this.pending===pending)this.pending=undefined;}).catch(()=>{});
    }
    return {entries:await this.pending!.task,cached:false};
  }
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
  constructor(private readonly manager:BrowserManager){}
  async create(paseo:Paseo,workspaceId:string,profileId?:string):Promise<AgentResult>{
    const pending=this.creating.get(workspaceId);if(pending)return pending;
    const operation=this.createOnce(paseo,workspaceId,profileId);this.creating.set(workspaceId,operation);
    try{return await operation;}finally{if(this.creating.get(workspaceId)===operation)this.creating.delete(workspaceId);}
  }
  private async createOnce(paseo:Paseo,workspaceId:string,profileId?:string):Promise<AgentResult>{
    const workspace=await requireBrowserWorkspace(paseo,workspaceId);
    await this.manager.start(workspaceId);
    const label='server-browser.workspace';
    const existing=await paseo.agents.list({filter:{labels:{[label]:workspaceId},includeArchived:false},page:{limit:200}});
    const reusable=existing.entries.map(item=>item.agent).find(agent=>agent.workspaceId===workspaceId&&!agent.archivedAt&&agent.status!=='closed');
    if(reusable){await this.manager.setAgentId(workspaceId,reusable.id);return {agentId:reusable.id,created:false,session:await this.manager.state(workspaceId)};}

    const cwd=workspace.workspaceDirectory??workspace.projectRootPath;
    const [{config},initialCatalog]=await Promise.all([paseo.config.get(),paseo.providers.snapshot({cwd})]);
    let catalog=initialCatalog;
    if(!catalog.entries.some(entry=>entry.enabled!==false&&entry.status==='ready'))catalog=await paseo.providers.waitForReady({cwd,timeoutMs:8000}).catch(()=>paseo.providers.snapshot({cwd}));
    const profiles=config.agentProfiles??[];
    const available=profiles.filter(profile=>catalog.entries.some(entry=>entry.provider===profile.provider&&entry.enabled!==false&&entry.status==='ready'));
    // The panel always sends its selection (the first profile by default); without one, use the first usable profile.
    const profile=profileId?profiles.find(item=>item.id===profileId):available[0];
    if(profileId&&!profile)throw new Error('所选 Agent Profile 已不存在，请重新选择。');
    const provider=profile?catalog.entries.find(entry=>entry.provider===profile.provider&&entry.enabled!==false&&entry.status==='ready'):catalog.entries.find(entry=>entry.enabled!==false&&entry.status==='ready');
    if(!provider)throw new Error('没有可用的 Agent provider，请检查 Paseo 的模型配置。');
    const model=profile?.model??provider.models?.find(item=>item.isDefault&&item.isSelectable!==false)?.id??provider.models?.find(item=>item.isSelectable!==false)?.id;
    if(!model)throw new Error('没有可用的 Agent 模型，请检查所选 Profile。');
    const agent=await paseo.workspaces.ref(workspace).agents.create({
      config:{
        provider:`${provider.provider}/${model}`,
        ...(profile?.modeId?{modeId:profile.modeId}:{}),
        ...(profile?.thinkingOptionId?{thinkingOptionId:profile.thinkingOptionId}:{}),
        ...(profile?.featureValues?{featureValues:profile.featureValues}:{}),
        systemPrompt:'你是本工作区的共享服务器浏览器 Agent。网页操作优先使用 server_browser MCP；它连接 Linux 服务器上的持久浏览器，用户通过 Paseo 面板观看并接管同一会话。Paseo 原生 browser 工具连接的是另一套浏览器，除非用户明确要求，不要自动换过去。访问不熟悉的站点后先用 browser_diagnostics 判断页面与登录提示；这仅是只读检查，不能把页面可访问当作已经登录。阅读文章优先使用 browser_read_page；操作前确认稳定 tabId 与目标页面。用户切为手动模式时停止所有浏览器写操作，不得通过 shell、直接 CDP 或别的工具绕过接管门禁。浏览器意外退出可自动恢复页面与已有 Profile，但不要自行重放提交、支付或其他写操作，也不要关闭浏览器进程。目标标签已关闭时重新确认，不能猜测另一标签继续执行。',
        mcpServers:{server_browser:{type:'stdio',command:process.execPath,args:[this.manager.bridgePath,this.manager.metadataPath(workspaceId)],alwaysLoad:true}},
      },
      title:'共享服务器浏览器',autoArchive:false,labels:{[label]:workspaceId},
    });
    await this.manager.setAgentId(workspaceId,agent.id);
    await this.manager.action(workspaceId,{kind:'mode',mode:'agent'});
    await agent.send('你已接入这个工作区的共享服务器浏览器。使用 server_browser MCP 工具操作，用户可在 Paseo 的「服务器浏览器」面板实时观看同一个页面。该浏览器在 Linux 服务器上运行，与 Paseo 原生 browser 工具是两个不同会话；后续用户要求操作共享浏览器时优先使用 server_browser。用户切换「手动接管」后，MCP 会阻止你的写操作，只读查看仍然允许；收到该提示后请等待用户恢复 Agent 模式，不要换用 shell、CDP 或其他工具绕过。浏览器和登录状态由面板管理，不要关闭进程。本条只需简短确认准备就绪，暂时不要导航、输入或点击网页。');
    return {agentId:agent.id,created:true,session:await this.manager.state(workspaceId)};
  }
}
