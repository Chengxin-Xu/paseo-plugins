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
