import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tabGlyph } from '../client/agent-tabs-model';
import { actionTitle, browserBadge, matchesOverviewFilter, matchesOverviewSearch, overviewCounts, pageHost, readable } from '../client/overview-model';
import type { BrowserOverviewItem, BrowserSession } from '../shared/browser';

function item(id:string,session:Partial<BrowserSession>={},agent:Partial<NonNullable<BrowserOverviewItem['agent']>>|null=null):BrowserOverviewItem {
  const agentId=agent?`agent-${id}`:null;
  return {
    workspace:{id,title:`Workspace ${id}`,cwd:`/synthetic/${id}`,projectId:'project-one',projectTitle:'Project One'},
    session:{workspaceId:id,status:'running',title:`Page ${id}`,url:`https://example.com/${id}?token=secret#part`,mode:'agent',width:1120,height:720,tabs:[],agentId,error:null,agentBusy:false,activity:[],...session},
    agent:agent?{id:agentId!,title:`Agent ${id}`,status:'idle',provider:'synthetic',needsPermission:false,...agent}:null,observedAt:1,
  };
}
const running=(source:'agent'|'manual')=>[{id:'a',source,action:'browser_click',status:'running' as const,tabId:null,pageTitle:'',pageUrl:'',startedAt:1,endedAt:null}];

test('page identity for meta lines keeps host and path but never credentials, query or fragment',()=>{
  assert.equal(pageHost('https://user:pass@example.com:8443/docs/page?token=secret#top'),'example.com:8443/docs/page');
  assert.equal(pageHost('https://example.com/'),'example.com');
  assert.equal(pageHost('about:blank'),'本地体验页');assert.equal(pageHost(''),'本地体验页');assert.equal(pageHost(null),'本地体验页');
  assert.equal(pageHost('file:///etc/passwd'),'本地页面');
  assert.equal(pageHost('not a url'),'页面地址暂不可用');
  const long=pageHost(`https://example.com/${'a'.repeat(200)}`);
  assert.equal(long.length,80);assert(long.endsWith('…'));
});

test('one badge per browser, the most urgent state first, and none while quietly waiting',()=>{
  assert.deepEqual(browserBadge(item('e',{status:'error'},{needsPermission:true})),{label:'异常',tone:'danger',icon:'CircleAlert'});
  assert.deepEqual(browserBadge(item('r',{status:'recovering',agentBusy:true})),{label:'恢复中',tone:'warning',icon:'RefreshCw',motion:'spin'});
  assert.deepEqual(browserBadge(item('s',{status:'starting'})),{label:'启动中',tone:'info',icon:'LoaderCircle',motion:'spin'});
  assert.deepEqual(browserBadge(item('i',{status:'idle'})),{label:'未启动',tone:'gray',icon:'MonitorOff'});
  assert.deepEqual(browserBadge(item('p',{agentBusy:true,health:{state:'login_required',summary:'',checkedAt:1,httpStatus:200,origin:''}},{needsPermission:true})),{label:'待审批',tone:'warning',icon:'Hand',motion:'ping'});
  assert.deepEqual(browserBadge(item('l',{agentBusy:true,health:{state:'login_required',summary:'',checkedAt:1,httpStatus:200,origin:''}})),{label:'需登录',tone:'orange',icon:'LogIn'});
  assert.deepEqual(browserBadge(item('b',{agentBusy:true})),{label:'Agent 操作中',tone:'info',icon:'LoaderCircle',motion:'spin'});
  assert.deepEqual(browserBadge(item('a',{activity:running('agent')})),{label:'Agent 操作中',tone:'info',icon:'LoaderCircle',motion:'spin'});
  assert.deepEqual(browserBadge(item('m',{mode:'manual',activity:running('manual')})),{label:'人工操作中',tone:'amber',icon:'MousePointer2'});
  assert.equal(browserBadge(item('q',{},{status:'running'})),null,'a running Agent that is not using the browser is not browser activity');
  const foreign=item('f');foreign.agent={id:'someone-else',title:'Other',status:'running',provider:'x',needsPermission:true};
  assert.equal(browserBadge(foreign),null,'an Agent that is not linked to this browser never raises its approval badge');
});

test('overview filters, counts and search match what the cards show',()=>{
  const items=[item('busy',{agentBusy:true}),item('acting',{activity:running('agent')}),item('login',{health:{state:'login_required',summary:'',checkedAt:1,httpStatus:401,origin:''}}),item('approve',{},{needsPermission:true}),item('quiet',{},{title:'发布检查 Agent'})];
  assert.deepEqual(overviewCounts(items),{all:5,agent:2,takeover:2});
  assert.deepEqual(items.filter(value=>matchesOverviewFilter(value,'agent')).map(value=>value.workspace.id),['busy','acting']);
  assert.deepEqual(items.filter(value=>matchesOverviewFilter(value,'takeover')).map(value=>value.workspace.id),['login','approve']);
  assert.deepEqual(items.filter(value=>matchesOverviewSearch(value,' 发布 ')).map(value=>value.workspace.id),['quiet']);
  assert.equal(items.filter(value=>matchesOverviewSearch(value,'project one')).length,5,'search is case-insensitive over project titles');
  assert.equal(items.filter(value=>matchesOverviewSearch(value,'Page login')).length,1,'page titles are searchable');
  assert.equal(items.filter(value=>matchesOverviewSearch(value,'token=secret')).length,0,'query strings are never searchable');
  assert.equal(items.filter(value=>matchesOverviewSearch(value,'')).length,5);
});

test('tab strip glyphs appear only for states worth a glance, in the shared state colours',()=>{
  assert.deepEqual(tabGlyph('browser_busy'),{label:'Agent 操作中',icon:'LoaderCircle',tone:'info',motion:'spin'});
  assert.deepEqual(tabGlyph('permission'),{label:'待审批',icon:'Hand',tone:'warning',motion:'ping'});
  assert.deepEqual(tabGlyph('login'),{label:'需登录',icon:'LogIn',tone:'orange'});
  assert.deepEqual(tabGlyph('error'),{label:'异常',icon:'CircleAlert',tone:'danger'});
  for(const state of ['agent_running','idle','offline'] as const)assert.equal(tabGlyph(state),null);
  for(const state of ['agent_running','idle','offline'] as const)assert.equal(tabGlyph(state,'agent'),null);
});

test('reading view drops markdown markers and page actions keep readable names',()=>{
  assert.equal(readable('# Title\n\n\n\nSome **bold** text\n## Next'),'Title\n\nSome bold text\nNext');
  assert.equal(readable(''),'');
  assert.equal(actionTitle('fitWidth'),'适应页面宽度');
  assert.equal(actionTitle('mcp.browser_click'),'点击网页');
  assert.equal(actionTitle('unknown'),'浏览器操作');
});
