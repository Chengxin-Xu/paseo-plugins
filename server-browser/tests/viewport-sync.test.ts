import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TestBrowserManager as BrowserManager } from './manual-action';

test('window matching overrides stale Playwright metrics and stays exact with frame polling', {timeout:30000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-viewport-sync-'));
  const manager=new BrowserManager({dataRoot});let socket:WebSocket|undefined;
  try{
    await manager.start('viewport-sync');
    const meta=JSON.parse(await readFile(manager.metadataPath('viewport-sync'),'utf8'));
    const targets=await fetch(meta.cdpEndpoint+'/json/list').then(response=>response.json()) as {type:string;webSocketDebuggerUrl:string}[];
    const target=targets.find(item=>item.type==='page');assert(target);
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve,reject)=>{socket!.addEventListener('open',()=>resolve());socket!.addEventListener('error',reject);});
    let sequence=0;const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
    socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);});
    const command=(method:string,params:Record<string,unknown>)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}));});
    await command('Emulation.setDeviceMetricsOverride',{width:1120,height:725,deviceScaleFactor:1,mobile:false});
    assert.equal((await manager.state('viewport-sync')).height,725);
    const observed=await manager.frame('viewport-sync',null,'sharp');assert.equal(observed.frame?.height,725);
    assert.equal((await manager.state('viewport-sync')).height,725,'Viewing a frame must not reapply another CDP connection\'s stale metrics');
    // The manager connection still caches 1120x720; the plain public setter used to no-op here.
    await manager.action('viewport-sync',{kind:'viewport',width:1120,height:720});
    assert.equal((await manager.state('viewport-sync')).height,720);
    await Promise.all([manager.frame('viewport-sync',null,'sharp'),manager.action('viewport-sync',{kind:'viewport',width:390,height:603})]);
    const phone=await manager.frame('viewport-sync',null,'sharp');assert.equal(phone.frame?.width,390);assert.equal(phone.frame?.height,603);
    await manager.action('viewport-sync',{kind:'viewport',width:1120,height:720});
    const restored=await manager.frame('viewport-sync',null,'sharp');assert.equal(restored.frame?.width,1120);assert.equal(restored.frame?.height,720);
  }finally{socket?.close();await manager.close();await rm(dataRoot,{recursive:true,force:true});}
});
