import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { BrowserManager } from '../server/browser-manager';
import { assertManualTarget, needsManualTarget } from '../server/manual-target';
import type { BrowserAction, BrowserTarget } from '../shared/browser';

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function fixture(t:TestContext,now?:()=>number){
 const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-input-test-')),manager=new BrowserManager({dataRoot,now});let browser:Browser|undefined;
 t.after(async()=>{await browser?.close().catch(()=>{});await manager.close();await rm(dataRoot,{recursive:true,force:true});});
 await manager.start('workspace');const metadata=JSON.parse(await readFile(manager.metadataPath('workspace'),'utf8'));browser=await chromium.connectOverCDP(metadata.cdpEndpoint);
 const target=async():Promise<BrowserTarget>=>{const state=await manager.state('workspace');return {tabId:state.activeTabId!,viewRevision:state.viewRevision!};};
 const act=async(action:BrowserAction)=>manager.action('workspace',action,needsManualTarget(action)?await target():undefined);
 return {manager,browser,target,act,metadata};
}

test('all page mutations require an exact displayed target; management and explicit dialogs stay available',()=>{
 for(const kind of ['click','text','key','scroll','navigate','back','forward','reload','demo','newTab','tab','closeTab','pin','viewport','fitWidth','devicePreset'])assert.equal(needsManualTarget({kind} as BrowserAction),true,kind);
 for(const kind of ['mode','stop','restart','settings','cleanup','handleDialog'])assert.equal(needsManualTarget({kind} as BrowserAction),false,kind);
 const current={activeId:'tab-a',viewRevision:'version-a'};
 for(const target of [undefined,{tabId:'tab-b',viewRevision:'version-a'},{tabId:'tab-a',viewRevision:'version-b'}])assert.throws(()=>assertManualTarget(target,current),/画面已经变化/);
 assert.doesNotThrow(()=>assertManualTarget({tabId:'tab-a',viewRevision:'version-a'},current));
});

test('real browser refuses another viewer’s stale tab, navigation and queued input without touching the new page',{timeout:60000},async t=>{
 const {manager,browser,act,target}=await fixture(t),original=await target(),first=browser.contexts()[0].pages()[0];
 await first.setContent('<input id="entry"><button onclick="window.hit=true">提交</button>');
 await assert.rejects(manager.action('workspace',{kind:'text',text:'no target'}),/画面已经变化/);
 await act({kind:'newTab'});const second=browser.contexts()[0].pages().at(-1)!;await second.setContent('<input id="entry" autofocus><button onclick="window.hit=true">提交</button>');
 for(const action of [{kind:'click',x:10,y:10},{kind:'text',text:'secret'},{kind:'key',key:'Enter'},{kind:'scroll',deltaX:0,deltaY:200},{kind:'navigate',url:'https://example.invalid/'}] as BrowserAction[])await assert.rejects(manager.action('workspace',action,original),/画面已经变化/);
 assert.equal(await second.locator('input').inputValue(),'');assert.equal(await second.evaluate('window.hit'),undefined);
 const before=await target();const switching=manager.action('workspace',{kind:'tab',tabId:original.tabId},before);const queued=manager.action('workspace',{kind:'text',text:'queued secret'},before);
 await switching;await assert.rejects(queued,/画面已经变化/);assert.equal(await first.locator('input').inputValue(),'');
 const navigationTarget=await target();await first.goto('about:blank#changed');await assert.rejects(manager.action('workspace',{kind:'key',key:'Enter'},navigationTarget),/画面已经变化/);
});

test('a frame captured across a tab switch is discarded and cannot share the new session identity',{timeout:60000},async t=>{
 const {manager,act,target}=await fixture(t),first=await target();await act({kind:'newTab'});const second=await target();await act({kind:'tab',tabId:first.tabId});
 const live=(manager as any).sessions.get('workspace'),context=live.context,original=context.newCDPSession.bind(context);let release:()=>void=()=>{},captured:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{captured=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 context.newCDPSession=async(page:any)=>{const cdp=await original(page),send=cdp.send.bind(cdp);cdp.send=async(method:string,params?:unknown)=>{const result=await send(method,params);if(method==='Page.captureScreenshot'){captured();await hold;}return result;};return cdp;};
 const frame=manager.frame('workspace',null,'sharp');await started;await act({kind:'tab',tabId:second.tabId});release();const result=await frame;
 context.newCDPSession=original;assert.equal(result.frame,null);assert.equal(result.session?.activeTabId,second.tabId);
});

test('viewers are counted once per client, expire without polling, and stop clears all presence',{timeout:60000},async t=>{
 let now=1000;const {manager,act}=await fixture(t,()=>now);
 await manager.frame('workspace',null,'smooth',{viewerId:'phone'});await manager.frame('workspace',null,'smooth',{viewerId:'desktop'});await manager.frame('workspace',null,'smooth',{viewerId:'phone'});
 assert.equal((await manager.state('workspace')).viewerCount,2);now+=16000;assert.equal((await manager.state('workspace')).viewerCount,0);
 await manager.frame('workspace',null,'smooth',{viewerId:'phone'});await act({kind:'stop'});assert.equal((await manager.state('workspace')).viewerCount,0);
});

test('confirm and prompt wait for explicit responses; dialogs bypass a suspended click and survive mode changes',{timeout:60000},async t=>{
 const {manager,browser,act,metadata}=await fixture(t),page=browser.contexts()[0].pages()[0];page.on('dialog',()=>{});
 await page.setContent('<button style="width:200px;height:100px" onclick="window.answer=confirm(\'确认提交？\')">确认</button>');
 const clicked=await act({kind:'click',x:80,y:50});assert.equal(clicked.dialog?.type,'confirm');assert.equal(clicked.dialog?.message,'确认提交？');
 assert.equal((await manager.frame('workspace')).frame,null,'dialog snapshots return promptly with no attempted screenshot');
 await act({kind:'mode',mode:'agent'});await assert.rejects(act({kind:'handleDialog',dialogId:clicked.dialog!.id,accept:true}),/手动接管/);
 const response=await fetch(metadata.endpoint+'/dialog',{method:'POST',headers:{authorization:'Bearer '+metadata.token,'content-type':'application/json'},body:JSON.stringify({workspaceId:'workspace',owner:'dialog-agent',pid:process.pid,accept:true})});assert.equal(response.status,200);await response.json();
 await delay(100);assert.equal(await page.evaluate('window.answer'),true);assert.equal((await manager.state('workspace')).activity?.find(item=>item.action==='处理网页对话框')?.source,'agent');
 await act({kind:'mode',mode:'manual'});await page.setContent('<button style="width:200px;height:100px" onclick="window.answer=prompt(\'输入备注\',\'默认\')">输入</button>');
 const prompting=await act({kind:'click',x:80,y:50});assert.equal(prompting.dialog?.defaultValue,'默认');await act({kind:'handleDialog',dialogId:prompting.dialog!.id,accept:true,promptText:'收到'});await delay(100);assert.equal(await page.evaluate('window.answer'),'收到');
 await assert.rejects(act({kind:'handleDialog',dialogId:prompting.dialog!.id,accept:false}),/已经变化/);
});

test('dialogs from two tabs remain answerable in arrival order',{timeout:60000},async t=>{
 const {manager,browser,act}=await fixture(t),first=browser.contexts()[0].pages()[0];first.on('dialog',()=>{});await act({kind:'newTab'});const second=browser.contexts()[0].pages().at(-1)!;second.on('dialog',()=>{});
 const a=first.evaluate('window.answer=confirm("first")');await delay(100);const b=second.evaluate('window.answer=prompt("second","default")');await delay(100);
 const initial=await manager.state('workspace');assert.equal(initial.dialog?.message,'first');await act({kind:'handleDialog',dialogId:initial.dialog!.id,accept:false});await a;
 const next=await manager.state('workspace');assert.equal(next.dialog?.message,'second');await act({kind:'handleDialog',dialogId:next.dialog!.id,accept:true,promptText:'second answer'});await b;
 assert.equal(await first.evaluate('window.answer'),false);assert.equal(await second.evaluate('window.answer'),'second answer');assert.equal((await manager.state('workspace')).dialog,null);
});

test('an immediately opened popup dialog is retained before target tracking completes',{timeout:60000},async t=>{
 const {manager,browser,act}=await fixture(t),context=browser.contexts()[0],page=context.pages()[0];
 // This second CDP connection must not auto-dismiss an immediate dialog before its page event arrives.
 context.on('dialog',()=>{});
 // CDP page ordering is not creation order: the demo page may be last and its #answer is a DOM node.
 const popupOpened=page.waitForEvent('popup');
 const opened=page.evaluate("window.open('about:blank').document.write('<script>window.answer=confirm(\"弹出页面确认\")<\\/script>')");
 // Timed rather than counted: under a loaded host the popup's target can take seconds to attach.
 let state=await manager.state('workspace');for(const until=Date.now()+15_000;!state.dialog&&Date.now()<until;){await delay(50);state=await manager.state('workspace');}
 assert.equal(state.dialog?.message,'弹出页面确认');await act({kind:'handleDialog',dialogId:state.dialog!.id,accept:true});
 await opened;const popup=await popupOpened;assert.equal(await popup.evaluate('window.answer'),true);
});
