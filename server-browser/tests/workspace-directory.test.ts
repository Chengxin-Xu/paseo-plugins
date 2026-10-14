import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoWorkspace } from '../server/service';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { WorkspaceDirectory, listBrowserWorkspaces } from '../server/service';

type Paseo=PluginHandlerContext['paseo'];
const paseo={} as Paseo;
const workspace=(id:string,extra:Partial<PaseoWorkspace>={})=>({id,projectRootPath:'/work/'+id,workspaceDirectory:'/work/'+id,projectDisplayName:'Project '+id,name:id,...extra}) as PaseoWorkspace;
function directory(entries:PaseoWorkspace[][],ttlMs=30_000){
  let now=1_000,calls=0;
  const source=async()=>{const value=entries[Math.min(calls,entries.length-1)];calls++;return value;};
  return {directory:new WorkspaceDirectory(ttlMs,()=>now,source),advance:(ms:number)=>{now+=ms;},calls:()=>calls};
}

test('frame and input validation share one workspace listing within its lifetime',async()=>{
  const {directory:cache,advance,calls}=directory([[workspace('one'),workspace('two')],[workspace('one')]]);
  for(let index=0;index<50;index++)await cache.require(paseo,index%2?'one':'two');
  assert.equal(calls(),1,'fifty validations cost one daemon listing');
  advance(29_999);await cache.require(paseo,'two');assert.equal(calls(),1);
  advance(2);await assert.rejects(cache.require(paseo,'two'),/已不可用/,'an expired listing is read again and removed workspaces fail');
  assert.equal(calls(),2);
});

test('concurrent validations share one in-flight listing',async()=>{
  let release!:(value:PaseoWorkspace[])=>void,calls=0;
  const cache=new WorkspaceDirectory(30_000,()=>0,()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const pending=Promise.all([cache.require(paseo,'one'),cache.list(paseo),cache.require(paseo,'one')]);
  release([workspace('one')]);
  const [first,listed]=await pending;
  assert.equal(calls,1);assert.equal(first.id,'one');assert.equal(listed.length,1);
});

test('a workspace created after the cached listing is confirmed with one fresh read, and unknown ids still fail',async()=>{
  const {directory:cache,calls}=directory([[workspace('one')],[workspace('one'),workspace('created')],[workspace('one'),workspace('created')]]);
  await cache.list(paseo);
  assert.equal((await cache.require(paseo,'created')).id,'created');
  assert.equal(calls(),2);
  await assert.rejects(cache.require(paseo,'missing'),/该工作区已不可用/);
  assert.equal(calls(),3,'a miss on the cache re-reads once; it does not loop');
});

test('workspace lifecycle invalidation drops the cache and never stores a listing that started before it',async()=>{
  const releases:((value:PaseoWorkspace[])=>void)[]=[];let calls=0;
  const cache=new WorkspaceDirectory(30_000,()=>0,()=>{calls++;return new Promise(resolve=>{releases.push(resolve);});});
  const stale=cache.list(paseo);
  cache.invalidate();
  const fresh=cache.list(paseo);
  assert.equal(calls,2,'an invalidated in-flight listing is not shared');
  releases[1]([workspace('one'),workspace('two')]);releases[0]([workspace('one')]);
  assert.equal((await stale).length,1);assert.equal((await fresh).length,2);
  assert.equal((await cache.list(paseo)).length,2,'only the post-invalidation listing is cached');
  assert.equal(calls,2);
  cache.invalidate();const next=cache.list(paseo);releases[2]([workspace('three')]);
  assert.deepEqual((await next).map(item=>item.id),['three']);
});

test('listing failures are not cached and relative workspace paths are rejected',async()=>{
  let fail=true,calls=0;
  const cache=new WorkspaceDirectory(30_000,()=>0,async()=>{calls++;if(fail)throw new Error('daemon unavailable');return [workspace('one'),workspace('relative',{workspaceDirectory:'relative/path'})];});
  await assert.rejects(cache.list(paseo),/daemon unavailable/);
  fail=false;
  assert.equal((await cache.require(paseo,'one')).id,'one');
  await assert.rejects(cache.require(paseo,'relative'),/绝对路径/);
  assert.equal(calls,2);
});

test('the default source pages through the daemon and hides archiving workspaces',async()=>{
  const pages=[{entries:[workspace('one'),workspace('gone',{archivingAt:'2026-09-22T00:00:00Z'})],pageInfo:{hasMore:true,nextCursor:'next'}},{entries:[workspace('two')],pageInfo:{hasMore:false,nextCursor:null}}];
  const cursors:(string|undefined)[]=[];
  const api={workspaces:{list:async({page}:{page:{cursor?:string}})=>{cursors.push(page.cursor);return pages[cursors.length-1];}}} as unknown as Paseo;
  assert.deepEqual((await listBrowserWorkspaces(api)).map(item=>item.id),['one','two']);
  assert.deepEqual(cursors,[undefined,'next']);
});

test('retirement filters even a stale listing that was already in flight',async()=>{
  let release!:(items:PaseoWorkspace[])=>void;
  const restored:string[]=[];
  const cache=new WorkspaceDirectory(30_000,()=>0,()=>new Promise(resolve=>{release=resolve;}));
  cache.onRestore(id=>{restored.push(id);});
  const pending=cache.list(paseo);
  cache.retire('archived');release([workspace('archived'),workspace('live')]);
  assert.deepEqual((await pending).map(item=>item.id),['live']);
  assert.deepEqual(restored,[],'a listing that started before the archiving cannot bring it back');
  const next=cache.require(paseo,'archived');release([workspace('live')]);
  await assert.rejects(next,/已不可用/);
});

test('an archived workspace that the daemon lists again (restored, or its directory reopened) gets its browser back',async()=>{
  let listing=[workspace('kept'),workspace('live')];
  const restored:string[]=[];let releaseRestore!:()=>void;
  const cache=new WorkspaceDirectory(30_000,()=>0,async()=>listing);
  cache.onRestore(id=>new Promise<void>(resolve=>{restored.push(id);releaseRestore=resolve;}));
  assert.equal((await cache.require(paseo,'kept')).id,'kept');
  cache.retire('kept');listing=[workspace('live')];
  await assert.rejects(cache.require(paseo,'kept'),/已不可用/);
  assert.deepEqual((await cache.list(paseo)).map(item=>item.id),['live']);
  // Same id, no workspace.created event: only a later listing shows it.
  listing=[workspace('kept'),workspace('live')];cache.invalidate();
  const back=cache.require(paseo,'kept');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(restored,['kept'],'the manager is told before the workspace is usable again');
  releaseRestore();
  assert.equal((await back).id,'kept');
  assert.deepEqual((await cache.list(paseo)).map(item=>item.id),['kept','live']);
  // A listener that fails leaves it retired, to be tried again with the next listing.
  const failing=new WorkspaceDirectory(30_000,()=>0,async()=>[workspace('again')]);
  failing.onRestore(()=>{throw new Error('manager busy');});failing.retire('again');
  await assert.rejects(failing.require(paseo,'again'),/已不可用/);
});

test('an incomplete workspace listing is never used to authorize orphan cleanup',async()=>{
  const api={workspaces:{list:async()=>({entries:[workspace('one')],pageInfo:{hasMore:true,nextCursor:null}})}} as unknown as Paseo;
  await assert.rejects(listBrowserWorkspaces(api),/列表暂不完整/);
});
