import { readdir } from 'node:fs/promises';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import type { BrowserManager } from './browser-manager';
import type { BrowserOverviewItem, BrowserSession, BrowserWorkspace } from '../shared/browser';
import { listBrowserWorkspaces, type PaseoWorkspace } from './service';
import { contentRevision } from './revision';

type Paseo = PluginHandlerContext['paseo'];
type Manager = Pick<BrowserManager,'dataRoot'|'state'>;
type Overview = {items:BrowserOverviewItem[];checkedAt:number;revision:string};

export function overviewPageUrl(value:string):string {
  try { const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.origin+url.pathname:value==='about:blank'?'本地体验页':''; }
  catch { return ''; }
}
/** Cards and Agent tabs read status, page identity, health and work in progress; history, tab lists, settings and runtime stay out of the polled summary. */
export function overviewSession(session:BrowserSession):BrowserSession {
  const {runtime:_runtime,settings:_settings,...summary}=session;
  return {...summary,url:overviewPageUrl(session.url),tabs:[],activity:(session.activity??[]).filter(item=>item.status==='running').map(item=>({...item,pageUrl:overviewPageUrl(item.pageUrl)}))};
}
/** observedAt changes on every read; the revision covers everything a client renders. */
export function overviewRevision(items:readonly BrowserOverviewItem[]):string {
  return contentRevision(items.map(({observedAt:_observedAt,...item})=>item));
}
async function bounded<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('状态读取超时')),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Metadata only: inspecting the directory never creates a browser, workspace, project or Agent. */
export class BrowserOverviewService {
  private pending?:Promise<Overview>;
  private previous?:Overview;
  constructor(private manager:Manager,private workspaces:(paseo:Paseo)=>Promise<PaseoWorkspace[]>=listBrowserWorkspaces){}
  async list(paseo:Paseo):Promise<Overview>{
    if(this.pending)return this.pending;
    if(this.previous&&Date.now()-this.previous.checkedAt<800)return this.previous;
    this.pending=this.read(paseo).then(result=>{this.previous=result;return result;});
    try{return await this.pending;}finally{this.pending=undefined;}
  }
  private async read(paseo:Paseo):Promise<Overview>{
    const workspaces=await this.workspaces(paseo);
    const directories=await readdir(this.manager.dataRoot,{withFileTypes:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
    const saved=new Set(directories.filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).map(entry=>entry.name));
    const targets=workspaces.filter(workspace=>saved.has(workspace.id));
    const items:BrowserOverviewItem[]=[];
    let cursor=0;
    const worker=async()=>{
      while(cursor<targets.length){
        const source=targets[cursor++];
        const workspace:BrowserWorkspace={id:source.id,title:source.title??source.name??source.projectDisplayName,cwd:source.workspaceDirectory??source.projectRootPath,projectId:source.projectId??null,projectTitle:source.projectDisplayName};
        let session:BrowserSession;
        try{session=overviewSession(await bounded(this.manager.state(workspace.id),3500));}
        catch{session={workspaceId:workspace.id,status:'error',title:'状态暂不可用',url:'',mode:'manual',width:1120,height:720,tabs:[],agentId:null,error:'此工作区浏览器状态暂时无法读取，请稍后刷新。',agentBusy:false,activity:[]};}
        let agent:BrowserOverviewItem['agent']=null;
        if(session.agentId){
          try{
            const ref=paseo.agents.ref(session.agentId);await bounded(ref.refresh(),2500);const current=ref.current();
            if(current&&current.workspaceId===workspace.id&&!current.archivedAt){agent={id:current.id,title:current.title||'浏览器 Agent',status:current.status,provider:current.provider,needsPermission:Boolean(current.pendingPermissions?.length)};}
          }catch{ /* An unavailable Agent must not be guessed from unrelated running sessions. */ }
        }
        items.push({workspace,session,agent,observedAt:Date.now()});
      }
    };
    await Promise.all(Array.from({length:Math.min(4,targets.length)},worker));
    items.sort((a,b)=>{
      const rank=(item:BrowserOverviewItem)=>item.session.agentBusy?0:item.agent?.needsPermission||item.session.health?.state==='login_required'?1:item.session.status==='running'?2:3;
      return rank(a)-rank(b)||(a.workspace.projectTitle??'').localeCompare(b.workspace.projectTitle??'')||a.workspace.title.localeCompare(b.workspace.title);
    });
    return {items,checkedAt:Date.now(),revision:overviewRevision(items)};
  }
}
