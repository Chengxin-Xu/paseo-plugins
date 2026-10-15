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
    registerSettings(){return {read:async()=>({status:'ready',revision:'r1',values:{language:'zh-CN'}}),subscribe:()=>()=>{}};},registerProvider(){},
  } as unknown as PluginServerContext;
  const restored:string[][]=[],frames:unknown[][]=[],directories:[string,string][]=[],retired:string[]=[],orphanCalls:unknown[][]=[],unretired:string[]=[],inputs:unknown[][]=[];
  const manager={
    restore:async(ids:string[])=>{restored.push(ids);},
    setWorkspaceDirectory:(id:string,directory:string)=>{directories.push([id,directory]);},
    frame:async(...args:unknown[])=>{frames.push(args);return {sessionRevision:'r',frame:null};},
    getAgentId:async()=>null,setAgentAvailability:()=>{},
    retireWorkspace:async(id:string)=>{retired.push(id);},
    unretire:async(id:string)=>{unretired.push(id);},
    deleteOrphan:async(id:string,ids:string[])=>{orphanCalls.push(['delete',id,ids]);if(ids.includes(id))throw new Error('该工作区仍可用');},
    input:async(id:string,request:unknown)=>{inputs.push([id,request]);return {status:'applied',applied:1,continuation:'scope',session:session(id)};},
    listOrphans:async(ids:string[])=>{orphanCalls.push(['list',ids]);return [{workspaceId:'orphan',status:'running',pid:123,desiredRunning:true}];},
    stopOrphan:async(id:string,ids:string[])=>{orphanCalls.push(['stop',id,ids]);if(ids.includes(id))throw new Error('该工作区仍然可用');},
    state:async(id:string)=>session(id),dataRoot:'/nonexistent/server-browser-hooks-test',close:async()=>{},
  } as unknown as BrowserManager;
  return {server,rpc,events,before,manager,restored,frames,directories,retired,orphanCalls,unretired,inputs};
}
const openRequest={agentId:'agent-1',workspaceId:'one',provider:'claude',cwd:'/work/one',reason:'resume',purpose:'interactive',env:{}};

test('agent session open returns at once, even while the workspace listing hangs or fails',async()=>{
  const {server,before,events,manager,restored,directories}=host();
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
  assert.deepEqual(directories,[['one','/work/one'],['two','/work/two']],'restoration tells the manager each workspace directory for upload checks');
  open({request:openRequest},{paseo,signal:new AbortController().signal});
  assert.equal(listCalls,2,'restoration runs once per plugin process');
  await (cleanup as ()=>Promise<void>)();
});

test('panel RPCs still validate the workspace, share the cached listing and see lifecycle invalidation',async()=>{
  const {server,rpc,events,manager,frames,directories,retired}=host();
  let listCalls=0,entries=[workspace('one')];
  const paseo={workspaces:{list:async()=>{listCalls++;return {entries,pageInfo:{hasMore:false}};}}};
  contribute(server,{manager,directory:new WorkspaceDirectory(60_000)});
  const frame=rpc.get('browser.frame')!;
  for(let index=0;index<20;index++)await frame({workspaceId:'one',after:null,quality:'sharp',maxWidth:780,maxHeight:1200,sessionRevision:'rev'},{paseo});
  assert.equal(listCalls,1,'twenty frame polls validate against one listing');
  assert.deepEqual(frames[0],['one',null,'sharp',{maxWidth:780,maxHeight:1200,sessionRevision:'rev',viewerId:undefined}]);
  assert(directories.some(([id,directory])=>id==='one'&&directory==='/work/one'),'a validated workspace records its directory');
  await assert.rejects(Promise.resolve(frame({workspaceId:'other',after:null},{paseo})),/已不可用/);
  assert.equal(listCalls,2,'an unknown workspace is confirmed with one fresh listing');
  entries=[workspace('one'),workspace('new')];
  events.get('workspace.created')!({workspace:{id:'new'}},{paseo});
  await frame({workspaceId:'new',after:null},{paseo});
  assert.equal(listCalls,3);
  entries=[workspace('new')];
  await events.get('workspace.archived')!({workspace:{id:'one'}},{paseo});
  assert.deepEqual(retired,['one'],'archiving retires browser resources, beyond invalidating the workspace list');
  await assert.rejects(Promise.resolve(frame({workspaceId:'one',after:null},{paseo})),/已不可用/,'an archived workspace stops validating immediately');
});

test('orphan cleanup bypasses normal workspace validation but supplies the current allowlist',async()=>{
  const {server,rpc,events,manager,orphanCalls,retired,unretired}=host();
  let entries=[workspace('one')];
  const paseo={workspaces:{list:async()=>({entries,pageInfo:{hasMore:false}})}};
  contribute(server,{manager});
  const list=await rpc.get('browser.orphans')!({},{paseo}) as {items:{workspaceId:string}[]};
  assert.equal(list.items[0].workspaceId,'orphan');
  assert.deepEqual(await rpc.get('browser.orphan.stop')!({workspaceId:'orphan'},{paseo}),{stopped:true});
  await assert.rejects(Promise.resolve(rpc.get('browser.orphan.stop')!({workspaceId:'one'},{paseo})),/仍然可用/);
  assert.deepEqual(await rpc.get('browser.orphan.delete')!({workspaceId:'orphan'},{paseo}),{deleted:true});
  await assert.rejects(Promise.resolve(rpc.get('browser.orphan.delete')!({workspaceId:'one'},{paseo})),/仍可用/);
  assert.deepEqual(orphanCalls,[['list',['one']],['stop','orphan',['one']],['stop','one',['one']],['delete','orphan',['one']],['delete','one',['one']]]);
  entries=[];
  await events.get('workspace.archived')!({workspace:{id:'one'}},{paseo});
  assert.deepEqual(retired,['one']);
  await assert.rejects(Promise.resolve(rpc.get('browser.state')!({workspaceId:'one'},{paseo})),/已不可用/,'an archived workspace stops validating');
  // Restored under the same id (no workspace.created event): an id missing from the cached listing is confirmed with a
  // fresh one, which brings its browser back at once.
  entries=[workspace('one')];
  assert.equal(((await rpc.get('browser.state')!({workspaceId:'one'},{paseo})) as BrowserSession).workspaceId,'one');
  assert.deepEqual(unretired,['one']);
});

test('live input reaches the manager after workspace validation; services come from a fresh workspace descriptor',async()=>{
  const {server,rpc,manager,inputs}=host();
  let scripts:unknown[]=[];
  const descriptor=()=>({...workspace('one'),scripts});
  let listCalls=0;
  const paseo={workspaces:{list:async()=>{listCalls++;return {entries:[descriptor()],pageInfo:{hasMore:false}};}},agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})}};
  contribute(server,{manager,directory:new WorkspaceDirectory(60_000)});
  const request={workspaceId:'one',viewerId:'viewer',seq:1,target:{tabId:'t',viewRevision:'v',inputScope:'s'},events:[{kind:'text',text:'abc'}]};
  const result=await rpc.get('browser.input')!(request,{paseo}) as {status:string;continuation:string};
  assert.deepEqual([result.status,result.continuation],['applied','scope']);
  assert.deepEqual(inputs,[['one',request]]);
  await assert.rejects(Promise.resolve(rpc.get('browser.input')!({...request,workspaceId:'gone'},{paseo})),/已不可用/);
  scripts=[{scriptName:'web',type:'service',hostname:'web--demo.localhost',port:5173,proxyUrl:null,lifecycle:'running',health:'healthy',exitCode:null,terminalId:null,localProxyUrl:'http://web--demo.localhost:6767'},
    {scriptName:'docs',type:'service',hostname:'docs--demo.localhost',port:null,proxyUrl:null,lifecycle:'stopped',health:null,exitCode:null,terminalId:null,localProxyUrl:'http://docs--demo.localhost:6767'},
    {scriptName:'test',type:'script',hostname:'test',port:null,proxyUrl:null,lifecycle:'running',health:null,exitCode:null,terminalId:'t1'}];
  const before=listCalls;
  const services=await rpc.get('browser.services')!({workspaceId:'one'},{paseo}) as {items:unknown[]};
  assert.equal(listCalls,before+1,'services read a fresh listing, not the 60 s cache');
  assert.deepEqual(services.items,[{name:'web',port:5173,running:true,health:'healthy',url:'http://127.0.0.1:5173/'},{name:'docs',port:null,running:false,health:null,url:'http://docs--demo.localhost:6767'}]);
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
