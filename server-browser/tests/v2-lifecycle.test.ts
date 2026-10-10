import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BrowserManager } from '../server/browser-manager';
import { defaultRuntimeRoot } from '../server/runtime';
import { maintainArtifacts } from '../server/artifacts';
import type { BrowserSession, BrowserSettings } from '../shared/browser';

// These tests use dedicated temporary profiles and a synthetic loopback website.
// No Paseo daemon, installed plugin, real account, or existing browser is touched.
const runtimeRoot = defaultRuntimeRoot();
const pause = (ms:number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Metadata = { endpoint:string; token:string; cdpEndpoint:string; browserPid:number; epoch:number; artifactDir:string };

async function metadata(manager:BrowserManager, workspaceId:string):Promise<Metadata> {
  return JSON.parse(await readFile(manager.metadataPath(workspaceId), 'utf8')) as Metadata;
}

async function stateWhen(manager:BrowserManager, workspaceId:string, predicate:(state:BrowserSession)=>boolean, timeout=20_000):Promise<BrowserSession> {
  const deadline=Date.now()+timeout;
  let last:BrowserSession|undefined;
  let lastError='';
  while(Date.now()<deadline) {
    try { last=await manager.state(workspaceId); if(predicate(last))return last; }
    catch(error) { lastError=String(error); }
    await pause(75);
  }
  assert.fail(`Browser state timed out: ${JSON.stringify({status:last?.status, url:last?.url, runtime:last?.runtime, error:last?.error, lastError})}`);
}

async function connect(manager:BrowserManager, workspaceId:string):Promise<Browser> {
  return chromium.connectOverCDP((await metadata(manager, workspaceId)).cdpEndpoint);
}

function pageAt(browser:Browser, url:string):Page {
  const page=browser.contexts()[0].pages().find(candidate=>candidate.url()===url);
  assert(page, `Expected a live page at ${url}`);
  return page;
}

async function killOwnBrowser(manager:BrowserManager, workspaceId:string):Promise<Metadata> {
  const value=await metadata(manager, workspaceId);
  assert(Number.isSafeInteger(value.browserPid) && value.browserPid>1 && value.browserPid!==process.pid);
  // Never signal a PID solely because it was recorded in a file. Check its live
  // command line against this exact, newly created test profile first.
  const profile=path.join(manager.dataRoot, workspaceId, 'profile');
  // Chromium may rewrite argv as one process-title string. Our mkdtemp path has
  // no spaces, so either NUL or space boundaries can be checked unambiguously.
  const commandLine=await readFile(`/proc/${value.browserPid}/cmdline`, 'utf8');
  const profileArguments=[...commandLine.matchAll(/(?:^|[\0 ])--user-data-dir=([^\0 ]+)/g)];
  assert.equal(profileArguments.length,1,'Refuse to signal a process without one explicit Chromium profile');
  const actualProfile=profileArguments[0][1];
  assert.equal(await realpath(actualProfile),await realpath(profile),'Refuse to signal a browser outside this isolated test profile');
  assert(['chrome','chrome-headless-shell'].includes(path.basename(await realpath(`/proc/${value.browserPid}/exe`))), 'Refuse to signal an unexpected executable');
  process.kill(value.browserPid, 'SIGKILL');
  return value;
}

async function control(manager:BrowserManager, workspaceId:string, route:string, extra:Record<string,unknown>={}) {
  const value=await metadata(manager, workspaceId);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),5_000);
  try {
    const response=await fetch(`${value.endpoint}/${route}`, {
      method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${value.token}`},
      body:JSON.stringify({workspaceId, owner:'v2-isolated-test', pid:process.pid, ...extra}),
      signal:controller.signal,
    });
    return {status:response.status, body:await response.json() as Record<string,any>};
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const token=randomBytes(24).toString('hex');
  const counts={logins:0, commits:0, authenticatedReads:0};
  const article=Array.from({length:15},(_,index)=>`<p>Field report ${index+1}. This carefully measured field study describes how river birds adapt their nesting habits to changing water levels. Researchers observed the same wetland throughout the season, recorded each visit, and compared the birds' choices with changes in rainfall and vegetation. The documented observations provide the evidence for the conclusion.</p>`).join('');
  const server=createServer(async(request,response)=>{
    const pathname=new URL(request.url??'/', 'http://fixture.invalid').pathname;
    if(pathname==='/network-error') { request.socket.destroy(); return; }
    response.setHeader('cache-control','no-store');
    if(request.method==='POST' && pathname==='/login') {
      let body=''; for await(const part of request)body+=part;
      const input=new URLSearchParams(body);
      if(input.get('username')!=='synthetic-user' || input.get('password')!=='synthetic-password') {
        response.writeHead(401); response.end('Invalid synthetic credentials'); return;
      }
      counts.logins++;
      response.writeHead(303, {'set-cookie':`v2_fixture_auth=${token}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`, location:'/private'});
      response.end(); return;
    }
    if(request.method==='POST' && pathname==='/commit') {
      counts.commits++;
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({receipt:counts.commits})); return;
    }
    response.setHeader('content-type','text/html; charset=utf-8');
    if(pathname==='/private') {
      if(!(request.headers.cookie??'').split(';').some(value=>value.trim()===`v2_fixture_auth=${token}`)) {
        response.writeHead(302,{location:'/login'}); response.end(); return;
      }
      counts.authenticatedReads++;
      response.end(`<!doctype html><title>Authenticated fixture</title><h1>Signed in as synthetic-user</h1><button id="commit">Commit once</button><output id="receipt">No submission</output><script>document.querySelector('#commit').addEventListener('click',async()=>{const r=await fetch('/commit',{method:'POST'});document.querySelector('#receipt').textContent='Receipt '+(await r.json()).receipt;});</script>`);
      return;
    }
    if(pathname==='/login') {
      response.end('<!doctype html><title>Sign in</title><h1>Sign in to the test site</h1><form method="post" action="/login"><label>Username <input name="username" autocomplete="off"></label><label>Password <input name="password" type="password" autocomplete="off"></label><button type="submit">Sign in</button></form>');
      return;
    }
    if(pathname==='/article') {
      response.end(`<!doctype html><html><head><title>Wetland field report</title></head><body><nav>NOISY_NAVIGATION_TOKEN <a href="/unrelated">Account menu</a></nav><main><article><h1>Wetland field report</h1><p>The evidence is described in <a href="./sources/evidence?version=2#results">source observations</a>.</p>${article}<p>Distinctive finding: the birds rebuilt nests above the early summer flood line.</p></article></main><footer>NOISY_FOOTER_TOKEN</footer></body></html>`);
      return;
    }
    response.end('<!doctype html><title>Accessible fixture notes</title><main><h1>Public notes</h1><p>The test website is accessible.</p><button id="other">Other tab</button><output>untouched</output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="changed";</script></main>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert(address && typeof address!=='string');
  return {
    origin:`http://127.0.0.1:${address.port}`, counts,
    close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));},
  };
}

test('v2 restores saved login, pages and settings after a crash without repeating a submitted action', {timeout:90_000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-v2-recovery-'));
  const site=await fixture();
  const workspaceId='recovery-test';
  let manager=new BrowserManager({dataRoot,runtimeRoot});
  let client:Browser|undefined;
  try {
    await manager.start(workspaceId);
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/private`});
    client=await connect(manager,workspaceId);
    const login=pageAt(client,`${site.origin}/login`);
    await login.getByLabel('Username').fill('synthetic-user');
    await login.getByLabel('Password').fill('synthetic-password');
    await login.getByRole('button',{name:'Sign in'}).click();
    await login.waitForURL(`${site.origin}/private`);
    assert.equal(site.counts.logins,1);

    // Persist the newly created Chromium cookie normally before testing an
    // abrupt process crash; an unflushed brand-new cookie is not guaranteed.
    await client.close(); client=undefined;
    await manager.action(workspaceId,{kind:'restart'});
    const authenticated=await stateWhen(manager,workspaceId,state=>state.url===`${site.origin}/private`);
    assert.equal(authenticated.title,'Authenticated fixture');
    assert.equal(site.counts.logins,1);
    const protectedId=authenticated.tabs.find(tab=>tab.active)!.id;
    await manager.action(workspaceId,{kind:'pin',tabId:protectedId,pinned:true});
    await manager.action(workspaceId,{kind:'settings',settings:{autoRecover:true,maxTabs:4,artifactMaxAgeHours:2}});
    await manager.action(workspaceId,{kind:'viewport',width:390,height:760});
    await manager.action(workspaceId,{kind:'newTab'});
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/notes`});
    await manager.action(workspaceId,{kind:'tab',tabId:protectedId});
    await manager.action(workspaceId,{kind:'mode',mode:'agent'});
    client=await connect(manager,workspaceId);
    const protectedPage=pageAt(client,`${site.origin}/private`);
    await protectedPage.getByRole('button',{name:'Commit once'}).click();
    await protectedPage.getByText('Receipt 1',{exact:true}).waitFor();
    assert.equal(site.counts.commits,1);
    const before=await killOwnBrowser(manager,workspaceId);
    const recovered=await stateWhen(manager,workspaceId,state=>state.status==='running' && (state.runtime?.recoveryCount??0)>=1);
    assert.equal(recovered.url,`${site.origin}/private`);
    assert.equal(recovered.title,'Authenticated fixture');
    assert.equal(recovered.mode,'agent');
    assert.equal(recovered.width,390);
    assert.equal(recovered.height,760);
    assert.equal(recovered.settings?.maxTabs,4);
    assert.equal(recovered.settings?.artifactMaxAgeHours,2);
    assert.equal(recovered.tabs.length,2);
    assert(recovered.tabs.some(tab=>tab.url===`${site.origin}/private` && tab.pinned));
    assert(recovered.tabs.some(tab=>tab.url===`${site.origin}/notes`));
    assert.notEqual((await metadata(manager,workspaceId)).browserPid,before.browserPid);
    assert.notEqual((await metadata(manager,workspaceId)).epoch,before.epoch);
    assert.equal(site.counts.logins,1,'A saved authenticated cookie is reused without another login');
    assert.equal(site.counts.commits,1,'Crash recovery never replays the prior POST or button click');
    await client.close().catch(()=>{}); client=undefined;

    await manager.close();
    manager=new BrowserManager({dataRoot,runtimeRoot});
    await manager.restore([workspaceId]);
    const reloaded=await stateWhen(manager,workspaceId,state=>state.status==='running');
    assert.equal(reloaded.mode,'agent');
    assert.equal(reloaded.settings?.maxTabs,4);
    assert.equal(reloaded.tabs.length,2);
    assert.equal(reloaded.url,`${site.origin}/private`);
    assert.equal(site.counts.commits,1);

    await manager.action(workspaceId,{kind:'mode',mode:'manual'});
    await killOwnBrowser(manager,workspaceId);
    await stateWhen(manager,workspaceId,state=>state.status==='recovering');
    await manager.action(workspaceId,{kind:'stop'});
    await pause(3_500);
    assert.equal((await manager.state(workspaceId)).status,'idle','An explicit stop cancels a pending automatic recovery');
    await manager.close();
    manager=new BrowserManager({dataRoot,runtimeRoot});
    await manager.restore([workspaceId]);
    assert.equal((await manager.state(workspaceId)).status,'idle','An explicit stop survives plugin restoration');
    await assert.rejects(access(manager.metadataPath(workspaceId)));
  } finally {
    await client?.close().catch(()=>{});
    await manager.close(); await site.close(); await rm(dataRoot,{recursive:true,force:true});
  }
});

test('v2 recovery backs off and stops after its bounded retry budget', {timeout:60_000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-v2-budget-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot});
  const workspaceId='budget-test';
  try {
    await manager.start(workspaceId);
    await manager.action(workspaceId,{kind:'settings',settings:{autoRecover:true}});
    const delays:number[]=[];
    for(let attempt=1;attempt<=3;attempt++) {
      const started=Date.now();
      await killOwnBrowser(manager,workspaceId);
      const recovered=await stateWhen(manager,workspaceId,state=>state.status==='running' && state.runtime?.recoveryCount===attempt,20_000);
      assert.equal(recovered.runtime?.recoveryCount,attempt);
      delays.push(Date.now()-started);
    }
    assert(delays[0]>=500,'The first recovery is delayed instead of spinning immediately');
    assert(delays[2]>=5_000,'Repeated exits receive a materially longer backoff');
    await killOwnBrowser(manager,workspaceId);
    await stateWhen(manager,workspaceId,state=>state.status==='error');
    await pause(9_000);
    const exhausted=await manager.state(workspaceId);
    assert.equal(exhausted.status,'error','An exhausted recovery budget leaves a visible error');
    assert.equal(exhausted.runtime?.recoveryCount,3,'No unbounded background restart loop');
  } finally {
    await manager.close(); await rm(dataRoot,{recursive:true,force:true});
  }
});

test('v2 tab limits preserve pinned pages and stale tab targets never fall through to another page', {timeout:40_000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-v2-targets-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot});
  const site=await fixture();
  const workspaceId='targets-test';
  let client:Browser|undefined;
  try {
    await manager.start(workspaceId);
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/notes`});
    const pinnedId=(await manager.state(workspaceId)).tabs[0].id;
    await manager.action(workspaceId,{kind:'pin',tabId:pinnedId,pinned:true});
    await manager.action(workspaceId,{kind:'settings',settings:{maxTabs:2}});
    await manager.action(workspaceId,{kind:'newTab'});
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/other`});
    const full=await manager.state(workspaceId);
    const targetId=full.tabs.find(tab=>tab.active)!.id;
    await assert.rejects(manager.action(workspaceId,{kind:'newTab'}),/标签|上限|tab/i);
    assert.deepEqual((await manager.state(workspaceId)).tabs.map(tab=>tab.id),full.tabs.map(tab=>tab.id));
    assert((await manager.state(workspaceId)).tabs.find(tab=>tab.id===pinnedId)?.pinned);
    await assert.rejects(manager.action(workspaceId,{kind:'closeTab',tabId:pinnedId}),/固定|pin/i);

    const lease=await control(manager,workspaceId,'acquire',{write:false,tabId:targetId});
    assert.equal(lease.status,200);
    assert.equal(lease.body.activeTargetId,targetId);
    client=await connect(manager,workspaceId);
    await pageAt(client,`${site.origin}/other`).close();
    await stateWhen(manager,workspaceId,state=>!state.tabs.some(tab=>tab.id===targetId));
    const staleLease=await control(manager,workspaceId,'validate',{leaseId:lease.body.leaseId});
    assert.equal(staleLease.status,409,'A target closed during a lease invalidates that lease');
    await control(manager,workspaceId,'release',{leaseId:lease.body.leaseId});
    const staleAcquire=await control(manager,workspaceId,'acquire',{write:false,tabId:targetId});
    assert.equal(staleAcquire.status,409,'A stale target must fail before any operation reaches the other page');
    await assert.rejects(manager.action(workspaceId,{kind:'tab',tabId:targetId}),/关闭|不存在/);
    await assert.rejects(manager.read(workspaceId,{tabId:targetId,mode:'visible',maxChars:500}),/关闭|不存在/);
    assert.equal(await pageAt(client,`${site.origin}/notes`).locator('output').textContent(),'untouched');
    const final=await manager.state(workspaceId);
    assert.equal(final.tabs.length,1);
    assert.equal(final.tabs[0].id,pinnedId);
    assert.equal(final.tabs[0].pinned,true);
  } finally {
    await client?.close().catch(()=>{});
    await manager.close(); await site.close(); await rm(dataRoot,{recursive:true,force:true});
  }
});

test('v2 artifact retention deletes only owned regular files and never traverses profile, downloads or symlinks', async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-v2-artifacts-'));
  const artifacts=path.join(dataRoot,'workspace','artifacts');
  const profile=path.join(dataRoot,'workspace','profile');
  const downloads=path.join(artifacts,'downloads');
  const now=Date.now();
  const old=new Date(now-72*3600_000);
  const settings:BrowserSettings={autoRecover:true,maxTabs:8,maxArtifactMB:16,artifactMaxAgeHours:1};
  const ownedOld=path.join(artifacts,'screenshot-2026-09-16T12-00-00-000Z.png');
  const ownedRecent=path.join(artifacts,'page-2026-09-19T12-00-00-000Z.png');
  const foreign=path.join(artifacts,'important-report.txt');
  const profileFile=path.join(profile,'Cookies');
  const outside=path.join(dataRoot,'outside-keep.txt');
  const symlinkFile=path.join(artifacts,'snapshot-2026-09-16T12-00-01-000Z.txt');
  const nested=path.join(downloads,'screenshot-2026-09-16T12-00-02-000Z.png');
  try {
    await mkdir(artifacts,{recursive:true}); await mkdir(profile); await mkdir(downloads);
    for(const [file,content] of [[ownedOld,'old screenshot'],[ownedRecent,'new screenshot'],[foreign,'user document'],[profileFile,'synthetic profile sentinel'],[outside,'outside sentinel'],[nested,'nested download']]) {
      await writeFile(file,content); await utimes(file,old,old);
    }
    await utimes(ownedRecent,new Date(now),new Date(now));
    await symlink(outside,symlinkFile);
    const result=await maintainArtifacts(artifacts,settings,true,now);
    assert.equal(result.cleaned,1);
    assert.equal(result.count,1);
    assert.equal(result.bytes,Buffer.byteLength('new screenshot'));
    await assert.rejects(access(ownedOld));
    assert.equal(await readFile(ownedRecent,'utf8'),'new screenshot');
    assert.equal(await readFile(profileFile,'utf8'),'synthetic profile sentinel');
    assert.equal(await readFile(foreign,'utf8'),'user document');
    assert.equal(await readFile(outside,'utf8'),'outside sentinel');
    assert.equal(await readFile(nested,'utf8'),'nested download');
    assert((await lstat(symlinkFile)).isSymbolicLink());
    const linkedRoot=path.join(dataRoot,'linked-artifacts');
    await symlink(profile,linkedRoot);
    assert.deepEqual(await maintainArtifacts(linkedRoot,settings,true,now),{bytes:0,count:0,cleaned:0});
    assert.equal(await readFile(profileFile,'utf8'),'synthetic profile sentinel');
  } finally { await rm(dataRoot,{recursive:true,force:true}); }
});

test('v2 diagnostics distinguish suspected login and network failure while article reading trims navigation and resolves links', {timeout:50_000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-v2-reading-'));
  const manager=new BrowserManager({dataRoot,runtimeRoot});
  const site=await fixture();
  const workspaceId='reading-test';
  try {
    await manager.start(workspaceId);
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/login`});
    const login=await manager.diagnostics(workspaceId);
    assert.equal(login.health.state,'login_required');
    assert.match(login.health.summary,/疑似|可能/);
    await manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/article`});
    const healthy=await manager.diagnostics(workspaceId);
    assert.equal(healthy.health.state,'accessible');
    assert.equal(healthy.health.httpStatus,200);
    const before=await manager.state(workspaceId);
    const article=await manager.read(workspaceId,{mode:'article',maxChars:12_000});
    assert.equal(article.method,'readability');
    assert.equal(article.format,'markdown');
    assert.match(article.content,/Wetland field report|Field report 1/);
    assert(!article.content.includes('NOISY_NAVIGATION_TOKEN'));
    assert(!article.content.includes('NOISY_FOOTER_TOKEN'));
    assert(article.content.includes(`${site.origin}/sources/evidence?version=2#results`));
    assert.equal(article.url,`${site.origin}/article`);
    assert.equal(article.tabId,before.tabs.find(tab=>tab.active)!.id);
    const limited=await manager.read(workspaceId,{mode:'article',maxChars:500});
    assert.equal(limited.truncated,true);
    assert(limited.content.length<=500);
    assert(limited.characters>limited.content.length);
    const selected=await manager.read(workspaceId,{mode:'visible',selector:'article',query:'Distinctive finding',maxChars:1_000});
    assert.match(selected.content,/Distinctive finding/);
    assert(!selected.content.includes('NOISY_NAVIGATION_TOKEN'));
    assert.equal((await manager.state(workspaceId)).url,before.url,'Reading never navigates or changes the active page');
    await assert.rejects(manager.action(workspaceId,{kind:'navigate',url:`${site.origin}/network-error`}));
    const unavailable=await manager.diagnostics(workspaceId);
    assert.equal(unavailable.health.state,'network_error');
    assert.notEqual(unavailable.health.state,'login_required');
  } finally {
    await manager.close(); await site.close(); await rm(dataRoot,{recursive:true,force:true});
  }
});
