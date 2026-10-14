import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '../server/browser-manager';
import { defaultRuntimeRoot } from '../server/runtime';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForExit(pid:number){
  for(let attempt=0;attempt<40;attempt++){
    try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
    await pause(50);
  }
  assert.fail('The isolated Chromium process did not exit');
}

test('retiring a workspace stops its Chromium, revokes leases and recovery, and keeps the profile', {timeout:30_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-retirement-'));
  let manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
  const workspaceId='archived-workspace';
  try{
    manager.setWorkspaceDirectory(workspaceId,dataRoot);
    await manager.start(workspaceId);
    await manager.action(workspaceId,{kind:'mode',mode:'agent'});
    const metadata=JSON.parse(await readFile(manager.metadataPath(workspaceId),'utf8'));
    const profileSentinel=path.join(dataRoot,workspaceId,'profile','retirement-test.txt');
    await writeFile(profileSentinel,'saved profile');
    const response=await fetch(`${metadata.endpoint}/acquire`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${metadata.token}`},body:JSON.stringify({workspaceId,owner:'retirement-test',pid:process.pid,write:true})});
    assert.equal(response.status,200);assert.equal((await manager.state(workspaceId)).agentBusy,true);
    const internals=manager as unknown as {sessions:Map<string,{leases:Map<string,unknown>;recoveryTimer?:ReturnType<typeof setTimeout>}>;workspaceDirectories:Map<string,string>};
    const live=internals.sessions.get(workspaceId)!;
    await manager.retireWorkspace(workspaceId);
    await waitForExit(metadata.browserPid);
    assert.equal(live.leases.size,0);assert.equal(live.recoveryTimer,undefined);
    assert.equal(internals.sessions.has(workspaceId),false);assert.equal(internals.workspaceDirectories.has(workspaceId),false);
    assert.equal(JSON.parse(await readFile(path.join(dataRoot,workspaceId,'state.json'),'utf8')).desiredRunning,false);
    assert.equal(await readFile(profileSentinel,'utf8'),'saved profile');
    await assert.rejects(access(manager.metadataPath(workspaceId)));
    await assert.rejects(manager.start(workspaceId),/归档/);
    await manager.restore([workspaceId]);
    // No process is left, but the Profile is: it is listed as saved data, with its size, until deleted.
    const [left,...others]=await manager.listOrphans([]);
    assert.deepEqual(others,[]);assert.equal(left.workspaceId,workspaceId);assert.equal(left.kind,'profile');assert.equal(left.pid,null);assert.equal(left.desiredRunning,false);
    assert(left.profileBytes!>='saved profile'.length,'the size counts the Profile');assert(left.lastUsedAt!>Date.now()-60_000);
    await manager.close();manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
    await manager.restore([workspaceId]);assert.equal((await manager.state(workspaceId)).status,'idle','retirement survives plugin reload');
  }finally{await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('orphan cleanup finds saved desired-running sessions and refuses active workspaces', {timeout:30_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-orphan-'));
  let manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
  try{
    await manager.start('forgotten');
    const live=await manager.listOrphans([]);assert.equal(live.length,1);assert.equal(live[0].workspaceId,'forgotten');assert.equal(live[0].desiredRunning,true);assert(live[0].pid);
    assert.deepEqual(await manager.listOrphans(['forgotten']),[]);
    await assert.rejects(manager.stopOrphan('forgotten',['forgotten']),/仍可用/);
    assert.equal((await manager.state('forgotten')).status,'running');
    await manager.close();manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
    assert.deepEqual((await manager.listOrphans([])).map(({workspaceId,kind,status,pid,desiredRunning})=>({workspaceId,kind,status,pid,desiredRunning})),[{workspaceId:'forgotten',kind:'process',status:'idle',pid:null,desiredRunning:true}]);
    await manager.stopOrphan('forgotten',[]);
    assert.deepEqual((await manager.listOrphans([])).map(item=>[item.workspaceId,item.kind,item.pid]),[['forgotten','profile',null]],'stopping keeps the logins; they are listed as saved data');
    assert.equal(JSON.parse(await readFile(path.join(dataRoot,'forgotten','state.json'),'utf8')).desiredRunning,false);
    await access(path.join(dataRoot,'forgotten','profile'));
  }finally{await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('a failed retirement write still stops Chromium and cleanup can be retried', {timeout:30_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-retirement-retry-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()}),workspaceId='retry-workspace';
  const stateFile=path.join(dataRoot,workspaceId,'state.json'),backup=path.join(dataRoot,workspaceId,'saved-state.json');
  try{
    await manager.start(workspaceId);const metadata=JSON.parse(await readFile(manager.metadataPath(workspaceId),'utf8'));
    await rename(stateFile,backup);await mkdir(stateFile);
    await assert.rejects(manager.retireWorkspace(workspaceId));
    await waitForExit(metadata.browserPid);
    await rm(stateFile,{recursive:true});await rename(backup,stateFile);
    await manager.retireWorkspace(workspaceId);
    assert.equal(JSON.parse(await readFile(stateFile,'utf8')).desiredRunning,false);
    assert.deepEqual((await manager.listOrphans([])).map(item=>item.kind),['profile']);
  }finally{await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('retirement cancels a slow startup before it can spawn after the bounded shutdown returns', {timeout:20_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-retirement-starting-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot:path.join(dataRoot,'runtime')}),workspaceId='starting-workspace';
  let entered!:()=>void,release!:()=>void,launches=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const internals=manager as unknown as {executable:()=>Promise<string>;launchChromium:()=>Promise<never>;sessions:Map<string,unknown>;workspaceDirectories:Map<string,string>};
  internals.executable=async()=>{entered();await held;return '/unused/chromium';};
  internals.launchChromium=async()=>{launches++;throw new Error('a retired browser must never reach spawn');};
  let startup:Promise<unknown>|undefined;
  try{
    manager.setWorkspaceDirectory(workspaceId,dataRoot);
    startup=manager.start(workspaceId).catch(error=>error);
    await waiting;
    await manager.retireWorkspace(workspaceId);
    assert.equal(internals.sessions.has(workspaceId),false);
    release();assert.match(String(await startup),/归档/);
    assert.equal(launches,0,'the delayed executable lookup cannot launch after retirement returns');
    assert.equal(internals.sessions.has(workspaceId),false);assert.equal(internals.workspaceDirectories.has(workspaceId),false);
    assert.equal(JSON.parse(await readFile(path.join(dataRoot,workspaceId,'state.json'),'utf8')).desiredRunning,false);
    await assert.rejects(access(manager.metadataPath(workspaceId)));
    await access(path.join(dataRoot,workspaceId,'profile'));
  }finally{release();await startup;await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('a restored workspace starts its browser again with the kept Profile; a gone one can have its data deleted', {timeout:60_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-restore-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()}),workspaceId='restored-workspace';
  try{
    manager.setWorkspaceDirectory(workspaceId,dataRoot,'demo-project / feat/restore');
    await manager.start(workspaceId);
    const sentinel=path.join(dataRoot,workspaceId,'profile','kept.txt');await writeFile(sentinel,'kept login');
    await manager.retireWorkspace(workspaceId);
    await assert.rejects(manager.start(workspaceId),/归档/);
    const [saved]=await manager.listOrphans([]);assert.equal(saved.label,'demo-project / feat/restore','the workspace name stays with its leftovers');
    // The daemon restores archived workspaces under the same id.
    await manager.unretire(workspaceId);
    assert.equal((await manager.start(workspaceId)).status,'running');
    assert.equal(await readFile(sentinel,'utf8'),'kept login');
    assert.deepEqual(await manager.listOrphans([workspaceId]),[]);
    await assert.rejects(manager.deleteOrphan(workspaceId,[workspaceId]),/仍可用/,'a current workspace never loses its data');
    await access(sentinel);
    // Archived again: deleting stops nothing that runs elsewhere and removes everything kept for it.
    await manager.retireWorkspace(workspaceId);
    await manager.deleteOrphan(workspaceId,[]);
    await assert.rejects(access(path.join(dataRoot,workspaceId)));
    assert.deepEqual(await manager.listOrphans([]),[]);
    await manager.deleteOrphan(workspaceId,[]);
  }finally{await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('deleting a running orphan stops its Chromium first', {timeout:60_000},async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-delete-running-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot:defaultRuntimeRoot()});
  try{
    await manager.start('running-orphan');const metadata=JSON.parse(await readFile(manager.metadataPath('running-orphan'),'utf8'));
    assert.equal((await manager.listOrphans([]))[0].kind,'process');
    await manager.deleteOrphan('running-orphan',[]);
    await waitForExit(metadata.browserPid);
    await assert.rejects(access(path.join(dataRoot,'running-orphan')));
  }finally{await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});
