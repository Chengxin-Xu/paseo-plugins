/** Read-only acceptance of browser switching (v0.5 guarantees, v0.7 layout). No browser actions, new entities, or business-page screenshots. */
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

import { assertSeparateWorkspaces, baseUrl, browserLaunchOptions, daemonUrl, dataRoot, testChromium, testValue, testWorkspace } from './live-config.mjs';

// Same-project multiple-Agent layouts are covered with synthetic data by `npm run test:ui` (preview fixture).
const workspaceIds=[testWorkspace({aliases:['BROWSER_UI_WORKSPACE','BROWSER_OVERVIEW_LOCAL_WORKSPACE']}),testWorkspace({linked:true,aliases:['BROWSER_OVERVIEW_LINKED_WORKSPACE']})];
assertSeparateWorkspaces(...workspaceIds);
const linkedPageTitle=testValue('BROWSER_TEST_LINKED_PAGE_TITLE');
const chromium=testChromium();
const output=path.resolve('artifacts/agent-tabs-v07');
const report={version:'0.7',readOnly:true,startedAt:new Date().toISOString(),checks:[],layouts:[],screenshots:[],errors:[],limits:['Live evidence covers the two existing browser sessions. Same-project multiple-Agent rendering is synthetic evidence from npm run test:ui.']};
const daemon=new DaemonClient({url:daemonUrl,clientId:'agent-tabs-read-only-acceptance',clientType:'cli'});
const paseo=createPaseoApi(daemon);
const rpc=(method,input)=>{
  assert(['browser.state','browser.overview','browser.options'].includes(method),'Acceptance RPCs are read-only');
  return daemon.invokePluginRpc('server-browser',method,input);
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const record=(name,details)=>report.checks.push({name,passed:true,...(details?{details}:{})});
let browser,beforeStates,beforeEntities,beforeProfiles;

async function waitFor(predicate,message,timeout=20_000) {
  const end=Date.now()+timeout;let lastError;
  while(Date.now()<end) { try { const result=await predicate();if(result)return result; } catch(error) {lastError=error;} await pause(100); }
  throw new Error(`${message}${lastError?`: ${lastError.message}`:''}`);
}
async function pageAll(list,id) {
  const ids=[];let cursor;
  for(let count=0;count<50;count++) {
    const result=await list({page:{limit:200,...(cursor?{cursor}:{})}});
    ids.push(...result.entries.map(id));
    if(!result.pageInfo?.hasMore)return [...new Set(ids)].sort();
    assert(result.pageInfo.nextCursor && result.pageInfo.nextCursor!==cursor,'Entity-list cursor must advance');
    cursor=result.pageInfo.nextCursor;
  }
  throw new Error('Entity list exceeded its bounded page limit');
}
async function entities() {
  const [agents,workspaces,projects]=await Promise.all([
    pageAll(options=>paseo.agents.list(options),entry=>entry.agent.id),
    pageAll(options=>paseo.workspaces.list(options),entry=>entry.id),
    paseo.projects.list(),
  ]);
  return{agents,workspaces,projects:projects.projects.map(project=>project.projectId).sort()};
}
async function profiles() {
  return(await readdir(dataRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();
}
function browserIdentity(state) {
  return{workspaceId:state.workspaceId,status:state.status,title:state.title,url:state.url,mode:state.mode,width:state.width,height:state.height,agentId:state.agentId,tabs:state.tabs.map(tab=>({id:tab.id,title:tab.title,url:tab.url,active:tab.active,pinned:tab.pinned}))};
}
async function installGuard(page) {
  await page.addInitScript(()=>{
    const send=WebSocket.prototype.send;
    globalThis.__agentTabsBlockedWrites=0;
    WebSocket.prototype.send=function(payload) {
      const strings=[];
      const inspect=value=>{if(typeof value==='string')strings.push(value);else if(value && typeof value==='object')Object.values(value).forEach(inspect);};
      try {inspect(JSON.parse(String(payload)));} catch {}
      const denied=strings.some(value=>['browser.action','browser.start','browser.agent'].includes(value) || /^(?:create_agent_request|workspace_create_request|agent\.create|workspace\.create|project\.create|agent\.run)$/.test(value));
      if(denied) {globalThis.__agentTabsBlockedWrites++;throw new Error('Read-only Agent-tab acceptance blocked a write');}
      return send.call(this,payload);
    };
  });
  page.on('pageerror',error=>report.errors.push(error.message));
}
async function open(page) {
  await installGuard(page);
  await page.goto(baseUrl);
  const entry=page.getByRole('button',{name:'服务器浏览器',exact:true});
  const menu=page.getByRole('button',{name:'Open menu',exact:true});
  await waitFor(async()=>await entry.isVisible() || await menu.isVisible(),'Paseo navigation did not load',30_000);
  if(!await entry.isVisible())await menu.click();
  await entry.click();
  await page.getByTestId('server-browser-toolbar').waitFor({timeout:30_000});
}
async function closeSheet(page) {
  const dialog=page.getByRole('dialog').first();
  if(!await dialog.isVisible().catch(()=>false))return;
  await page.keyboard.press('Escape');
  if(await dialog.isVisible().catch(()=>false))await dialog.getByRole('button',{name:/^(关闭|Close)$/}).first().click();
  await dialog.waitFor({state:'hidden'});
}
/** Page tabs live in a sheet: the tab-count button, or ··· → 标签页 on phones while the Agent is in control. */
async function pageTabIds(page) {
  const button=page.getByTestId('server-browser-tabs');
  if(await button.isVisible())await button.click();
  else { await page.getByTestId('server-browser-menu').click(); await page.getByRole('button',{name:/^标签页 \d+$/}).click(); }
  const rows=page.locator('[data-testid^="server-browser-tab-"]');
  await rows.first().waitFor();
  const tabs=await rows.evaluateAll(elements=>elements.map(element=>({id:element.getAttribute('data-testid').replace('server-browser-tab-',''),text:element.innerText})));
  await closeSheet(page);
  return tabs;
}
async function selectBrowser(page,workspaceId,desktop) {
  if(desktop) {
    const top=page.getByTestId(`server-browser-agent-tab-${workspaceId}`);
    await top.scrollIntoViewIfNeeded();
    await top.click();
    await waitFor(async()=>await top.getAttribute('aria-selected')==='true','The selected Agent tab is not announced');
    await waitFor(async()=>{
      const tab=await top.boundingBox(),strip=await page.getByTestId('server-browser-agent-tabs').boundingBox();
      return tab && strip && tab.width<=strip.width+1 && tab.x>=strip.x-1 && tab.x+tab.width<=strip.x+strip.width+1;
    },'The selected Agent tab is clipped by the available top-row width');
  } else {
    await page.getByTestId('server-browser-workspace-picker').click();
    await page.getByTestId(`server-browser-overview-card-${workspaceId}`).click();
    await page.getByTestId('server-browser-overview').waitFor({state:'hidden'});
  }
  const expected=beforeStates[workspaceId].tabs;
  const shown=await waitFor(async()=>{
    const tabs=await pageTabIds(page);
    return JSON.stringify(tabs.map(tab=>tab.id).sort())===JSON.stringify(expected.map(tab=>tab.id).sort()) && tabs;
  },'Webpage tabs do not belong to the selected browser');
  for(const tab of expected)assert(shown.find(item=>item.id===tab.id).text.includes(tab.title || '新标签页'),'Webpage tab title does not match its server target');
  const fresh=await rpc('browser.state',{workspaceId});
  assert(JSON.stringify(browserIdentity(fresh))===JSON.stringify(browserIdentity(beforeStates[workspaceId])),'Selecting a browser changed its server browser state');
}
async function toolbarShot(page,name) {
  // This exact locator excludes the stage, including all business-page pixels.
  await page.getByTestId('server-browser-toolbar').screenshot({path:path.join(output,name)});
  report.screenshots.push(name);
}
async function inspectLayout(page,label,desktop) {
  const value=await page.evaluate(()=>{
    const get=id=>document.querySelector(`[data-testid="${id}"]`);
    const box=element=>{const rect=element.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,height:rect.height};};
    return{viewport:{width:innerWidth,height:innerHeight},toolbar:box(get('server-browser-toolbar')),shell:box(get('server-browser-shell')),stage:box(get('server-browser-stage')),documentWidth:document.documentElement.scrollWidth,shellScrollHeight:get('server-browser-shell').scrollHeight,shellHeight:get('server-browser-shell').clientHeight,visibleOverview:!!get('server-browser-overview')};
  });
  assert(value.toolbar.height<=(desktop?82:50.5),'Browser chrome must stay within two rows on desktop and one on phones');
  assert(value.documentWidth<=value.viewport.width+1,'Browser chrome must not cause horizontal page overflow');
  assert(value.shellScrollHeight<=value.shellHeight+2,'Browser chrome must not introduce an outer scrolling page');
  assert(!value.visibleOverview,'The all-browsers overview is its own view, never stacked above the page');
  value.stageShare=value.stage.height/value.shell.height;
  assert(value.stageShare>=0.62,'The chrome takes too much space from the webpage');
  value.label=label;report.layouts.push(value);
}

try {
  await mkdir(output,{recursive:true});await daemon.connect();
  beforeEntities=await entities();beforeProfiles=await profiles();beforeStates={};
  for(const workspaceId of workspaceIds)beforeStates[workspaceId]=await waitFor(async()=>{const state=await rpc('browser.state',{workspaceId});return state.status==='running' && state;},'Existing browser restoration is not complete',60_000);
  beforeStates[workspaceIds[1]]=await waitFor(async()=>{const state=await rpc('browser.state',{workspaceId:workspaceIds[1]});return state.status==='running'&&state.tabs.some(tab=>tab.title.includes(linkedPageTitle))&&state;},'The explicitly configured protected page has not finished rendering',30_000);
  const overview=await rpc('browser.overview',{});
  browser=await chromium.launch(browserLaunchOptions());
  for(const size of [{width:1440,height:900,name:'desktop-1440x900',mobile:false},{width:390,height:844,name:'mobile-390x844',mobile:true},{width:320,height:568,name:'mobile-320x568',mobile:true}]) {
    const context=await browser.newContext({viewport:{width:size.width,height:size.height},isMobile:size.mobile,hasTouch:size.mobile,deviceScaleFactor:1,colorScheme:size.mobile?'light':'dark'});
    const page=await context.newPage();await open(page);
    const desktop=await page.getByTestId('server-browser-agent-tabs').isVisible();
    assert.equal(desktop,!size.mobile,'Desktop shows the tab strip; phones keep a single row and switch in the overview');
    for(const workspaceId of workspaceIds) {
      const item=overview.items.find(item=>item.workspace.id===workspaceId);assert(item);
      const linked=item.agent && item.agent.id===item.session.agentId?item.agent:null;
      const expected=linked?linked.title:item.session.agentId?'Agent 暂不可用':'手动浏览';
      if(desktop) {
        const tab=page.getByTestId(`server-browser-agent-tab-${workspaceId}`);
        await tab.waitFor();assert.equal(await tab.getAttribute('role'),'tab');
        assert((await tab.innerText()).includes(expected),'Tabs must display the exact linked Agent or an explicit manual browser');
        const label=await tab.getAttribute('aria-label');
        assert(label?.includes(item.workspace.title) && label.includes(expected) && label.includes(item.workspace.projectTitle || '项目'),'Tab labels name the project, the Agent and the workspace');
        assert(await tab.evaluate(element=>[...element.querySelectorAll('div')].some(dot=>{const style=getComputedStyle(dot);return style.width==='8px'&&style.height==='8px'&&style.backgroundColor!=='rgba(0, 0, 0, 0)';})),'Each tab carries its project color dot');
      } else {
        await page.getByTestId('server-browser-workspace-picker').click();
        const card=page.getByTestId(`server-browser-overview-card-${workspaceId}`);
        await card.waitFor();
        assert((await card.innerText()).includes(expected),'Overview rows display the exact linked Agent or an explicit manual browser');
        assert((await card.getAttribute('aria-label'))?.includes(item.workspace.title),'Overview rows name the workspace');
        await page.getByTestId('server-browser-overview-back').click();
      }
    }
    await selectBrowser(page,workspaceIds[0],desktop);
    await inspectLayout(page,size.name,desktop);
    await toolbarShot(page,`${size.name}-manual-toolbar.png`);
    await selectBrowser(page,workspaceIds[1],desktop);
    await toolbarShot(page,`${size.name}-linked-toolbar.png`);
    await selectBrowser(page,workspaceIds[0],desktop);
    if(desktop) {
      const selectedTop=page.getByTestId(`server-browser-agent-tab-${workspaceIds[0]}`);
      await selectedTop.focus();
      assert(await selectedTop.evaluate(element=>element===document.activeElement),'Selected Agent tab can receive keyboard focus');
      await selectedTop.press('Enter');
      await waitFor(async()=>await selectedTop.getAttribute('aria-selected')==='true','Keyboard activation must preserve the selected tab');
    }
    record(`${size.name}: exact Agent identity, project dots and browser/page tab selection preserve server state`);
    await page.getByTestId('server-browser-workspace-picker').click();
    await page.getByTestId('server-browser-overview').waitFor();
    await page.getByLabel('搜索项目、工作区、Agent 或页面').fill('');
    await page.getByTestId(`server-browser-overview-card-${workspaceIds[1]}`).click();
    await page.getByTestId('server-browser-overview').waitFor({state:'hidden'});
    if(desktop)await waitFor(async()=>await page.getByTestId(`server-browser-agent-tab-${workspaceIds[1]}`).getAttribute('aria-selected')==='true','Overview selection did not update the Agent tab');
    else await waitFor(async()=>(await page.getByTestId('server-browser-workspace-picker').getAttribute('aria-label')||'').includes(overview.items.find(item=>item.workspace.id===workspaceIds[1]).workspace.title),'Overview selection did not update the current browser');
    await selectBrowser(page,workspaceIds[0],desktop);
    assert.equal(await page.evaluate(()=>globalThis.__agentTabsBlockedWrites),0);
    record(`${size.name}: overview and keyboard accessibility remain available without browser writes`);
  }
  assert.equal(report.errors.length,0,`Client errors: ${report.errors.join('; ')}`);
  report.passed=true;
} catch(error) {
  report.passed=false;report.failure=error.stack||String(error);console.error(report.failure);process.exitCode=1;
  if(browser)for(const [index,page]of browser.contexts().flatMap(context=>context.pages()).entries())if(await page.getByTestId('server-browser-toolbar').isVisible())await toolbarShot(page,`failure-toolbar-${index}.png`).catch(()=>{});
} finally {
  await browser?.close();
  if(beforeStates)try {
    for(const workspaceId of workspaceIds) {
      const state=await rpc('browser.state',{workspaceId});
      assert(JSON.stringify(browserIdentity(state))===JSON.stringify(browserIdentity(beforeStates[workspaceId])),'Existing browser URL, active target, dimensions, mode or tabs changed');
    }
    report.browsersPreserved=true;
  } catch(error) {report.passed=false;report.preservationFailure=error.message;process.exitCode=1;}
  if(beforeEntities && beforeProfiles)try {
    const afterEntities=await entities(),afterProfiles=await profiles();
    assert(JSON.stringify(beforeEntities)===JSON.stringify(afterEntities),'Agent, workspace or project identities changed during the read-only check');
    assert(JSON.stringify(beforeProfiles)===JSON.stringify(afterProfiles),'Browser profile identities changed during the read-only check');
    report.noNewEntities=true;report.noNewProfiles=true;report.noBrowserWrites=true;
    report.entityCounts={agents:beforeEntities.agents.length,workspaces:beforeEntities.workspaces.length,projects:beforeEntities.projects.length,profiles:beforeProfiles.length};
  } catch(error) {report.passed=false;report.entityFailure=error.message;process.exitCode=1;}
  await daemon.close();report.finishedAt=new Date().toISOString();
  await mkdir(output,{recursive:true});await writeFile(path.join(output,'live-agent-tabs-report.json'),`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,layouts:report.layouts.map(item=>({label:item.label,chromeHeight:item.toolbar.height,stagePercent:Number((item.stageShare*100).toFixed(1))})),browsersPreserved:report.browsersPreserved,noNewEntities:report.noNewEntities,noNewProfiles:report.noNewProfiles,noBrowserWrites:report.noBrowserWrites,errors:report.errors.length},null,2));
}
