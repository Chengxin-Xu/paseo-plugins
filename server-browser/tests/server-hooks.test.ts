import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PaseoWorkspace } from '../server/service';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../index.server';
import type { BrowserManager } from '../server/browser-manager';
import { WorkspaceDirectory } from '../server/service';
import type { BrowserSession } from '../shared/browser';

type Handler=(input:unknown,context:{paseo:unknown;signal?:AbortSignal})=>unknown;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const workspace=(id:string)=>({id,projectRootPath:'/work/'+id,workspaceDirectory:'/work/'+id,projectDisplayName:'Project',name:id}) as PaseoWorkspace;
const session=(workspaceId:string):BrowserSession=>({workspaceId,status:'idle',title:'服务器浏览器',url:'',mode:'manual',width:1120,height:720,tabs:[],agentId:null,error:null,agentBusy:false,activity:[]});

function host(){
  const rpc=new Map<string,Handler>(),events=new Map<string,Handler>(),before=new Map<string,Handler>();
  const server={
    handle:(contract:{name:string},handler:Handler)=>{rpc.set(contract.name,handler);},
    on:(name:string,handler:Handler)=>{events.set(name,handler);return()=>{};},
    before:(name:string,handler:Handler)=>{before.set(name,handler);return()=>{};},
    registerSettings(){},registerProvider(){},
  } as unknown as PluginServerContext;
  const restored:string[][]=[],frames:unknown[][]=[];
  const manager={
    restore:async(ids:string[])=>{restored.push(ids);},
    frame:async(...args:unknown[])=>{frames.push(args);return {sessionRevision:'r',frame:null};},
    state:async(id:string)=>session(id),dataRoot:'/nonexistent/server-browser-hooks-test',close:async()=>{},
  } as unknown as BrowserManager;
  return {server,rpc,events,before,manager,restored,frames};
}
const openRequest={agentId:'agent-1',workspaceId:'one',provider:'claude',cwd:'/work/one',reason:'resume',purpose:'interactive',env:{}};

test('agent session open returns at once, even while the workspace listing hangs or fails',async()=>{
  const {server,before,events,manager,restored}=host();
  let listCalls=0;const pending:{resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
  const paseo={workspaces:{list:()=>{listCalls++;return new Promise((resolve,reject)=>{pending.push({resolve,reject});});}}};
  const cleanup=contribute(server,{manager});
  const open=before.get('agent.session_open')!,turn=events.get('agent.turn_started')!;
  assert.equal(open({request:openRequest},{paseo,signal:new AbortController().signal}),undefined,'the request is left unchanged without waiting');
  assert.equal(turn({agent:{id:'agent-1'},turnId:null},{paseo,signal:new AbortController().signal}),undefined);
  assert.equal(listCalls,1,'hooks share one restoration listing');
  pending[0].reject(new Error('daemon API reconnecting'));
  await tick();
  // A failed listing is retried by the next lifecycle event and never reaches the daemon as a hook failure.
  assert.equal(open({request:openRequest},{paseo,signal:new AbortController().signal}),undefined);
  assert.equal(listCalls,2);
  pending[1].resolve({entries:[workspace('one'),workspace('two')],pageInfo:{hasMore:false}});
  await tick();await tick();
  assert.deepEqual(restored,[['one','two']]);
  open({request:openRequest},{paseo,signal:new AbortController().signal});
  assert.equal(listCalls,2,'restoration runs once per plugin process');
  await (cleanup as ()=>Promise<void>)();
});

test('panel RPCs still validate the workspace, share the cached listing and see lifecycle invalidation',async()=>{
  const {server,rpc,events,manager,frames}=host();
  let listCalls=0,entries=[workspace('one')];
  const paseo={workspaces:{list:async()=>{listCalls++;return {entries,pageInfo:{hasMore:false}};}}};
  contribute(server,{manager,directory:new WorkspaceDirectory(60_000)});
  const frame=rpc.get('browser.frame')!;
  for(let index=0;index<20;index++)await frame({workspaceId:'one',after:null,quality:'sharp',maxWidth:780,maxHeight:1200,sessionRevision:'rev'},{paseo});
  assert.equal(listCalls,1,'twenty frame polls validate against one listing');
  assert.deepEqual(frames[0],['one',null,'sharp',{maxWidth:780,maxHeight:1200,sessionRevision:'rev'}]);
  await assert.rejects(Promise.resolve(frame({workspaceId:'other',after:null},{paseo})),/已不可用/);
  assert.equal(listCalls,2,'an unknown workspace is confirmed with one fresh listing');
  entries=[workspace('one'),workspace('new')];
  events.get('workspace.created')!({workspace:{id:'new'}},{paseo});
  await frame({workspaceId:'new',after:null},{paseo});
  assert.equal(listCalls,3);
  entries=[workspace('new')];
  events.get('workspace.archived')!({workspace:{id:'one'}},{paseo});
  await assert.rejects(Promise.resolve(frame({workspaceId:'one',after:null},{paseo})),/已不可用/,'an archived workspace stops validating immediately');
});

test('an unchanged overview answers with its revision only',async()=>{
  const {server,rpc,manager}=host();
  const paseo={workspaces:{list:async()=>({entries:[workspace('one')],pageInfo:{hasMore:false}})}};
  contribute(server,{manager});
  const overview=rpc.get('browser.overview')!;
  const first=await overview({},{paseo}) as {items:unknown[];revision:string;checkedAt:number};
  assert(Array.isArray(first.items)&&first.revision);
  const unchanged=await overview({revision:first.revision},{paseo}) as Record<string,unknown>;
  assert.deepEqual(Object.keys(unchanged).sort(),['checkedAt','revision','unchanged']);
  assert.equal(unchanged.unchanged,true);
  assert(JSON.stringify(unchanged).length<100);
  const stale=await overview({revision:'another-revision'},{paseo}) as {items:unknown[]};
  assert(Array.isArray(stale.items),'a different revision receives the full summary');
});
