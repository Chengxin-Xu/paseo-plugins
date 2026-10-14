import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { TestBrowserManager } from './manual-action';

const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
test('real MCP browser_handle_dialog answers the manager-held confirm/prompt and obeys manual takeover',{timeout:60000},async t=>{
 const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-dialog-bridge-')),manager=new TestBrowserManager({dataRoot});t.after(async()=>{await manager.close();await rm(dataRoot,{recursive:true,force:true});});
 await manager.start('dialogs');await manager.action('dialogs',{kind:'mode',mode:'agent'});const metadata=JSON.parse(await readFile(manager.metadataPath('dialogs'),'utf8'));
 const browser=await chromium.connectOverCDP(metadata.cdpEndpoint);t.after(()=>browser.close());const page=browser.contexts()[0].pages()[0];page.on('dialog',()=>{});
 const child=spawn(process.execPath,[manager.bridgePath,manager.metadataPath('dialogs')],{stdio:['pipe','pipe','pipe']});let stderr='',sequence=0;child.stderr.on('data',chunk=>{stderr+=chunk;});
 const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>(),lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const message=JSON.parse(line),request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);});
 t.after(async()=>{lines.close();for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('test ended'));}child.kill('SIGTERM');await delay(50);if(child.exitCode===null)child.kill('SIGKILL');});
 const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout: '+stderr));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=(name:string,args:unknown={})=>request('tools/call',{name,arguments:args});
 await request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'dialog-test',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const catalog=await request('tools/list',{});assert(catalog.tools.some((tool:any)=>tool.name==='browser_handle_dialog'));await call('browser_snapshot');
 const confirm=page.evaluate('window.answer=confirm("确认操作")');await delay(150);const initial=await manager.state('dialogs');assert.equal(initial.dialog?.type,'confirm');
 const accepted=await call('browser_handle_dialog',{accept:true,dialogId:initial.dialog!.id});assert.notEqual(accepted.isError,true,JSON.stringify(accepted));await confirm;assert.equal(await page.evaluate('window.answer'),true);
 const prompt=page.evaluate('window.answer=prompt("备注","默认")');await delay(100);await manager.action('dialogs',{kind:'mode',mode:'manual'});
 const refused=await call('browser_handle_dialog',{accept:true,promptText:'must not apply'});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused),/手动接管/);assert.equal((await manager.state('dialogs')).dialog?.type,'prompt');
 await manager.action('dialogs',{kind:'mode',mode:'agent'});const answered=await call('browser_handle_dialog',{accept:true,promptText:'Agent 回复'});assert.notEqual(answered.isError,true,JSON.stringify(answered));await prompt;assert.equal(await page.evaluate('window.answer'),'Agent 回复');assert.equal((await manager.state('dialogs')).dialog,null);
});
