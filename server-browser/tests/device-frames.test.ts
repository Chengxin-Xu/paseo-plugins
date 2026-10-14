import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { TestBrowserManager } from './manual-action';
import { DEVICE_PRESETS, deviceIdentity, greaseBrand } from '../shared/devices';
import type { BrowserDevicePreset } from '../shared/browser';
import { jpegSize } from '../server/frame';

test('preset identities follow the running Chromium, never a fixed old version (opus-F10)',()=>{
 // Chromium 153's own brand list carries "Not_A Brand";v="8": the same GREASE is generated for any version.
 assert.deepEqual(greaseBrand(153),{brand:'Not_A Brand',version:'8'});
 const desktop=deviceIdentity('desktop','153.0.8010.12');
 assert.equal(desktop.userAgent,'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
 assert.deepEqual(desktop.userAgentMetadata?.brands,[{brand:'Chromium',version:'153'},{brand:'Google Chrome',version:'153'},{brand:'Not_A Brand',version:'8'}]);
 assert.equal(desktop.userAgentMetadata?.fullVersion,'153.0.8010.12');assert.equal(desktop.userAgentMetadata?.mobile,false);
 const pixel=deviceIdentity('pixel','160.1.2.3');
 assert.match(pixel.userAgent,/Android 10; K\).*Chrome\/160\.0\.0\.0 Mobile Safari/);assert.equal(pixel.userAgentMetadata?.platform,'Android');assert.equal(pixel.userAgentMetadata?.model,'Pixel 7');assert.equal(pixel.userAgentMetadata?.mobile,true);
 for(const preset of ['iphone','ipad'] as const){const safari=deviceIdentity(preset,'153.0.8010.12');assert.equal(safari.userAgentMetadata,undefined,'Safari sends no Client Hints');assert.doesNotMatch(safari.userAgent,/Chrome/);}
 assert.match(deviceIdentity('desktop','not-a-version').userAgent,/Chrome\/0\.0\.0\.0/);
});

test('device presets preserve the page and storage, emulate all device signals and keep frame clicks in CSS coordinates', { timeout: 120000 }, async () => {
 const dataRoot=await mkdtemp(path.join(tmpdir(),'browser-device-frames-'));
 const manager=new TestBrowserManager({dataRoot});
 const site=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device checks</title><style>body{margin:0}button{position:absolute;left:90px;top:130px;width:120px;height:50px}</style><button onclick="document.body.dataset.clicked=String(Number(document.body.dataset.clicked||0)+1)">点击目标</button>');});
 await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));const address=site.address();assert(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/`;
 let browser:Browser|undefined;
 try{
  await manager.start('devices');await manager.action('devices',{kind:'navigate',url});
  const meta=JSON.parse(await readFile(manager.metadataPath('devices'),'utf8'));
  browser=await chromium.connectOverCDP(meta.cdpEndpoint);const page=browser.contexts()[0].pages().find(page=>page.url()===url)!;
  const version=browser.version(),major=version.split('.')[0];
  const engine=await page.evaluate('navigator.userAgent') as string;
  assert.match(engine,new RegExp(`Chrome/${version.replace(/\./g,'\\.')}`),'a custom size keeps the engine\'s own user agent');
  await page.evaluate("document.cookie='device-test=kept';sessionStorage.setItem('draft','kept');document.body.dataset.clicked='0'");
  let clicks=0;
  for(const preset of ['iphone','pixel','ipad','desktop'] as BrowserDevicePreset[]){
   await manager.action('devices',{kind:'devicePreset',preset});const device=DEVICE_PRESETS[preset];
   const signals=await page.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,ua:navigator.userAgent,mobile:navigator.userAgentData.mobile,brands:navigator.userAgentData.brands,cookie:document.cookie,draft:sessionStorage.getItem("draft")})') as {width:number;height:number;dpr:number;touch:number;ua:string;mobile:boolean;brands:{brand:string;version:string}[];cookie:string;draft:string};
   assert.equal(signals.width,device.width);assert.equal(signals.height,device.height);assert.equal(signals.dpr,device.deviceScaleFactor);assert.equal(signals.touch>0,device.hasTouch);assert.equal(signals.ua,deviceIdentity(preset,version).userAgent);assert.equal(signals.draft,'kept');assert.match(signals.cookie,/device-test=kept/);assert.equal(page.url(),url);
   // Chrome presets carry the running engine's version, never a fixed old one; Safari presets send no Client Hints, like Safari.
   if(device.browser.startsWith('chrome')){assert.equal(signals.mobile,device.isMobile);assert.match(signals.ua,new RegExp(`Chrome/${major}\\.0\\.0\\.0`));assert.deepEqual(signals.brands.filter(item=>/Chrom/.test(item.brand)).map(item=>[item.brand,item.version]),[['Chromium',major],['Google Chrome',major]]);}
   else {assert.deepEqual(signals.brands,[]);assert.doesNotMatch(signals.ua,/Chrome\//);}
   const full=(await manager.frame('devices',null,'sharp')).frame!;assert(full);assert.equal(full.width,device.width);assert.equal(full.height,device.height);
   const small=(await manager.frame('devices',null,'smooth',{maxWidth:300,maxHeight:500})).frame!;assert(small);assert.equal(small.width,device.width);assert.equal(small.height,device.height);
   const pixels=jpegSize(Buffer.from(small.dataUrl.split(',')[1],'base64'))!;assert(pixels.width<=Math.ceil(device.width*Math.ceil(Math.min(1,300/device.width,500/device.height)*8)/8)+2,`${preset}: screenshot respects the viewer pixel budget: ${pixels.width}`);
   await manager.action('devices',{kind:'click',x:150,y:155},{tabId:small.tabId,viewRevision:small.viewRevision});
   assert.equal(await page.evaluate('Number(document.body.dataset.clicked)'),++clicks,`${preset}: one CSS-space click lands on the small target`);
  }
  await manager.action('devices',{kind:'devicePreset',preset:'pixel'});await manager.action('devices',{kind:'newTab'});
  const state=await manager.state('devices');assert.equal(state.devicePreset,'pixel');
  const newPage=browser.contexts()[0].pages().find(item=>item.url()!==url)!;assert.equal(await newPage.evaluate('devicePixelRatio'),DEVICE_PRESETS.pixel.deviceScaleFactor);assert.equal(await newPage.evaluate('navigator.maxTouchPoints>0'),true);
  // Back to a custom size: the engine's own identity returns.
  await manager.action('devices',{kind:'viewport',width:1000,height:700});
  assert.equal(await page.evaluate('navigator.userAgent'),engine);
  await manager.action('devices',{kind:'devicePreset',preset:'pixel'});
  await browser.close();browser=undefined;await manager.action('devices',{kind:'restart'});
  const restored=await manager.state('devices');assert.equal(restored.devicePreset,'pixel');assert.equal(restored.width,DEVICE_PRESETS.pixel.width);
 }finally{await browser?.close().catch(()=>{});await manager.close();site.closeAllConnections();await new Promise<void>(resolve=>site.close(()=>resolve()));await rm(dataRoot,{recursive:true,force:true});}
});
