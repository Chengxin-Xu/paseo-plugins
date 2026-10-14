import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { BrowserOverviewService, overviewPageUrl, overviewRevision } from '../server/overview';
import { overviewRpc, type BrowserSession } from '../shared/browser';

test('overview only reads known workspaces and associated agents, redacts URL parameters and separates browser work from agent status',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'paseo-browser-overview-'));
  try{
    await Promise.all(['one','two','stopped','unregistered'].map(id=>mkdir(path.join(root,id))));
    await symlink(path.join(root,'unregistered'),path.join(root,'linked'));
    const workspaces=['one','two','stopped','unused','linked'].map(id=>({id,title:id==='one'?'Same workspace name':id==='two'?'Same workspace name':id,name:id,projectId:'project-'+id,projectDisplayName:'Project '+id,workspaceDirectory:'/project/'+id,projectRootPath:'/project/'+id}));
    const calls:string[]=[];
    const states:Record<string,BrowserSession>=Object.fromEntries(['one','two','stopped'].map(id=>[id,{workspaceId:id,status:id==='stopped'?'idle':'running',title:'Page '+id,url:'https://example.com/'+id+'?token=private-token#secret',mode:'agent',width:1120,height:720,tabs:[{id:'tab-'+id,title:'Page '+id,url:'https://example.com/'+id+'?token=private-token',active:true,pinned:false}],agentId:id==='stopped'?null:'agent-'+id,error:null,agentBusy:id==='two',activity:[]}])) as Record<string,BrowserSession>;
    const agents:Record<string,unknown>={'agent-one':{id:'agent-one',workspaceId:'one',title:'Coding Agent',status:'running',provider:'codex',pendingPermissions:[],archivedAt:null},'agent-two':{id:'agent-two',workspaceId:'two',title:'Browser Agent',status:'running',provider:'claude',pendingPermissions:[],archivedAt:null}};
    const paseo={workspaces:{list:async()=>({entries:workspaces,pageInfo:{hasMore:false}})},agents:{list:async(input:{filter:{labels:Record<string,string>}})=>{const id='agent-'+input.filter.labels['server-browser.workspace'];calls.push('agent:'+id);return {entries:[{agent:agents[id]}],pageInfo:{hasMore:false}};}}} as unknown as PluginHandlerContext['paseo'];
    const overview=new BrowserOverviewService({dataRoot:root,state:async id=>{calls.push('state:'+id);return states[id];}});
    const listed=await overview.list(paseo);
    const result={...overviewRpc.output.parse(listed),items:listed.items};
    assert.equal(result.items.length,3);
    assert.equal(result.items[0].workspace.id,'two','Browser activity ranks before an unrelated running agent');
    assert.equal(result.items.find(item=>item.workspace.id==='one')!.session.agentBusy,false);
    assert.equal(result.items.find(item=>item.workspace.id==='one')!.agent!.status,'running');
    assert.equal(result.items.find(item=>item.workspace.id==='one')!.workspace.projectTitle,'Project one');
    assert.equal(result.items.find(item=>item.workspace.id==='two')!.workspace.projectTitle,'Project two');
    assert.equal(result.items.find(item=>item.workspace.id==='stopped')!.agent,null);
    assert(!JSON.stringify(result).includes('private-token'));
    assert(!JSON.stringify(result).includes('#secret'));
    assert(!calls.includes('state:unused')&&!calls.includes('state:unregistered')&&!calls.includes('state:linked'));
    const before=calls.length;await overview.list(paseo);assert.equal(calls.length,before,'Short shared cache avoids repeated metadata reads');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('overview does not label an agent from another workspace as the browser controller',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'paseo-browser-overview-'));
  try{
    await mkdir(path.join(root,'one'));
    const paseo={workspaces:{list:async()=>({entries:[{id:'one',title:'One',name:'One',projectId:'project-one',projectDisplayName:'Project One',workspaceDirectory:'/one',projectRootPath:'/one'}],pageInfo:{hasMore:false}})},agents:{list:async()=>({entries:[{agent:{id:'foreign-agent',workspaceId:'another-workspace',status:'running',title:'Unrelated',provider:'codex'}}],pageInfo:{hasMore:false}})}} as unknown as PluginHandlerContext['paseo'];
    const overview=new BrowserOverviewService({dataRoot:root,state:async()=>({workspaceId:'one',status:'running',title:'Login',url:'https://sso.example.com/user/login?code=secret',mode:'manual',width:1120,height:720,tabs:[],agentId:'foreign-agent',agentBusy:false,error:null})});
    const result=await overview.list(paseo);assert.equal(result.items[0].agent,null);assert.equal(result.items[0].session.url,'https://sso.example.com/user/login');
    assert.equal(overviewPageUrl('https://user:pass@example.com/private?q=secret'),'https://example.com/private');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('overview summaries carry only rendered state and their revision ignores read time, uptime and finished history',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'paseo-browser-overview-'));
  try{
    await mkdir(path.join(root,'one'));
    const workspaces=[{id:'one',title:'One',name:'One',projectId:'project-one',projectDisplayName:'Project One',workspaceDirectory:'/one',projectRootPath:'/one'}];
    const source=async()=>workspaces as never;
    const paseo={agents:{list:async()=>({entries:[],pageInfo:{hasMore:false}})}} as unknown as PluginHandlerContext['paseo'];
    const activity=(id:string,status:'running'|'completed')=>({id,source:'agent' as const,action:'打开网页',status,tabId:'tab-1',pageTitle:'Docs',pageUrl:'https://example.com/docs?session=secret',startedAt:1,endedAt:status==='running'?null:2});
    let uptime=0;
    const state:BrowserSession={workspaceId:'one',status:'running',title:'Docs',url:'https://example.com/docs?session=secret',mode:'agent',width:1120,height:720,
      tabs:[{id:'tab-1',title:'Docs',url:'https://example.com/docs',active:true,pinned:false},{id:'tab-2',title:'Other',url:'https://example.com/other',active:false,pinned:true}],
      agentId:null,error:null,agentBusy:false,settings:{autoRecover:true,maxTabs:20,maxArtifactMB:256,artifactMaxAgeHours:48},
      runtime:{recoveryCount:0,lastRecoveredAt:null,lastFailure:null,artifactBytes:0,artifactCount:0,cleanedArtifacts:0,uptimeSeconds:0},health:null,
      activity:[activity('done','completed'),activity('now','running')]};
    const read=async(change:(session:BrowserSession)=>BrowserSession=value=>value)=>new BrowserOverviewService({dataRoot:root,state:async()=>change({...state,runtime:{...state.runtime!,uptimeSeconds:uptime++}})},source).list(paseo);
    const first=await read();
    const summary=first.items[0].session;
    assert.deepEqual(summary.tabs,[],'tab lists stay in the per-workspace state');
    assert.equal(summary.runtime,undefined);assert.equal(summary.settings,undefined);
    assert.deepEqual(summary.activity?.map(item=>item.id),['now'],'only work in progress is summarized');
    assert(!JSON.stringify(first).includes('secret'));
    const again=await read();
    assert.notEqual(again.items[0].observedAt,undefined);
    assert.equal(again.revision,first.revision,'uptime, observation time and read time never change the revision');
    assert.equal((await read(session=>({...session,activity:[activity('older','completed'),...session.activity!]}))).revision,first.revision,'finished history is not part of the summary');
    for(const change of [
      (session:BrowserSession)=>({...session,agentBusy:true}),
      (session:BrowserSession)=>({...session,title:'Renamed page'}),
      (session:BrowserSession)=>({...session,activity:[activity('done','completed')]}),
      (session:BrowserSession)=>({...session,health:{state:'login_required' as const,summary:'需要登录',checkedAt:3,httpStatus:401,origin:'https://example.com'}}),
      (session:BrowserSession)=>({...session,status:'recovering' as const}),
    ])assert.notEqual((await read(change)).revision,first.revision,'every rendered change produces a new revision');
    assert.equal(overviewRevision(first.items),first.revision);
  }finally{await rm(root,{recursive:true,force:true});}
});
