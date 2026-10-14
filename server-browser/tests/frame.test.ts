import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { TestBrowserManager as BrowserManager } from './manual-action';
import { captureBrowserFrame, jpegSize } from '../server/frame';
import type { BrowserContext, BrowserPage } from '../server/browser-types';

/** Smallest buffer jpegSize accepts: SOI + SOF0 header. */
function jpegHeader(width:number,height:number):string{
  const bytes=Buffer.alloc(40);bytes.set([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,height>>8,height&255,width>>8,width&255]);return bytes.toString('base64');
}
type View={width:number;height:number;x:number;y:number;zoom:number};
function fakeContext(views:View[],shot:{width:number;height:number}){
  const calls:{method:string;params?:Record<string,unknown>}[]=[];let detached=0;
  const cdp={
    send:async(method:string,params?:Record<string,unknown>)=>{
      calls.push({method,params});
      if(method==='Runtime.evaluate')return {result:{value:views.length>1?views.shift():views[0]}};
      const clip=params?.clip as {width:number;height:number;scale:number}|undefined;
      return {data:jpegHeader(clip?Math.round(clip.width*clip.scale):shot.width,clip?Math.round(clip.height*clip.scale):shot.height)};
    },
    detach:async()=>{detached++;},
  };
  return {context:{newCDPSession:async()=>cdp} as unknown as BrowserContext,calls,detached:()=>detached};
}
const page={} as BrowserPage;

test('a viewer budget captures the visible viewport downscaled at its scroll offset',async()=>{
  const {context,calls,detached}=fakeContext([{width:1440,height:900,x:0,y:1800,zoom:1}],{width:1440,height:900});
  const frame=await captureBrowserFrame(context,page,80,{maxWidth:780,maxHeight:1200});
  assert.deepEqual({width:frame.width,height:frame.height,scale:frame.scale},{width:1440,height:900,scale:0.625},'width/height stay the CSS viewport, so taps map unchanged');
  assert.deepEqual(jpegSize(frame.bytes),{width:900,height:563});
  const screenshots=calls.filter(call=>call.method==='Page.captureScreenshot');
  assert.equal(screenshots.length,1);
  assert.deepEqual(screenshots[0].params?.clip,{x:0,y:1800,width:1440,height:900,scale:0.625},'clip uses document coordinates of the visible viewport');
  assert.equal(screenshots[0].params?.quality,80);
  assert.equal(detached(),1);
});

test('a scroll between measuring and capturing is retried once it settles',async()=>{
  const {context,calls}=fakeContext([{width:1120,height:720,x:0,y:0,zoom:1},{width:1120,height:720,x:0,y:240,zoom:1}],{width:1120,height:720});
  const frame=await captureBrowserFrame(context,page,55,{maxWidth:780,maxHeight:1200});
  assert.deepEqual({width:frame.width,height:frame.height,scale:frame.scale},{width:1120,height:720,scale:0.75});
  const screenshots=calls.filter(call=>call.method==='Page.captureScreenshot');
  assert.equal(screenshots.length,2);assert.deepEqual(screenshots[1].params?.clip,{x:0,y:240,width:1120,height:720,scale:0.75},'the retry uses the settled offset');
});

test('a page that keeps scrolling falls back to the always-aligned full viewport',async()=>{
  const moving=Array.from({length:12},(_,index)=>({width:1120,height:720,x:0,y:index*100,zoom:1}));
  const {context,calls}=fakeContext(moving,{width:1120,height:720});
  const frame=await captureBrowserFrame(context,page,55,{maxWidth:780,maxHeight:1200});
  assert.deepEqual({width:frame.width,height:frame.height,scale:frame.scale},{width:1120,height:720,scale:1});
  const screenshots=calls.filter(call=>call.method==='Page.captureScreenshot');
  assert.equal(screenshots.length,4,'three bounded scaled attempts, then one unscaled capture');assert.equal(screenshots[3].params?.clip,undefined);
});

test('no budget, a fitting budget or pinch zoom keep the unscaled capture path',async()=>{
  for(const [limits,view] of [[undefined,{width:1120,height:720,x:0,y:0,zoom:1}],[{maxWidth:2400,maxHeight:1600},{width:1120,height:720,x:0,y:0,zoom:1}],[{maxWidth:400,maxHeight:400},{width:1120,height:720,x:0,y:0,zoom:2}]] as const){
    const {context,calls}=fakeContext([view],{width:1120,height:720});
    const frame=await captureBrowserFrame(context,page,80,limits);
    assert.equal(frame.scale,1);assert.equal(frame.width,1120);
    assert.equal(calls.filter(call=>call.method==='Page.captureScreenshot'&&call.params?.clip).length,0);
    if(!limits)assert.equal(calls.filter(call=>call.method==='Runtime.evaluate').length,1,'full frames measure CSS dimensions too, including DPR and scrollbar width');
  }
});

test('a screenshot pending when the page commits a new document starts again on a fresh session at once', async () => {
  const listeners = new Set<() => void>();
  let sessions = 0, detached = 0, attempts = 0;
  const context = { newCDPSession: async () => {
    const index = ++sessions;
    return {
      // Chromium never answers the first screenshot: the document it was taken of went away.
      send: async (method: string) => method === 'Runtime.evaluate' ? { result: { value: { width: 800, height: 600, x: 0, y: 0, zoom: 1 } } }
        : index === 1 ? (setTimeout(() => { for (const restart of [...listeners]) restart(); }, 30), new Promise(() => {})) : { data: jpegHeader(800, 600) },
      detach: async () => { detached++; },
    };
  } } as unknown as BrowserContext;
  const began = Date.now();
  const frame = await captureBrowserFrame(context, page, 70, undefined, { onAttempt: () => { attempts++; }, watchCommits: restart => { listeners.add(restart); return () => { listeners.delete(restart); }; } });
  assert.deepEqual({ width: frame.width, height: frame.height }, { width: 800, height: 600 });
  assert(Date.now() - began < 1000, 'no wait for the 10 s limit');
  assert.deepEqual({ sessions, detached, attempts, listening: listeners.size }, { sessions: 2, detached: 2, attempts: 2, listening: 0 });
});

test('real browser: scaled frames show the scrolled viewport, dedupe by id and omit an unchanged session', {timeout:60000}, async()=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'paseo-browser-frame-test-'));
  const manager=new BrowserManager({dataRoot});
  const site=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<!doctype html><title>Bands</title><body style="margin:0"><div style="height:720px;background:#f00"></div><div style="height:720px;background:#00f"></div><div style="height:3000px;background:#0f0"></div></body>');});
  await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
  const address=site.address();assert(address&&typeof address!=='string');
  let browser:Browser|undefined;
  try{
    await manager.start('frame-test');
    await manager.action('frame-test',{kind:'navigate',url:`http://127.0.0.1:${address.port}/`});
    browser=await chromium.connectOverCDP(JSON.parse(await readFile(manager.metadataPath('frame-test'),'utf8')).cdpEndpoint);
    const viewed=browser.contexts()[0].pages().find(item=>item.url().includes(String(address.port)))!;
    await viewed.evaluate('window.scrollTo(0,720)');
    const budget={maxWidth:780,maxHeight:1200};
    const full=await manager.frame('frame-test',null,'sharp');
    const scaled=await manager.frame('frame-test',null,'sharp',budget);
    assert.equal(full.frame?.scale,undefined);assert.equal(scaled.frame?.scale,0.75);
    assert.deepEqual([scaled.frame?.width,scaled.frame?.height],[1120,720]);
    const pixels=jpegSize(Buffer.from(scaled.frame!.dataUrl.split(',')[1],'base64'));
    assert.deepEqual(pixels,{width:840,height:540});
    assert(scaled.frame!.dataUrl.length<full.frame!.dataUrl.length*0.75,'the downscaled frame is materially smaller');
    const center=await viewed.evaluate<number[]>(`(async()=>{const image=new Image();image.src=${JSON.stringify(scaled.frame!.dataUrl)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(image.width>>1,image.height>>1,1,1).data].slice(0,3);})()`);
    assert(center[2]>200&&center[0]<60&&center[1]<60,`the scrolled blue band is captured, got rgb(${center.join(',')})`);
    assert.equal((await manager.frame('frame-test',scaled.frame!.id,'sharp',budget)).frame,null,'an unchanged scaled page is not re-sent');
    const known=scaled.sessionRevision!;
    const quiet=await manager.frame('frame-test',scaled.frame!.id,'sharp',{...budget,sessionRevision:known});
    assert.equal(quiet.session,undefined);assert.equal(quiet.sessionRevision,known);
    assert(JSON.stringify(quiet).length<120,'an idle poll is a few dozen bytes');
    await manager.action('frame-test',{kind:'mode',mode:'agent'});
    const changed=await manager.frame('frame-test',scaled.frame!.id,'sharp',{...budget,sessionRevision:known});
    assert.equal(changed.session?.mode,'agent','a changed session is sent again');assert.notEqual(changed.sessionRevision,known);
  }finally{
    await browser?.close().catch(()=>{});await manager.close();site.closeAllConnections();await new Promise<void>(resolve=>site.close(()=>resolve()));await rm(dataRoot,{recursive:true,force:true});
  }
});
