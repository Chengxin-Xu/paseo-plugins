import { registerClientChunks } from "./server/ui-chunk";
import type { PluginServerContext, PluginHandlerContext } from '@getpaseo/plugin/server';
import { actionRpc, agentRpc, deleteOrphanRpc, diagnosticsRpc, frameRpc, inputRpc, optionsRpc, orphanRpc, overviewRpc, readPageRpc, servicesRpc, startRpc, stateRpc, stopOrphanRpc, type BrowserSession } from './shared/browser';
import { BrowserManager, withoutAddresses } from './server/browser-manager';
import { BrowserAgentDirectory, BrowserAgentService, WorkspaceDirectory, browserOptions, workspaceServices, type PaseoWorkspace } from './server/service';
import { BrowserOverviewService } from './server/overview';

type Paseo=PluginHandlerContext['paseo'];

export default function contribute(server:PluginServerContext,deps:{manager?:BrowserManager;directory?:WorkspaceDirectory}={}){
 registerClientChunks(server);
 const manager=deps.manager??new BrowserManager(),directory=deps.directory??new WorkspaceDirectory(),agentDirectory=new BrowserAgentDirectory(),agents=new BrowserAgentService(manager,agentDirectory),overview=new BrowserOverviewService(manager,paseo=>directory.list(paseo),agentDirectory);
 let restoreTask:Promise<void>|undefined;
 // An RPC error reaches the client and the daemon log as its message. Playwright names the whole page address there (query,
 // fragment and redirect target too), so every message loses its page addresses, as the saved state does.
 const handle:PluginServerContext['handle']=(contract,handler)=>server.handle(contract,async(input,context)=>{try{return await handler(input,context);}catch(error){throw new Error(withoutAddresses(error));}});
 // An archived workspace that comes back (restored, or its directory reopened) gets its browser back.
 directory.onRestore(workspaceId=>manager.unretire(workspaceId));
 // The Agent bridge accepts file uploads only from the workspace's own directory, as the daemon reports it; the name labels leftovers.
 const remember=(workspace:PaseoWorkspace)=>manager.setWorkspaceDirectory(workspace.id,workspace.workspaceDirectory??workspace.projectRootPath,[workspace.projectDisplayName,workspace.title??workspace.name].filter(Boolean).join(' / '));
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
 const linkedState=async(paseo:Paseo,session:BrowserSession)=>{
  const {availability}=await agentDirectory.inspect(paseo,session.workspaceId,session.agentId);
  manager.setAgentAvailability(session.workspaceId,availability);return {...session,agentAvailability:availability};
 };
 handle(optionsRpc,async(_input,{paseo})=>{await restore(paseo);return browserOptions(paseo,directory);});
 handle(overviewRpc,async({revision},{paseo})=>{await restore(paseo);const result=await overview.list(paseo);return revision&&revision===result.revision?{unchanged:true,revision,checkedAt:result.checkedAt}:result;});
 handle(startRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return linkedState(paseo,await manager.start(workspaceId));});
 handle(stateRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);return linkedState(paseo,await manager.state(workspaceId));});
 handle(frameRpc,async({workspaceId,after,quality,maxWidth,maxHeight,sessionRevision,viewerId},{paseo})=>{await validate(paseo,workspaceId);const {availability}=await agentDirectory.inspect(paseo,workspaceId,await manager.getAgentId(workspaceId));manager.setAgentAvailability(workspaceId,availability);return manager.frame(workspaceId,after,quality,{maxWidth,maxHeight,sessionRevision,viewerId});});
 handle(actionRpc,async({workspaceId,action,target},{paseo})=>{await validate(paseo,workspaceId);return linkedState(paseo,await manager.action(workspaceId,action,target));});
 handle(inputRpc,async(input,{paseo})=>{await validate(paseo,input.workspaceId);const result=await manager.input(input.workspaceId,input);return {...result,session:await linkedState(paseo,result.session)};});
 handle(servicesRpc,async({workspaceId},{paseo})=>{const workspace=await directory.current(paseo,workspaceId);remember(workspace);return {items:workspaceServices(workspace)};});
 handle(agentRpc,async({workspaceId,profileId},{paseo})=>{await validate(paseo,workspaceId);const result=await agents.create(paseo,workspaceId,profileId);return {...result,session:await linkedState(paseo,result.session)};});
 handle(diagnosticsRpc,async({workspaceId},{paseo})=>{await validate(paseo,workspaceId);const result=await manager.diagnostics(workspaceId);return {...result,session:await linkedState(paseo,result.session)};});
 handle(readPageRpc,async(input,{paseo})=>{await validate(paseo,input.workspaceId);return manager.read(input.workspaceId,input);});
 server.on('agent.turn_started',(_event,{paseo})=>{restoreSoon(paseo);});
 server.before('agent.session_open',(_input,{paseo})=>{restoreSoon(paseo);});
 // Orphan cleanup deliberately bypasses require(): an archived workspace has no normal panel entry.
 handle(orphanRpc,async(_input,{paseo})=>({items:await manager.listOrphans((await directory.list(paseo)).map(item=>item.id))}));
 // Stopping or deleting a leftover retires that workspace in the manager; the directory records it too, so that if the
 // daemon restores the workspace later (same id, no event) the next listing gives it its browser back, as after an archive.
 handle(stopOrphanRpc,async({workspaceId},{paseo})=>{directory.invalidate();await manager.stopOrphan(workspaceId,(await directory.list(paseo)).map(item=>item.id));directory.retire(workspaceId);return {stopped:true as const};});
 // Deleting logins needs a complete, fresh listing: a workspace that is still there is refused.
 handle(deleteOrphanRpc,async({workspaceId},{paseo})=>{directory.invalidate();await manager.deleteOrphan(workspaceId,(await directory.list(paseo)).map(item=>item.id));directory.retire(workspaceId);return {deleted:true as const};});
 const invalidateAgent=(workspaceId:string|null)=>{agentDirectory.invalidate(workspaceId??undefined);overview.invalidate();};
 server.on('agent.archived',({agent})=>{invalidateAgent(agent.workspaceId);});
 server.on('agent.closed',({agent})=>{invalidateAgent(agent.workspaceId);});
 server.on('agent.created',({agent})=>{invalidateAgent(agent.workspaceId);});
 server.on('workspace.created',()=>{directory.invalidate();overview.invalidate();});
 server.on('workspace.archived',async({workspace})=>{directory.retire(workspace.id);agentDirectory.invalidate(workspace.id);overview.invalidate();await manager.retireWorkspace(workspace.id);});
 return()=>manager.close();
}
