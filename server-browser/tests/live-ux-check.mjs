/** Real-client acceptance (v0.4 flows on the v0.7 layout). Mutates only the pre-existing local demo browser. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

import { invokeBrowserRpc, assertSeparateWorkspaces, baseUrl, browserLaunchOptions, daemonUrl, dataRoot, testChromium, testValue, testWorkspace } from './live-config.mjs';

const DEMO = testWorkspace({ aliases: ['BROWSER_UI_WORKSPACE', 'BROWSER_AGENT_WORKSPACE'] });
const PROTECTED = testWorkspace({ linked: true, aliases: ['BROWSER_OVERVIEW_LINKED_WORKSPACE'] });
assertSeparateWorkspaces(DEMO, PROTECTED);
const protectedPageTitle = testValue('BROWSER_TEST_LINKED_PAGE_TITLE');
const chromium = testChromium();
const output = path.resolve('artifacts/ux-v04');
const report = { version:'0.4', startedAt:new Date().toISOString(), checks:[], layouts:[], screenshots:[], errors:[], protectedPage:{}, limits:['Mobile coverage uses Chromium touch Web contexts; physical iOS/Android soft-keyboard behavior is not measured.'] };
const daemon = new DaemonClient({url:daemonUrl,clientId:'server-browser-ux-v04-acceptance',clientType:'cli'});
const rpc = (method,input) => invokeBrowserRpc(daemon,method,input);
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const selected = new WeakMap();
let browser, oracle, beforeDemo, beforeProtected, demoTitle;
let verifiedDemo=false;
const record = (name,details) => report.checks.push({name,passed:true,...(details?{details}:{})});

async function waitFor(predicate,message,timeout=20_000) {
  const end=Date.now()+timeout;
  let lastError;
  while(Date.now()<end) {
    try { const result=await predicate(); if(result)return result; }
    catch(error) { lastError=error; }
    await pause(100);
  }
  throw new Error(`${message}${lastError?`: ${lastError.message}`:''}`);
}

async function installWriteGuard(page) {
  await page.addInitScript(({demoId})=>{
    const original=WebSocket.prototype.send;
    globalThis.__uxWrites=[];
    globalThis.__uxBlockedWrites=0;
    WebSocket.prototype.send=function(payload) {
      const strings=[],objects=[];
      const visit=value=>{
        if(typeof value==='string')strings.push(value);
        else if(value && typeof value==='object') { objects.push(value); Object.values(value).forEach(visit); }
      };
      try { visit(JSON.parse(String(payload))); } catch {}
      const action=strings.includes('browser.action');
      const prohibited=strings.some(value=>['browser.start','browser.agent'].includes(value) || /^(?:agent|workspace|project)[._](?:create|run)$|^(?:create|run)[._](?:agent|workspace|project)$/.test(value));
      const ids=objects.map(value=>value.workspaceId).filter(value=>typeof value==='string');
      if(prohibited || action && (!ids.includes(demoId) || ids.some(id=>id!==demoId))) {
        globalThis.__uxBlockedWrites++;
        throw new Error('UX acceptance blocked a mutation outside its existing demonstration browser');
      }
      if(action) {
        const detail=objects.find(value=>value.action && typeof value.action==='object')?.action;
        globalThis.__uxWrites.push({kind:detail?.kind,width:detail?.width,height:detail?.height});
      }
      return original.call(this,payload);
    };
  },{demoId:DEMO});
  page.on('pageerror',error=>report.errors.push(error.message));
}

/** Tools open in host sheets (the ··· menu, 画面, 阅读 …) and typing happens in a tray under the page. */
async function closeDrawer(page) {
  const tray=page.getByTestId('server-browser-input-close');
  if(await tray.isVisible())await tray.click();
  const dialog=page.getByRole('dialog').first();
  if(!await dialog.isVisible().catch(()=>false))return;
  await page.keyboard.press('Escape');
  if(await dialog.isVisible().catch(()=>false))await dialog.getByRole('button',{name:/^(关闭|Close)$/}).first().click();
  await dialog.waitFor({state:'hidden'});
}

async function selectWorkspace(page,id) {
  selected.set(page,null);
  await closeDrawer(page);
  const options=await rpc('browser.options',{});
  const name=options.workspaces.find(workspace=>workspace.id===id)?.title;
  assert(name,'Expected existing workspace is visible to the plugin');
  // Desktop switches in the tab strip; phones (and unopened workspaces) go through the overview.
  const tab=page.getByTestId(`server-browser-agent-tab-${id}`);
  if(await tab.isVisible())await tab.click();
  else {
    await page.getByTestId('server-browser-workspace-picker').click();
    const card=page.getByTestId(`server-browser-overview-card-${id}`);
    await waitFor(async()=>await card.isVisible() || await page.getByTestId('server-browser-overview').isVisible(),'Browser overview did not open');
    if(await card.isVisible())await card.click();
    else { await page.getByTestId('server-browser-workspace-add').click(); await page.getByTestId(`server-browser-workspace-${id}`).click(); }
  }
  await waitFor(async()=> {
    const tab=page.getByTestId(`server-browser-agent-tab-${id}`);
    if(await tab.count())return await tab.getAttribute('aria-selected')==='true'&&(await tab.getAttribute('aria-label')||'').includes(name);
    return (await page.getByTestId('server-browser-workspace-picker').getAttribute('aria-label')||'').includes(name);
  },'Selected workspace identity did not update');
  selected.set(page,id);
}

async function openSurface(page) {
  await installWriteGuard(page);
  await page.goto(baseUrl);
  const entry=page.getByRole('button',{name:'服务器浏览器',exact:true});
  const menu=page.getByRole('button',{name:'Open menu',exact:true});
  await waitFor(async()=>await entry.isVisible() || await menu.isVisible(),'Paseo navigation did not finish loading',30_000);
  if(!await entry.isVisible())await menu.click();
  await entry.click({timeout:30_000});
  await page.getByTestId('server-browser-shell').waitFor({timeout:30_000});
  await selectWorkspace(page,DEMO);
  await page.getByTestId('server-browser-image').waitFor({timeout:30_000});
}

async function connectDemoOracle() {
  const meta=JSON.parse(await readFile(path.join(dataRoot,DEMO,'session.json'),'utf8'));
  const targets=await fetch(`${meta.cdpEndpoint}/json/list`).then(response=>response.json());
  const target=targets.find(value=>value.type==='page' && /互动体验/.test(value.title) && value.url==='about:blank');
  assert(target,'Only the existing local demonstration page may be inspected');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const pending=new Map();let sequence=0;
  socket.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data));const item=pending.get(message.id);if(!item)return;
    pending.delete(message.id);clearTimeout(item.timer);
    if(message.error)item.reject(new Error(message.error.message));else item.resolve(message.result);
  });
  return {
    close(){socket.close();for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Demo oracle closed'));}pending.clear();},
    async read(expression) {
      const id=++sequence;
      const response=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Demo oracle timeout'));},5_000);
        pending.set(id,{resolve,reject,timer});
        socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
      });
      if(response.exceptionDetails)throw new Error('Demonstration page read failed');
      return response.result.value;
    },
  };
}

async function screenshot(page,name) {
  assert.equal(selected.get(page),DEMO,'Full screenshots are restricted to the local demo workspace');
  const tab=page.getByTestId(`server-browser-agent-tab-${DEMO}`);
  const identity=await tab.count()?await tab.getAttribute('aria-label'):await page.getByTestId('server-browser-workspace-picker').getAttribute('aria-label');
  assert(identity?.includes(demoTitle),'The selected browser must remain the dedicated demo');
  await page.screenshot({path:path.join(output,name),fullPage:false});
  report.screenshots.push(name);
}

async function layoutMetrics(page,label) {
  await closeDrawer(page);
  const values=await page.evaluate(()=>{
    const element=id=>document.querySelector(`[data-testid="${id}"]`);
    const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
    const shell=element('server-browser-shell'),screen=element('server-browser-screen'),toolbar=element('server-browser-toolbar'),stage=element('server-browser-stage'),image=element('server-browser-image');
    const ancestors=[];
    for(let node=stage.parentElement;node && shell.contains(node);node=node.parentElement) {
      const style=getComputedStyle(node);
      if(['auto','scroll'].includes(style.overflowY) && node.scrollHeight>node.clientHeight+2)ancestors.push({testID:node.dataset.testid||'',height:node.clientHeight,scrollHeight:node.scrollHeight});
    }
    const identity=element('server-browser-identity-workspace')||document.querySelector('[data-testid^="server-browser-agent-tab-"][aria-selected="true"] [dir="auto"]')||document.querySelector('[data-testid^="server-browser-agent-tab-"][aria-selected="true"]');
    return{viewport:{width:innerWidth,height:innerHeight},shell:box(shell),screen:box(screen),toolbar:box(toolbar),stage:box(stage),image:box(image),keyboardButton:box(element('server-browser-keyboard')),address:box(element('server-browser-address')),outerScrollContainers:ancestors,documentWidth:document.documentElement.scrollWidth,shellScrollHeight:shell.scrollHeight,shellClientHeight:shell.clientHeight,textColor:getComputedStyle(identity).color};
  });
  values.label=label;
  values.stageShare=values.stage.height/values.shell.height;
  values.imageShareOfStage=values.image.width*values.image.height/(values.stage.width*values.stage.height);
  values.pageShareOfPanel=values.image.width*values.image.height/(values.shell.width*values.shell.height);
  assert(values.documentWidth<=values.viewport.width+2,`${label} has horizontal page overflow`);
  assert(values.shellScrollHeight<=values.shellClientHeight+2,`${label} has an outer scrolling panel`);
  assert.equal(values.outerScrollContainers.length,0,`${label} nests its viewport in a long outer scroll container`);
  assert(values.stage.y>=0 && values.stage.y+values.stage.height<=values.viewport.height+2,`${label} stage is not fully on the first screen`);
  assert(values.stageShare>=(values.viewport.width>values.viewport.height?0.60:0.64),`${label} webpage stage occupies only ${(values.stageShare*100).toFixed(1)}% of the panel`);
  assert(values.keyboardButton.width>=30 && values.keyboardButton.height>=30,`${label} keyboard control is compressed into an unusable target`);
  assert(values.address.width>=72,`${label} address input is compressed into a tiny field`);
  assert(values.image.width<=values.stage.width+2 && values.image.height<=values.stage.height+2,`${label} clips the server frame`);
  assert(Math.abs((values.image.x-values.stage.x)*2+values.image.width-values.stage.width)<3,`${label} image is not horizontally centered`);
  assert(Math.abs((values.image.y-values.stage.y)*2+values.image.height-values.stage.height)<3,`${label} image is not vertically centered`);
  const remote=await oracle.read('({width:innerWidth,height:innerHeight})');
  assert(Math.abs(values.image.width/values.image.height-remote.width/remote.height)<0.015,`${label} changes the server image aspect ratio`);
  report.layouts.push(values);
  return values;
}

async function matchWindow(page,label) {
  await closeDrawer(page);
  const stage=await page.getByTestId('server-browser-stage').boundingBox();
  const expected={width:Math.max(320,Math.min(2560,Math.floor(stage.width))),height:Math.max(320,Math.min(1600,Math.floor(stage.height)))};
  await page.getByTestId('server-browser-menu').click();
  await page.getByRole('button',{name:'匹配窗口',exact:true}).click();
  await closeDrawer(page);
  const matched=await waitFor(async()=>{
    const state=await rpc('browser.state',{workspaceId:DEMO});
    return Math.abs(state.width-expected.width)<=2 && Math.abs(state.height-expected.height)<=2 && state;
  },'Match window did not set the demo browser to its measured stage size');
  await ready(page);
  const metrics=await layoutMetrics(page,`${label}-matched`);
  const clamped=expected.width!==Math.floor(stage.width) || expected.height!==Math.floor(stage.height);
  if(!clamped)assert(metrics.imageShareOfStage>=0.98,`${label} matched frame still leaves substantial letterboxing`);
  metrics.match={expected,actual:{width:matched.width,height:matched.height},clamped};
  await screenshot(page,`${label}-matched.png`);
  record(`${label} explicit match-window uses the measured stage within supported dimensions`,{viewport:metrics.match,imageShareOfStage:metrics.imageShareOfStage,pageShareOfPanel:metrics.pageShareOfPanel});
  return matched;
}

async function ready(page) {
  await page.getByTestId('server-browser-image').waitFor({state:'visible'});
  await waitFor(async()=>await page.getByTestId('server-browser-menu').isEnabled(),'Toolbar remains busy');
  if(oracle)await waitFor(async()=>{
    const frame=await page.getByTestId('server-browser-image').boundingBox();
    const remote=await oracle.read('({width:innerWidth,height:innerHeight})');
    return frame && Math.abs(frame.width/frame.height-remote.width/remote.height)<0.015;
  },'Viewer has not received the current server viewport');
}

async function clickWebsite(page,selector,touch=false) {
  assert.equal(selected.get(page),DEMO);
  await closeDrawer(page);
  let point;
  for(let attempt=0;attempt<8;attempt++) {
    point=await oracle.read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight}})()`);
    assert(point,`Demo selector ${selector} exists`);
    if(point.y>=10 && point.y<point.height-10)break;
    await page.getByTestId('server-browser-frame').hover();
    await page.mouse.wheel(0,point.y<10?-350:350);
    await pause(200);
  }
  assert(point.y>=0 && point.y<point.height,`Demo selector ${selector} is visible in the server viewport`);
  const image=await page.getByTestId('server-browser-image').boundingBox();
  const frame=await page.getByTestId('server-browser-frame').boundingBox();
  assert(image && frame);
  const position={x:image.x-frame.x+point.x/point.width*image.width,y:image.y-frame.y+point.y/point.height*image.height};
  if(touch)await page.getByTestId('server-browser-frame').tap({position});else await page.getByTestId('server-browser-frame').click({position});
  await pause(120);
}

async function openMore(page) {
  await closeDrawer(page);
  await page.getByTestId('server-browser-menu').click();
  await page.getByRole('dialog').first().waitFor();
}

async function selectManual(page) {
  await closeDrawer(page);
  const manual=page.getByTestId('server-browser-manual');
  if(await manual.getAttribute('aria-selected')!=='true')await manual.click();
  await waitFor(async()=> (await rpc('browser.state',{workspaceId:DEMO})).mode==='manual','Manual mode did not reach demo browser');
}

async function resetDemo(page) {
  await openMore(page);
  await page.getByRole('button',{name:'打开演示页',exact:true}).click();
  await closeDrawer(page);
  await waitFor(async()=> (await rpc('browser.state',{workspaceId:DEMO})).title.includes('互动体验'),'Demo action did not complete');
  await ready(page);
}

async function testLetterbox(page) {
  await closeDrawer(page);
  const frame=await page.getByTestId('server-browser-frame').boundingBox();
  const image=await page.getByTestId('server-browser-image').boundingBox();
  assert(frame && image);
  const top=image.y-frame.y,left=image.x-frame.x;
  const point=top>3?{x:frame.width/2,y:top/2}:left>3?{x:left/2,y:frame.height/2}:null;
  assert(point,'This test viewport must have a visible letterbox region');
  const before=await page.evaluate(()=>globalThis.__uxWrites.length);
  const beforePage=await oracle.read('({count:document.querySelector("#count").textContent,focus:document.activeElement?.id,scroll:scrollY})');
  await page.getByTestId('server-browser-frame').click({position:point});
  await pause(400);
  assert.equal(await page.evaluate(()=>globalThis.__uxWrites.length),before,'Letterbox click sends no browser action');
  assert.deepEqual(await oracle.read('({count:document.querySelector("#count").textContent,focus:document.activeElement?.id,scroll:scrollY})'),beforePage);
  record('Letterbox clicks are inert while the page image remains centered');
}

async function testInputTray(page,touch=false) {
  await clickWebsite(page,'#visitor',touch);
  await page.getByTestId('server-browser-keyboard').click();
  const input=page.getByTestId('server-browser-input');
  await input.waitFor();
  const box=await input.boundingBox();
  assert(box && box.y>=0 && box.y+box.height<=page.viewportSize().height+1,'Text input must be reachable without scrolling down the page');
  await input.fill('中文同屏验收');
  await page.getByTestId('server-browser-send').click();
  await waitFor(async()=>await oracle.read('document.querySelector("#visitor").value')==='中文同屏验收','Chinese input did not reach demo');
  await page.getByTestId('server-browser-key-Backspace').click();
  await waitFor(async()=>await oracle.read('document.querySelector("#visitor").value')==='中文同屏验','Backspace did not reach the focused server field');
  await page.getByTestId('server-browser-key-Tab').click();
  await waitFor(async()=>await oracle.read('document.activeElement?.id')==='greet','Tab did not move focus on the server page');
  await page.getByTestId('server-browser-key-Enter').click();
  await waitFor(async()=> (await oracle.read('document.querySelector("#greeting").textContent')).includes('中文同屏验'),'Enter did not activate the focused server button');
  await closeDrawer(page);
  record(`${touch?'Mobile':'Desktop'} input tray sends Chinese text, Backspace, Tab and Enter`,{inputTop:box.y,inputBottom:box.y+box.height});
}

async function touchDrag(page,context) {
  await closeDrawer(page);
  const frame=await page.getByTestId('server-browser-image').boundingBox();
  const start={x:Math.round(frame.x+frame.width*0.65),y:Math.round(frame.y+frame.height*0.75)};
  const distance=Math.min(150,frame.height*0.5);
  const cdp=await context.newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
    for(let step=1;step<=8;step++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:Math.round(start.y-distance*step/8)}]});
      await pause(20);
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  } finally { await cdp.detach(); }
}

async function restoreDemo() {
  if(!beforeDemo || !verifiedDemo)return;
  // The SDK is used only for exact restoration of the pre-existing demo's
  // dimensions/mode. Browser tests never create a Paseo workspace or Agent.
  await rpc('browser.action',{workspaceId:DEMO,action:{kind:'mode',mode:'manual'}});
  await rpc('browser.action',{workspaceId:DEMO,action:{kind:'viewport',width:beforeDemo.width,height:beforeDemo.height}});
  await rpc('browser.action',{workspaceId:DEMO,action:{kind:'mode',mode:beforeDemo.mode}});
  const restored=await waitFor(async()=>{
    const state=await rpc('browser.state',{workspaceId:DEMO});
    return state.width===beforeDemo.width && state.height===beforeDemo.height && state.mode===beforeDemo.mode && state;
  },'Demo viewport/mode did not return to its exact pre-test state',2_000);
  assert.equal(restored.width,beforeDemo.width);assert.equal(restored.height,beforeDemo.height);assert.equal(restored.mode,beforeDemo.mode);
  report.demoRestored={width:restored.width,height:restored.height,mode:restored.mode};
}

try {
  await mkdir(output,{recursive:true});
  await daemon.connect();
  beforeDemo=await waitFor(async()=>{const state=await rpc('browser.state',{workspaceId:DEMO});return state.status==='running' && state;},'Existing demo browser is still restoring',60_000);
  beforeProtected=await waitFor(async()=>{const state=await rpc('browser.state',{workspaceId:PROTECTED});return state.status==='running' && state;},'Existing protected browser is still restoring',60_000);
  assert(beforeProtected.title.includes(protectedPageTitle) && !/login|sign[ -]?in|登录/i.test(new URL(beforeProtected.url).pathname),'Protected browser must finish restoring the explicitly configured authenticated page');
  assert.equal(beforeDemo.status,'running','The pre-existing demo browser must already be running');
  assert.equal(beforeDemo.url,'about:blank','Refuse to alter a demo workspace that now contains a real website');
  assert.match(beforeDemo.title,/互动体验/);
  verifiedDemo=true;
  report.demoBefore={width:beforeDemo.width,height:beforeDemo.height,mode:beforeDemo.mode};
  console.log(JSON.stringify({phase:'verified-existing-demo',...report.demoBefore}));
  const options=await rpc('browser.options',{});
  demoTitle=options.workspaces.find(workspace=>workspace.id===DEMO)?.title;
  assert(demoTitle);
  browser=await chromium.launch(browserLaunchOptions());
  const desktopContext=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
  const desktop=await desktopContext.newPage();
  await openSurface(desktop);
  await selectManual(desktop);
  await resetDemo(desktop);
  oracle=await connectDemoOracle();
  await layoutMetrics(desktop,'desktop-1440x900-dark-fit');
  await screenshot(desktop,'desktop-1440x900-dark-fit.png');
  const matched=await matchWindow(desktop,'desktop-1440x900-dark');
  await testInputTray(desktop);
  await clickWebsite(desktop,'#visitor');
  await desktop.keyboard.press('Control+A');
  await desktop.keyboard.type('Desktop',{delay:50});
  await waitFor(async()=>await oracle.read('document.querySelector("#visitor").value')==='Desktop','Focused desktop keyboard input did not reach the server field');
  await desktop.keyboard.press('Backspace');
  await waitFor(async()=>await oracle.read('document.querySelector("#visitor").value')==='Deskto','Desktop Backspace did not reach the server field');
  record('Clicking the page enables direct desktop keyboard input and Backspace');

  await desktop.setViewportSize({width:1280,height:720});
  await pause(450);
  await layoutMetrics(desktop,'desktop-1280x720-dark-fit');
  const afterDesktopResize=await rpc('browser.state',{workspaceId:DEMO});
  assert.equal(afterDesktopResize.width,matched.width,'Resizing a viewer must not resize the shared server viewport');
  assert.equal(afterDesktopResize.height,matched.height,'Resizing a viewer must not resize the shared server viewport');
  await screenshot(desktop,'desktop-1280x720-dark-fit.png');
  await matchWindow(desktop,'desktop-1280x720-dark');

  for(const [feature,label] of [['diagnostics','页面诊断'],['reading','阅读页面']]) {
    await openMore(desktop);
    await desktop.getByRole('button',{name:label,exact:true}).click();
    await desktop.getByTestId(`server-browser-${feature}-run`).click();
    await desktop.getByTestId(`server-browser-${feature}-result`).waitFor();
    await closeDrawer(desktop);
    record(`${feature} remains reachable through the ··· menu`);
  }
  await selectWorkspace(desktop,PROTECTED);
  assert.equal(selected.get(desktop),PROTECTED);
  // No protected-page DOM inspection or screenshot: state is the only evidence.
  const inspectedProtected=await rpc('browser.state',{workspaceId:PROTECTED});
  assert(inspectedProtected.url===beforeProtected.url && inspectedProtected.title===beforeProtected.title,'Protected page title and URL must remain unchanged');
  await selectWorkspace(desktop,DEMO);
  record('Overview switches to the exact existing workspace and closes cleanly without altering its webpage');

  const contexts=[];
  for(const size of [{width:390,height:844,label:'mobile-390x844-light'},{width:320,height:568,label:'mobile-320x568-light'},{width:844,height:390,label:'landscape-844x390-light'}]) {
    const context=await browser.newContext({viewport:{width:size.width,height:size.height},isMobile:true,hasTouch:true,deviceScaleFactor:1,colorScheme:'light'});
    contexts.push(context);
    const page=await context.newPage();
    const viewportBefore=await rpc('browser.state',{workspaceId:DEMO});
    await openSurface(page);
    await pause(450);
    const viewportAfter=await rpc('browser.state',{workspaceId:DEMO});
    assert.equal(viewportAfter.width,viewportBefore.width);assert.equal(viewportAfter.height,viewportBefore.height);
    assert.equal(await page.evaluate(()=>globalThis.__uxWrites.length),0,'Opening another client must be read-only');
    await layoutMetrics(page,`${size.label}-fit`);
    await screenshot(page,`${size.label}-fit.png`);
    if(size.width===390) {
      await testLetterbox(page);
    }
    await matchWindow(page,size.label);
    if(size.width===390) {
      await resetDemo(page);
      await testInputTray(page,true);
      await screenshot(page,'mobile-390-input-complete.png');
      const scrollBefore=await oracle.read('scrollY');
      const countBefore=await oracle.read('document.querySelector("#count").textContent');
      await touchDrag(page,context);
      await waitFor(async()=>await oracle.read('scrollY')>scrollBefore,'Touch drag did not scroll the server page');
      assert.equal(await oracle.read('document.querySelector("#count").textContent'),countBefore,'Touch drag must not produce a second click');
      record('Touch drag scrolls the server page without clicking a control');
    }
    await closeDrawer(page);
  }
  record('All five fit and matched viewers preserve aspect ratio with no outer or horizontal page scrolling');
  const dark=report.layouts.find(item=>item.label.includes('-dark')).textColor;
  const light=report.layouts.find(item=>item.label.includes('-light')).textColor;
  assert.notEqual(dark,light,'Theme changes must propagate to visible identity text');
  record('Dark and light themes change readable toolbar text colors',{dark,light});
  await desktop.getByTestId('server-browser-frame').hover();
  const wheelBefore=await oracle.read('scrollY');
  await desktop.mouse.wheel(0,-400);
  await waitFor(async()=>await oracle.read('scrollY')<wheelBefore,'Desktop wheel did not reach the server page');
  record('Desktop mouse wheel reaches the shared server page');
  for(const context of browser.contexts())for(const page of context.pages())assert.equal(await page.evaluate(()=>globalThis.__uxBlockedWrites??0),0);
  assert.equal(report.errors.length,0,`Unexpected client errors: ${report.errors.join('; ')}`);
  report.passed=true;
} catch(error) {
  report.passed=false;
  report.failure=error instanceof Error?error.stack:String(error);
  console.error(report.failure);
  process.exitCode=1;
  if(browser)for(const [index,page] of browser.contexts().flatMap(context=>context.pages()).entries())if(selected.get(page)===DEMO)await screenshot(page,`failure-demo-${index}.png`).catch(()=>{});
} finally {
  oracle?.close();
  await browser?.close();
  browser=undefined;
  try { await restoreDemo(); } catch(error) { report.restoreFailure=error.message;report.passed=false;process.exitCode=1; }
  if(beforeProtected)try {
    const after=await rpc('browser.state',{workspaceId:PROTECTED});
    const snapshot=value=>({title:value.title,url:value.url,width:value.width,height:value.height,mode:value.mode,tabs:value.tabs.map(tab=>({id:tab.id,title:tab.title,url:tab.url,active:tab.active}))});
    assert(JSON.stringify(snapshot(after))===JSON.stringify(snapshot(beforeProtected)),'Protected page title, URL, tabs, viewport and mode must remain unchanged');
    report.protectedPage={titlePreserved:true,urlPreserved:true,tabsPreserved:true,viewportPreserved:true,modePreserved:true,contentInspected:false,screenshotTaken:false};
  } catch(error) { report.protectedPage={preserved:false,error:error.message};report.passed=false;process.exitCode=1; }
  await daemon.close();
  report.finishedAt=new Date().toISOString();
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'live-ux-report.json'),`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,layouts:report.layouts.map(item=>({label:item.label,stagePercent:Number((item.stageShare*100).toFixed(1)),imagePercentOfStage:Number((item.imageShareOfStage*100).toFixed(1)),pagePercentOfPanel:Number((item.pageShareOfPanel*100).toFixed(1))})),protectedPage:report.protectedPage,demoRestored:report.demoRestored,errors:report.errors.length},null,2));
}
