import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { TestBrowserManager as BrowserManager } from './manual-action';
import { defaultRuntimeRoot } from '../server/runtime';
import { computeViewportLayout, mapViewportPoint } from '../client/viewport-geometry';

const runtimeRoot=defaultRuntimeRoot();

async function fixture(t:TestContext,html:string) {
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-page-fit-test-'));
  const workspaceId='isolated-page-fit';
  const manager=new BrowserManager({dataRoot,runtimeRoot});
  const auth=randomBytes(20).toString('hex');
  const traffic={documentRequests:0};
  let connection:Browser|undefined;
  const server=createServer((request,response)=>{
    if(new URL(request.url??'/', 'http://fixture.invalid').pathname!=='/fixture') { response.writeHead(404);response.end();return; }
    traffic.documentRequests++;
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','set-cookie':`fit_fixture=${auth}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`});
    response.end(html);
  });
  t.after(async()=>{
    await connection?.close().catch(()=>{});
    await manager.close();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dataRoot,{recursive:true,force:true});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/fixture?scope=synthetic&id=42#preserved`;
  await manager.start(workspaceId);
  await manager.action(workspaceId,{kind:'navigate',url});
  const metadata=JSON.parse(await readFile(manager.metadataPath(workspaceId),'utf8'));
  connection=await chromium.connectOverCDP(metadata.cdpEndpoint);
  const context=connection.contexts()[0];
  const page=context.pages().find(candidate=>candidate.url()===url);assert(page);
  return {manager,workspaceId,url,page,context,traffic,auth};
}

const rootWide=`<!doctype html><html><head><title>Wide enterprise page</title><style>
  html{margin:0}body{margin:0;min-width:1480px;height:2400px;position:relative}
  button{position:absolute;right:24px;top:100px;width:140px;height:44px}
  </style></head><body><h1>Enterprise layout</h1><input id="query" value="preserve this filter"><button id="right-action" onclick="document.querySelector('output').textContent='right-clicked'">Right edge action</button><output>untouched</output><footer style="position:absolute;bottom:0">Vertical content remains below the fold</footer></body></html>`;

function nestedWide(minWidth=1320) { return `<!doctype html><html><head><title>Nested enterprise table</title><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden}
  aside{position:absolute;left:0;top:0;bottom:0;width:220px}
  main{position:absolute;left:220px;right:0;top:60px;bottom:0;overflow:auto}
  .content{position:relative;min-width:${minWidth}px;height:2400px}
  button{position:absolute;right:16px;top:24px;width:120px;height:40px}
  </style></head><body><aside>Fixed sidebar</aside><main><div class="content"><button id="right-action" onclick="document.querySelector('output').textContent='nested-clicked'">Last column action</button><output>untouched</output><p>Scrollable table rows</p></div></main></body></html>`; }

test('fit width expands a min-width page and keeps the entire real viewport actionable', {timeout:30_000}, async t=>{
  const {manager,workspaceId,page}=await fixture(t,rootWide);
  const before=await page.evaluate('({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth})') as {width:number;height:number;scrollWidth:number};
  assert.deepEqual(before,{width:1120,height:720,scrollWidth:1480});
  const fitted=await manager.action(workspaceId,{kind:'fitWidth'});
  assert(fitted.width>=1480 && fitted.width<=1536,'Expansion follows the required page width with bounded rounding');
  assert.equal(fitted.height,720);
  const after=await page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight})') as {width:number;scrollWidth:number;scrollHeight:number};
  assert(after.scrollWidth<=after.width+1,'The document no longer requires horizontal scrolling');
  assert(after.scrollHeight>2000,'Fitting width must not flatten the page into its full height');
  const frame=(await manager.frame(workspaceId,null,'sharp')).frame;assert(frame);
  assert.equal(frame.width,fitted.width);assert.equal(frame.height,720,'Frame is the actionable viewport, not a full-page photograph');
  const rect=await page.locator('#right-action').boundingBox();assert(rect);
  assert(rect.x+rect.width<=fitted.width && rect.y+rect.height<720,'The right edge action is inside the real browser viewport');
  const layout=computeViewportLayout({containerWidth:390,containerHeight:603,frameWidth:frame.width,frameHeight:frame.height});
  assert(layout.imageWidth<=390+1e-8 && layout.imageHeight<=603+1e-8);
  const sourcePoint={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  const mapped=mapViewportPoint({x:layout.offsetX+sourcePoint.x*layout.scale,y:layout.offsetY+sourcePoint.y*layout.scale},layout,{frameWidth:frame.width,frameHeight:frame.height});
  assert(mapped);
  await manager.action(workspaceId,{kind:'click',...mapped});
  assert.equal(await page.locator('output').textContent(),'right-clicked');
  await page.mouse.move(400,300);
  await manager.action(workspaceId,{kind:'scroll',deltaX:0,deltaY:400});
  await page.waitForFunction('scrollY>0');
});

test('fit width finds a wide nested table behind a fixed sidebar and retains nested vertical scrolling', {timeout:30_000}, async t=>{
  const {manager,workspaceId,page}=await fixture(t,nestedWide());
  const measure=()=>page.evaluate(`(()=>{const main=document.querySelector('main'),button=document.querySelector('button').getBoundingClientRect();return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,clientWidth:main.clientWidth,scrollWidth:main.scrollWidth,clientHeight:main.clientHeight,scrollHeight:main.scrollHeight,buttonRight:button.right}})()`) as Promise<{width:number;height:number;documentWidth:number;clientWidth:number;scrollWidth:number;clientHeight:number;scrollHeight:number;buttonRight:number}>;
  const before=await measure();
  assert.equal(before.width,1120);assert.equal(before.documentWidth,1120,'Root scrollWidth alone misses this clipped application pane');
  assert(before.clientWidth>=880 && before.clientWidth<=900,'The content pane excludes the 220px sidebar and any native scrollbar');
  assert.equal(before.scrollWidth,1320);assert(before.buttonRight>1120);
  const requiredWidth=before.width+before.scrollWidth-before.clientWidth;
  const fitted=await manager.action(workspaceId,{kind:'fitWidth'});
  const after=await measure();
  assert(fitted.width>=requiredWidth && fitted.width<=requiredWidth+64,'The fixed sidebar and scrollbar widths are included in the required outer viewport');
  assert.equal(after.height,720);
  assert(after.scrollWidth<=after.clientWidth+1);
  assert(after.buttonRight<=after.width);
  assert(after.scrollHeight>after.clientHeight);
  const rect=await page.locator('#right-action').boundingBox();assert(rect);
  await manager.action(workspaceId,{kind:'click',x:rect.x+rect.width/2,y:rect.y+rect.height/2});
  assert.equal(await page.locator('output').textContent(),'nested-clicked');
  await page.mouse.move(500,300);
  await manager.action(workspaceId,{kind:'scroll',deltaX:0,deltaY:400});
  await page.waitForFunction('document.querySelector("main").scrollTop>0');
  assert.equal(await page.evaluate('scrollX'),0);
  const frame=(await manager.frame(workspaceId,null,'sharp')).frame;assert(frame);
  assert.equal(frame.width,after.width);assert.equal(frame.height,720);
});

test('fit width ignores hidden and short marquee overflow, preserves state, and never shrinks an already wide viewport', {timeout:30_000}, async t=>{
  const html=`<!doctype html><html><head><title>Already fitting application</title><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden}
    .ticker{height:28px;width:100%;overflow:auto}.ticker-content{width:8000px}
    .hidden{display:none;width:12000px;height:500px;overflow:auto}
    .invisible{position:absolute;left:0;right:0;top:80px;height:400px;overflow:auto;visibility:hidden}.invisible>div{width:9000px}
    .transparent{position:absolute;left:0;right:0;top:80px;height:400px;overflow:auto;opacity:0}.transparent>div{width:10000px}
    main{position:absolute;left:0;right:0;top:60px;bottom:0;overflow:auto}
    </style></head><body><div class="ticker"><div class="ticker-content">Short ticker content</div></div><div class="hidden">Hidden content</div><div class="invisible"><div>Invisible</div></div><div class="transparent"><div>Transparent</div></div><main><input id="query" value="retained input"><p>Application content fits its pane</p></main></body></html>`;
  const {manager,workspaceId,page,context,url,traffic,auth}=await fixture(t,html);
  const before=await manager.state(workspaceId),targetId=before.tabs.find(tab=>tab.active)!.id;
  const cookiesBefore=(await context.cookies(url)).filter(cookie=>cookie.name==='fit_fixture');
  assert.equal(cookiesBefore[0]?.value,auth);assert.equal(cookiesBefore[0]?.httpOnly,true);
  const fitted=await manager.action(workspaceId,{kind:'fitWidth'});
  assert.equal(fitted.width,1120);assert.equal(fitted.height,720,'Hidden or short overflowing strips should not enlarge the application viewport');
  await manager.action(workspaceId,{kind:'viewport',width:1760,height:720});
  for(let i=0;i<2;i++) {
    const repeated=await manager.action(workspaceId,{kind:'fitWidth'});
    assert.equal(repeated.width,1760,'Fit width is grow-only and idempotent for an already fitting page');
    assert.equal(repeated.height,720);assert.equal(repeated.url,url);
    assert.equal(repeated.tabs.find(tab=>tab.active)?.id,targetId);
  }
  assert.equal(await page.locator('#query').inputValue(),'retained input');
  assert.equal(page.url(),url,'Query parameters and URL fragment are retained exactly');
  assert.equal(traffic.documentRequests,1,'Fitting the viewport never reloads or navigates the document');
  assert.deepEqual((await context.cookies(url)).filter(cookie=>cookie.name==='fit_fixture'),cookiesBefore,'The isolated synthetic HttpOnly cookie is unchanged');
});

test('fit width is bounded for extremely wide tables and retains the expanded live viewport after its warning', {timeout:30_000}, async t=>{
  const {manager,workspaceId,page,url,traffic}=await fixture(t,nestedWide(5000));
  const targetId=(await manager.state(workspaceId)).tabs.find(tab=>tab.active)!.id;
  await assert.rejects(manager.action(workspaceId,{kind:'fitWidth'}),/已扩大视口.*横向滚动/);
  const expanded=await manager.state(workspaceId);
  assert.equal(expanded.width,2560);assert.equal(expanded.height,720);
  assert.equal(expanded.status,'running');assert.equal(expanded.url,url);
  assert.equal(expanded.tabs.find(tab=>tab.active)?.id,targetId);
  const overflow=await page.evaluate('document.querySelector("main").scrollWidth-document.querySelector("main").clientWidth') as number;
  assert(overflow>2000,'The remaining overflow is reported rather than hidden by an oversized photograph');
  await assert.rejects(manager.action(workspaceId,{kind:'fitWidth'}),/已扩大视口.*横向滚动/);
  assert.equal((await manager.state(workspaceId)).width,2560,'Repeated attempts never escape the maximum viewport width');
  assert.equal(traffic.documentRequests,1);
  const frame=(await manager.frame(workspaceId,null,'sharp')).frame;assert(frame);
  assert.equal(frame.width,2560);assert.equal(frame.height,720);
});
