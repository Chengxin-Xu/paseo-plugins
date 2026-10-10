import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { BrowserManager, normalizeNavigationUrl } from '../server/browser-manager';

test('navigation permits websites and rejects local files, code and embedded passwords',()=>{
  assert.equal(normalizeNavigationUrl('example.com'),'https://example.com/');
  assert.equal(normalizeNavigationUrl('http://127.0.0.1:6767/'),'http://127.0.0.1:6767/');
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,hello','https://user:password@example.com','\n']) assert.throws(()=>normalizeNavigationUrl(url));
});

async function mcp(bridge:string, metadata:string){
  const child=spawn(process.execPath,[bridge,metadata],{stdio:['pipe','pipe','pipe']});
  let id=0,stderr='';
  const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let msg:any;try{msg=JSON.parse(line);}catch{return;}
    if(msg.method==='roots/list'&&msg.id!==undefined){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{roots:[]}})+'\n');return;}
    const p=pending.get(msg.id);if(!p)return;
    clearTimeout(p.timer);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);
  });
  child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited: '+stderr));}pending.clear();});
  const request=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(new Error('MCP timeout: '+stderr));},45000);
    pending.set(next,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');
  });
  await request('initialize',{protocolVersion:'2025-03-26',capabilities:{roots:{listChanged:false}},clientInfo:{name:'server-browser-test',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const call=(name:string,args:unknown={})=>request('tools/call',{name,arguments:args});
  const tools=async()=>((await request('tools/list')).tools as {name:string}[]).map(tool=>tool.name);
  const close=async()=>{
    if(child.exitCode!==null)return;
    child.stdin.end();const timer=setTimeout(()=>child.kill('SIGTERM'),3000);await once(child,'exit');clearTimeout(timer);lines.close();
  };
  return {call,tools,close};
}
const text=(result:any)=>(result.content??[]).filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n');

test('real shared browser: frames, MCP writes, manual takeover, tab selection and recovery', {timeout:150000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-visual-browser-test-'));
  const manager=new BrowserManager({dataRoot});
  let client:Awaited<ReturnType<typeof mcp>>|undefined;
  try{
    const initial=await manager.start('test-main');
    assert.equal(initial.status,'running');assert.equal(initial.mode,'manual');
    assert.equal((await stat(manager.metadataPath('test-main'))).mode&0o777,0o600);
    const first=await manager.frame('test-main');
    assert(first.frame?.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert((first.frame?.dataUrl.length??0)<500000,'frame payload remains bounded for plugin transport');
    const unchanged=await manager.frame('test-main',first.frame!.id);
    assert.equal(unchanged.frame,null);
    client=await mcp(manager.bridgePath,manager.metadataPath('test-main'));
    const before=await client.call('browser_snapshot');assert(!before.isError,text(before));
    const find=await client.call('browser_find',{regex:'\\d{6}'});assert(!find.isError,text(find));
    const article=await client.call('browser_read_page',{mode:'visible',query:'Agent',maxChars:1000});
    assert(!article.isError,text(article));assert.match(text(article),/Agent/);
    const diagnose=await client.call('browser_diagnostics');assert(!diagnose.isError,text(diagnose));assert.match(text(diagnose),/accessible/);
    const absent=await client.call('browser_read_page',{tabId:'missing-target',mode:'visible'});assert.equal(absent.isError,true);
    const denied=await client.call('browser_evaluate',{function:"() => { document.body.dataset.agentProof='should-not-run'; return 'wrote'; }"});
    assert.equal(denied.isError,true);assert.match(text(denied),/手动/);
    await manager.action('test-main',{kind:'mode',mode:'agent'});
    await assert.rejects(manager.action('test-main',{kind:'text',text:'should not type'}),/手动/);
    const wrote=await client.call('browser_evaluate',{function:"() => { document.body.dataset.agentProof='mcp-shared'; document.title='Shared MCP proof'; return {proof:document.body.dataset.agentProof,platform:navigator.platform}; }"});
    assert(!wrote.isError,text(wrote));assert.match(text(wrote),/mcp-shared/);assert.match(text(wrote),/Linux/);
    assert.equal((await manager.state('test-main')).title,'Shared MCP proof');
    const metadata=JSON.parse(await readFile(manager.metadataPath('test-main'),'utf8'));
    const control=async(route:string,body:Record<string,unknown>)=>{
      const r=await fetch(metadata.endpoint+'/'+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+metadata.token},body:JSON.stringify({workspaceId:'test-main',owner:'test-owner',pid:process.pid,...body})});
      assert.equal(r.status,200);return r.json() as Promise<any>;
    };
    const lease=await control('acquire',{write:true});
    await manager.action('test-main',{kind:'mode',mode:'manual'});
    assert.equal((await manager.state('test-main')).agentBusy,true);
    await assert.rejects(manager.action('test-main',{kind:'click',x:10,y:10}),/正在结束/);
    await control('release',{leaseId:lease.leaseId});
    assert.equal((await manager.state('test-main')).agentBusy,false);
    await manager.action('test-main',{kind:'newTab'});
    const tabs=(await manager.state('test-main')).tabs;assert.equal(tabs.length,2);
    const listed=await client.call('browser_tabs',{action:'list'});assert(!listed.isError,text(listed));assert.match(text(listed),new RegExp(tabs[0].id));
    await manager.action('test-main',{kind:'tab',tabId:tabs[0].id});
    await manager.action('test-main',{kind:'mode',mode:'agent'});
    const selected=await client.call('browser_evaluate',{function:'() => document.title'});
    assert(!selected.isError,text(selected));assert.match(text(selected),/Shared MCP proof/);
    const stableSelect=await client.call('browser_tabs',{action:'select',tabId:tabs[1].id});assert(!stableSelect.isError,text(stableSelect));
    const stableClose=await client.call('browser_tabs',{action:'close',tabId:tabs[1].id});assert(!stableClose.isError,text(stableClose));
    const missingSelect=await client.call('browser_tabs',{action:'select',tabId:tabs[1].id});assert.equal(missingSelect.isError,true);
    const forbiddenClose=await client.call('browser_close');assert.equal(forbiddenClose.isError,true);
    const listedTools=await client.tools();
    assert(listedTools.includes('browser_evaluate')&&listedTools.includes('browser_read_page'),listedTools.join(','));
    assert(!listedTools.some(name=>/^browser_run_code/.test(name)),'Node.js code execution in the MCP process is not offered');
    const unsafe=await client.call('browser_run_code_unsafe',{code:"async (page) => { await page.evaluate(() => { document.title = 'unsafe ran'; }); }"});
    assert.equal(unsafe.isError,true);assert.match(text(unsafe),/browser_evaluate/);
    assert.notEqual((await manager.state('test-main')).title,'unsafe ran');
    await manager.action('test-main',{kind:'mode',mode:'manual'});
    await manager.action('test-main',{kind:'viewport',width:390,height:760});
    const phone=await manager.frame('test-main');assert.equal(phone.frame?.width,390);assert.equal(phone.frame?.height,760);
    await manager.action('test-main',{kind:'viewport',width:1920,height:1080});
    const desktop=await manager.frame('test-main',null,'sharp');assert.equal(desktop.frame?.width,1920);assert.equal(desktop.frame?.height,1080);
    await manager.action('test-main',{kind:'stop'});assert.equal((await manager.state('test-main')).status,'idle');
    await manager.start('test-main');
    assert.equal((await manager.state('test-main')).width,1920,'Matched desktop viewport survives a normal browser restart');
    await manager.action('test-main',{kind:'mode',mode:'agent'});
    const recovered=await client.call('browser_snapshot');assert(!recovered.isError,text(recovered));
    assert.equal((await manager.state('test-main')).status,'running');
  }finally{
    await client?.close();await manager.close();await rm(dataRoot,{recursive:true,force:true});
  }
});

test('MCP form login retains HttpOnly authentication after browser restart and isolates another workspace', {timeout:120000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-login-test-'));
  const manager=new BrowserManager({dataRoot});
  const sessionToken=randomBytes(24).toString('hex');
  let logins=0,protectedReads=0,unauthenticatedReads=0;
  const server=createServer(async(request,response)=>{
    if(request.method==='POST'&&request.url==='/login'){
      let body='';for await(const chunk of request)body+=chunk;
      const fields=new URLSearchParams(body);
      if(fields.get('username')!=='browser-test-user'||fields.get('password')!=='temporary-test-password'){
        response.writeHead(401);response.end('Incorrect test credentials');return;
      }
      logins++;
      response.writeHead(303,{'Set-Cookie':`test_auth=${sessionToken}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`,Location:'/private'});response.end();return;
    }
    if(request.url==='/private'){
      if(!(request.headers.cookie??'').split(';').some(cookie=>cookie.trim()===`test_auth=${sessionToken}`)){
        unauthenticatedReads++;response.writeHead(302,{Location:'/login'});response.end();return;
      }
      protectedReads++;response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      response.end('<!doctype html><title>Authenticated dashboard</title><h1>Protected page</h1><p>Signed in as browser-test-user</p>');return;
    }
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    response.end('<!doctype html><title>Login required</title><h1>Test login</h1><form method="post" action="/login"><label>Username <input id="username" name="username" autocomplete="off"></label><label>Password <input id="password" name="password" type="password" autocomplete="off"></label><button type="submit">Sign in</button></form>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/private`;
  let client:Awaited<ReturnType<typeof mcp>>|undefined;
  const checked=async(name:string,args:unknown={})=>{
    const result=await client!.call(name,args);assert(!result.isError,text(result));return result;
  };
  try{
    await manager.start('login-test');await manager.action('login-test',{kind:'mode',mode:'agent'});
    client=await mcp(manager.bridgePath,manager.metadataPath('login-test'));
    await checked('browser_navigate',{url});assert.match((await manager.state('login-test')).url,/\/login$/);
    await checked('browser_type',{target:'#username',text:'browser-test-user'});
    await checked('browser_type',{target:'#password',text:'temporary-test-password'});
    await checked('browser_click',{target:'button[type="submit"]'});
    assert.match(text(await checked('browser_snapshot')),/Signed in as browser-test-user/);
    assert.equal(logins,1);
    const hiddenCookie=await checked('browser_evaluate',{function:"() => ({authCookieHiddenFromJavascript: !document.cookie.includes('test_auth=')})"});
    assert.match(text(hiddenCookie),/true/);
    await client.close();client=undefined;
    await manager.action('login-test',{kind:'mode',mode:'manual'});await manager.action('login-test',{kind:'stop'});
    await manager.start('login-test');await manager.action('login-test',{kind:'mode',mode:'agent'});
    client=await mcp(manager.bridgePath,manager.metadataPath('login-test'));
    await checked('browser_navigate',{url});
    assert.match(text(await checked('browser_snapshot')),/Signed in as browser-test-user/);
    assert.equal(logins,1,'Browser reused the persistent authenticated cookie without a second login');
    await client.close();client=undefined;
    await manager.start('separate-workspace');await manager.action('separate-workspace',{kind:'mode',mode:'agent'});
    client=await mcp(manager.bridgePath,manager.metadataPath('separate-workspace'));
    await checked('browser_navigate',{url});
    assert.match((await manager.state('separate-workspace')).url,/\/login$/);
    assert.equal(protectedReads,3,'v0.2 restores the saved page once, then the explicit navigation reads it again');assert.equal(unauthenticatedReads,2);
    await mkdir('artifacts',{recursive:true});
    await writeFile('artifacts/login-verification.json',JSON.stringify({passed:true,verifiedAt:new Date().toISOString(),kind:'Controlled local HTTP login fixture; synthetic credentials only',browserTools:'Actual server_browser MCP bridge with no Desktop host or viewer client',checks:{formLogin:true,authenticatedPageRead:true,httpOnlyCookie:true,browserRestartRetainsLogin:true,secondWorkspaceRequiresOwnLogin:true},successfulLogins:logins,authenticatedPageReads:protectedReads,realExternalAccountsTested:false},null,2)+'\n');
  }finally{
    await client?.close();await manager.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dataRoot,{recursive:true,force:true});
  }
});
