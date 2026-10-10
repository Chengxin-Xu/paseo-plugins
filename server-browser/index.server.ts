import type { PluginServerContext, PluginHandlerContext } from '@getpaseo/plugin/server';
import { actionRpc, agentRpc, diagnosticsRpc, frameRpc, optionsRpc, overviewRpc, readPageRpc, startRpc, stateRpc } from './shared/browser';
import { BrowserManager } from './server/browser-manager';
import { BrowserAgentService, WorkspaceDirectory, browserOptions, type PaseoWorkspace } from './server/service';
import { BrowserOverviewService } from './server/overview';

type Paseo=PluginHandlerContext['paseo'];

export default function contribute(server:PluginServerContext,deps:{manager?:BrowserManager;directory?:WorkspaceDirectory}={}){
 const manager=deps.manager??new BrowserManager(),directory=deps.directory??new WorkspaceDirectory(),agents=new BrowserAgentService(manager),overview=new BrowserOverviewService(manager,paseo=>directory.list(paseo));
 let restoreTask:Promise<void>|undefined;
 // The Agent bridge accepts file uploads only from the workspace's own directory, as the daemon reports it.
 const remember=(workspace:PaseoWorkspace)=>manager.setWorkspaceDirectory(workspace.id,workspace.workspaceDirectory??workspace.projectRootPath);
 const restore=(paseo:Paseo)=>{
  if(!restoreTask)restoreTask=directory.list(paseo).then(workspaces=>{
   for(const workspace of workspaces)remember(workspace);
   // Restore in the background: a slow site must not stall every panel RPC or Agent startup.
   void manager.restore(workspaces.map(item=>item.id)).catch(()=>console.warn('部分服务器浏览器未能恢复，请查看对应工作区的状态与诊断。'));
  }).catch(error=>{restoreTask=undefined;throw error;});
  return restoreTask;
 };
 // Lifecycle hooks only start restoration. The daemon awaits before-hooks and aborts the session open when one throws,
 // so an Agent never waits on (or fails because of) the workspace listing; the MCP bridge waits for a restoring browser itself.
 const restoreSoon=(paseo:Paseo)=>{void restore(paseo).catch(()=>console.warn('服务器浏览器暂时无法核对工作区，将在下次面板或 Agent 活动时重试恢复。'));};
 const validate=async(paseo:Paseo,workspaceId:string)=>{remember(await directory.require(paseo,workspaceId));await restore(paseo);};
 server.handle(optionsRpc,async(_input,{paseo})=>{await restore(paseo);return browserOptions(paseo,directory);});
 server.handle(overviewRpc,async({revision},{paseo})=>{await restore(paseo);const result=await overview.list(paseo);return revision&&revision===result.revision?{unchanged:true,revision,checkedAt:result.checkedAt}:result;});
 server.handle(startRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return manager.start(workspaceId);});
 server.handle(stateRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return manager.state(workspaceId);});
 server.handle(frameRpc,async({workspaceId,after,quality,maxWidth,maxHeight,sessionRevision},{paseo})=>{await validate(paseo,workspaceId);return manager.frame(workspaceId,after,quality,{maxWidth,maxHeight,sessionRevision});});
 server.handle(actionRpc,async({workspaceId,action},{paseo})=>{await validate(paseo,workspaceId);return manager.action(workspaceId,action);});
 server.handle(agentRpc,async({workspaceId,profileId},{paseo})=>{await validate(paseo,workspaceId);return agents.create(paseo,workspaceId,profileId);});
 server.handle(diagnosticsRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return manager.diagnostics(workspaceId);});
 server.handle(readPageRpc,async(input,{paseo})=>{await validate(paseo,input.workspaceId);return manager.read(input.workspaceId,input);});
 server.on('agent.turn_started',(_event,{paseo})=>{restoreSoon(paseo);});
 server.before('agent.session_open',(_input,{paseo})=>{restoreSoon(paseo);});
 server.on('workspace.created',()=>{directory.invalidate();});
 server.on('workspace.archived',()=>{directory.invalidate();});
 return()=>manager.close();
}
