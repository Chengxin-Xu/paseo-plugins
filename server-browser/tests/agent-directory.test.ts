import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { BrowserAgentDirectory } from '../server/service';

type Paseo=PluginHandlerContext['paseo'];
const agent=(extra:Record<string,unknown>={})=>({id:'agent-one',workspaceId:'one',title:'浏览器 Agent',provider:'codex',status:'idle',archivedAt:null,pendingPermissions:[],...extra});

test('linked Agent availability distinguishes a confirmed absence from a failed lookup without loading sessions',async()=>{
  let entries=[{agent:agent()}],fail=false,calls=0;
  const paseo={agents:{
    list:async(input:{filter:{includeArchived:boolean;labels:Record<string,string>}})=>{calls++;assert.equal(input.filter.includeArchived,true);assert.equal(input.filter.labels['server-browser.workspace'],'one');if(fail)throw new Error('connection lost');return {entries,pageInfo:{hasMore:false}};},
    ref:()=>{throw new Error('metadata polling must not load an Agent');},
  }} as unknown as Paseo;
  const directory=new BrowserAgentDirectory();
  assert.deepEqual(await directory.inspect(paseo,'one',null),{availability:'unavailable',agent:null});assert.equal(calls,0);
  const available=await directory.inspect(paseo,'one','agent-one');assert.equal(available.availability,'available');assert.equal(available.agent?.id,'agent-one');
  await directory.inspect(paseo,'one','agent-one');assert.equal(calls,1,'polling reuses metadata for five seconds');
  for(const unavailable of [agent({archivedAt:'2026-01-01T00:00:00Z'}),agent({workspaceId:'another'}),agent({id:'another'})]){
    entries=[{agent:unavailable}];directory.invalidate('one');assert.deepEqual(await directory.inspect(paseo,'one','agent-one'),{availability:'unavailable',agent:null});
  }
  // closed only means not loaded (every session after a daemon restart): opening it loads it, so it stays linked.
  entries=[{agent:agent({status:'closed'})}];directory.invalidate('one');
  const unloaded=await directory.inspect(paseo,'one','agent-one');assert.equal(unloaded.availability,'available');assert.equal(unloaded.agent?.status,'closed');
  entries=[];directory.invalidate('one');assert.equal((await directory.inspect(paseo,'one','agent-one')).availability,'unavailable');
  fail=true;directory.invalidate('one');assert.deepEqual(await directory.inspect(paseo,'one','agent-one'),{availability:'unknown',agent:null});
});

test('Agent metadata follows pagination and never calls an incomplete listing a confirmed absence',async()=>{
  const cursors:(string|undefined)[]=[];
  const paseo={agents:{list:async(input:{page:{cursor?:string}})=>{
    cursors.push(input.page.cursor);
    return input.page.cursor?{entries:[{agent:agent()}],pageInfo:{hasMore:false}}:{entries:[{agent:agent({id:'older'})}],pageInfo:{hasMore:true,nextCursor:'next'}};
  }}} as unknown as Paseo;
  const directory=new BrowserAgentDirectory();
  assert.equal((await directory.inspect(paseo,'one','agent-one')).availability,'available');assert.deepEqual(cursors,[undefined,'next']);
  const incomplete={agents:{list:async()=>({entries:[],pageInfo:{hasMore:true,nextCursor:null}})}} as unknown as Paseo;
  assert.equal((await new BrowserAgentDirectory().inspect(incomplete,'one','agent-one')).availability,'unknown');
  await assert.rejects(new BrowserAgentDirectory().list(incomplete,'one',true),/暂不完整/);
});

test('lifecycle invalidation does not let an old pending list repopulate the cache',async()=>{
  let complete!:(value:unknown)=>void,calls=0;
  const paseo={agents:{list:async()=>{calls++;if(calls===1)return new Promise(resolve=>{complete=resolve;});return {entries:[],pageInfo:{hasMore:false}};}}} as unknown as Paseo;
  const directory=new BrowserAgentDirectory(),pending=directory.inspect(paseo,'one','agent-one');
  directory.invalidate('one');complete({entries:[{agent:agent()}],pageInfo:{hasMore:false}});await pending;
  assert.equal((await directory.inspect(paseo,'one','agent-one')).availability,'unavailable');assert.equal(calls,2);
});
