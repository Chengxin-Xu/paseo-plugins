import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../index.server';
import { BrowserManager } from '../server/browser-manager';
import { WorkspaceDirectory, type PaseoWorkspace } from '../server/service';

type Handler=(input:unknown,context:{paseo:unknown})=>Promise<any>;

// codex-sb-F7: the plugin starts after a workspace was archived (no workspace.archived event reaches it), its leftovers are
// stopped or deleted from the orphan list, then the daemon restores the same workspace id. Its browser must work again.
for(const cleanup of ['delete','stop'] as const)test(`a workspace restored after its leftovers were ${cleanup === 'delete' ? 'deleted' : 'stopped'} from a cold start gets its browser back (codex-sb-F7)`,async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'sb-orphan-restore-')),manager=new BrowserManager({dataRoot});
  await mkdir(path.join(dataRoot,'restorable','profile'),{recursive:true,mode:0o700});await writeFile(path.join(dataRoot,'restorable','profile','sentinel'),'login');
  const handlers=new Map<string,Handler>();
  const server={handle:(contract:{name:string},handler:Handler)=>{handlers.set(contract.name,handler);},on:()=>()=>{},before:()=>()=>{},registerSettings(){return {read:async()=>({status:'ready',revision:'r1',values:{language:'zh-CN'}}),subscribe:()=>()=>{}};},registerProvider(){}} as unknown as PluginServerContext;
  let entries:PaseoWorkspace[]=[];
  const paseo={workspaces:{list:async()=>({entries,pageInfo:{hasMore:false}})}};
  const stop=contribute(server,{manager,directory:new WorkspaceDirectory()});
  try{
    const orphans=await handlers.get('browser.orphans')!({},{paseo});
    assert.deepEqual(orphans.items.map((item:{workspaceId:string})=>item.workspaceId),['restorable']);
    await handlers.get(`browser.orphan.${cleanup}`)!({workspaceId:'restorable'},{paseo});
    await assert.rejects(manager.state('restorable'),/工作区已归档/,'cleaning up retires it in the manager');
    // Restored under the same id, without an event: the next panel call lists it again and its browser is usable.
    entries=[{id:'restorable',projectRootPath:dataRoot,workspaceDirectory:dataRoot,projectDisplayName:'Restored',name:'main',scripts:[]} as unknown as PaseoWorkspace];
    const state=await handlers.get('browser.state')!({workspaceId:'restorable'},{paseo});
    assert.equal(state.workspaceId,'restorable');assert.equal(state.status,'idle');
    assert.equal((await handlers.get('browser.state')!({workspaceId:'restorable'},{paseo})).status,'idle','and stays usable');
    assert.deepEqual((await handlers.get('browser.orphans')!({},{paseo})).items,[],'no longer listed as left behind');
  }finally{await stop();await rm(dataRoot,{recursive:true,force:true});}
});
