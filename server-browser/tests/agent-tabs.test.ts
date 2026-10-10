import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserProjectKey, buildAgentTabGroups, projectName, tabGlyph } from '../client/agent-tabs-model';
import type { BrowserOverviewItem, BrowserWorkspace } from '../shared/browser';

function item(workspaceId:string,projectId:string|null,agentId:string|null,options:{projectTitle?:string;workspaceTitle?:string;agentTitle?:string;agentStatus?:string;busy?:boolean;permission?:boolean;observedAt?:number}={}):BrowserOverviewItem {
  return {
    workspace:{id:workspaceId,title:options.workspaceTitle??`Workspace ${workspaceId}`,cwd:`/synthetic/${workspaceId}`,projectId,projectTitle:options.projectTitle??'Same display name'},
    session:{workspaceId,status:'running',mode:'manual',width:1120,height:720,title:'Synthetic page',url:'https://fixture.invalid/',tabs:[{id:`page-${workspaceId}`,title:'Synthetic page',url:'https://fixture.invalid/',active:true,pinned:false}],agentId,error:null,agentBusy:options.busy??false,activity:[]},
    agent:agentId?{id:agentId,title:options.agentTitle??`Agent ${agentId}`,status:options.agentStatus??'idle',provider:'synthetic',needsPermission:options.permission??false}:null,
    observedAt:options.observedAt??1,
  };
}
const order=(items:BrowserOverviewItem[])=>buildAgentTabGroups(items).map(group=>({projectKey:group.projectKey,workspaceIds:group.tabs.map(tab=>tab.workspaceId)}));

test('agent tabs group by project identity, and share the colour key every plugin derives from the project display name',()=>{
  const one=item('work-a','project-one','agent-a');
  const two=item('work-b','project-one','agent-b');
  const other=item('work-c','project-two','agent-c');
  const groups=buildAgentTabGroups([other,two,one]);
  assert.equal(groups.length,2,'Projects with duplicate display titles remain separate groups');
  const common=groups.find(group=>group.projectKey==='project:project-one')!;
  assert.deepEqual(common.tabs.map(tab=>tab.agentId),['agent-a','agent-b']);
  assert.equal(common.tabs[0].projectKey,common.tabs[1].projectKey);
  assert.equal(common.tabs[0].identity,common.tabs[1].identity);
  assert.equal(common.identity,'Same display name','hueFor(display name) keeps a project the same colour as in the other plugins');
  assert.notEqual(common.projectKey,groups.find(group=>group.projectKey==='project:project-two')!.projectKey);
  const renamed={...one,workspace:{...one.workspace,projectTitle:'Renamed display title'}};
  assert.equal(browserProjectKey(renamed.workspace),browserProjectKey(one.workspace),'renaming never regroups a project');
  assert.equal(buildAgentTabGroups([renamed])[0].identity,'Renamed display title');
});

test('project colour keys follow the display name, never refresh order; a workspace without a project goes by its own title',()=>{
  const entries=Array.from({length:6},(_,index)=>item('work-'+index,'project-'+index,'agent-'+index,{projectTitle:'Project '+index}));
  const groups=buildAgentTabGroups(entries);
  assert.deepEqual(groups.map(group=>group.identity),entries.map(entry=>entry.workspace.projectTitle));
  const shuffled=buildAgentTabGroups([...entries].reverse());
  assert.deepEqual(shuffled.map(group=>[group.projectKey,group.identity]),groups.map(group=>[group.projectKey,group.identity]));
  assert.equal(projectName({id:'loose',title:'  scratch  ',cwd:'/synthetic/loose',projectId:null}),'scratch');
  assert.equal(projectName({id:'named',title:'main',cwd:'/synthetic/named',projectId:'p',projectTitle:' Commerce Platform '}),'Commerce Platform');
});

test('status changes and shuffled overview refreshes never reorder the agent tab strip',()=>{
  const a=item('work-a','project-one','agent-a');
  const b=item('work-b','project-one','agent-b');
  const c=item('work-c','project-two','agent-c');
  const initial=[a,b,c],expected=order(initial);
  for(let tick=0;tick<8;tick++) {
    const updated=initial.map((value,index)=>({...value,observedAt:tick+2,session:{...value.session,agentBusy:(tick+index)%3===0},agent:value.agent?{...value.agent,status:(tick+index)%2?'running':'idle',needsPermission:(tick+index)%4===0}:null}));
    if(tick%2)updated.reverse();else updated.push(updated.shift()!);
    assert.deepEqual(order(updated),expected);
  }
  const newer={...a,observedAt:20,agent:{...a.agent!,title:'Most recent Agent title'}};
  const groups=buildAgentTabGroups([newer,b,a]);
  const tabs=groups.flatMap(group=>group.tabs);
  assert.equal(tabs.filter(tab=>tab.workspaceId===a.workspace.id).length,1,'Repeated snapshots do not duplicate tabs');
  assert.equal(tabs.find(tab=>tab.workspaceId===a.workspace.id)?.title,'Most recent Agent title');
});

test('same-name agents remain identified by their workspace and selected unsaved workspaces stay explicit',()=>{
  const a=item('work-a','project-one','agent-a',{agentTitle:'Browser assistant',workspaceTitle:'Review branch'});
  const b=item('work-b','project-one','agent-b',{agentTitle:'Browser assistant',workspaceTitle:'Release branch'});
  const tabs=buildAgentTabGroups([a,b]).flatMap(group=>group.tabs);
  assert.equal(tabs[0].title,tabs[1].title,'The actual Agent title is retained');
  assert.notEqual(tabs[0].subtitle,tabs[1].subtitle);
  assert.notEqual(tabs[0].accessibilityLabel,tabs[1].accessibilityLabel);
  assert(tabs[0].accessibilityLabel.includes('Review branch'));
  assert(tabs[1].accessibilityLabel.includes('Release branch'));
  const identicalNames=buildAgentTabGroups([
    item('branch-aa0001','project-one','agent-one',{agentTitle:'Reviewer',workspaceTitle:'workspace'}),
    item('branch-bb0002','project-one','agent-two',{agentTitle:'Reviewer',workspaceTitle:'workspace'}),
  ]).flatMap(group=>group.tabs);
  assert.notEqual(identicalNames[0].subtitle,identicalNames[1].subtitle,'Duplicate Agent and workspace names still have distinct visible identities');
  assert.notEqual(identicalNames[0].accessibilityLabel,identicalNames[1].accessibilityLabel);
  const selected:BrowserWorkspace={id:'selected-only',title:'Selected workspace',cwd:'/synthetic/selected-only',projectId:null,projectTitle:'Same display name'};
  const selectedTab=buildAgentTabGroups([a,b],selected).flatMap(group=>group.tabs).find(tab=>tab.workspaceId===selected.id)!;
  assert.equal(selectedTab.kind,'manual');assert.equal(selectedTab.title,'手动浏览');assert.equal(selectedTab.state,'offline');
  assert.equal(selectedTab.projectKey,'workspace:selected-only');
  assert.notEqual(browserProjectKey({...selected,id:'another-workspace'}),selectedTab.projectKey,'Unresolved projects never merge unrelated workspaces by title');
});

test('unlinked or mismatched agents cannot impersonate a browser controller and status wording remains specific',()=>{
  const manual=item('manual','project-one',null);
  manual.agent={id:'unrelated-agent',title:'An unrelated running Agent',status:'running',provider:'synthetic',needsPermission:false};
  const unavailable=item('missing','project-one','missing-agent');
  unavailable.agent={id:'wrong-id',title:'Wrong Agent',status:'running',provider:'synthetic',needsPermission:false};
  const running=item('running','project-one','running-agent',{agentStatus:'running'});
  const busy=item('busy','project-one','busy-agent',{busy:true});
  const permission=item('permission','project-one','permission-agent',{permission:true});
  const tabs=buildAgentTabGroups([manual,unavailable,running,busy,permission]).flatMap(group=>group.tabs);
  const byId=(id:string)=>tabs.find(tab=>tab.workspaceId===id)!;
  assert.equal(byId('manual').kind,'manual');assert.equal(byId('manual').title,'手动浏览');assert.equal(byId('manual').agentId,null);
  assert(!byId('manual').accessibilityLabel.includes('unrelated'));
  assert.equal(byId('missing').kind,'unavailable');assert.equal(byId('missing').title,'Agent 暂不可用');
  assert(!byId('missing').accessibilityLabel.includes('Wrong Agent'));
  assert.equal(byId('running').state,'agent_running');assert.match(byId('running').statusLabel,/浏览器等待任务/);
  assert.equal(byId('busy').state,'browser_busy');assert.equal(byId('permission').state,'permission');
});

test('a login wall and manual control reach the tab mark; approvals and Agent work keep precedence',()=>{
  const login=item('login','project-one','login-agent');
  login.session.health={state:'login_required',summary:'页面疑似需要登录',checkedAt:1,httpStatus:200,origin:'https://sso.invalid'};
  const both=item('both','project-one','both-agent',{permission:true});both.session.health=login.session.health;
  const quiet=item('quiet','project-one','quiet-agent');quiet.session.mode='agent';
  const stopped=item('stopped','project-one',null);stopped.session.status='idle';
  const tabs=buildAgentTabGroups([login,both,quiet,stopped]).flatMap(group=>group.tabs);
  const byId=(id:string)=>tabs.find(tab=>tab.workspaceId===id)!;
  assert.equal(byId('login').state,'login');assert.match(byId('login').accessibilityLabel,/页面需要登录/);
  assert.equal(byId('both').state,'permission');
  assert.equal(byId('login').mode,'manual');assert.equal(byId('quiet').mode,'agent');assert.equal(byId('stopped').mode,null,'only a running browser has a controller');
  assert.equal(tabGlyph(byId('quiet').state,byId('quiet').mode),null);
  assert.deepEqual(tabGlyph('idle','manual'),{label:'手动',icon:'MousePointer2',tone:'amber'});
  assert.equal(tabGlyph('offline','manual'),null);
  assert.equal(tabGlyph('browser_busy','manual')?.motion,'spin');
});
