import type { BrowserCDPSession, BrowserContext, BrowserPage } from './browser-types';

export type FrameLimits={maxWidth?:number;maxHeight?:number};
export type CapturedFrame={bytes:Buffer;width:number;height:number;scale:number};
type ViewportMetrics={width:number;height:number;x:number;y:number;zoom:number};

export function jpegSize(bytes:Buffer):{width:number;height:number}|null{
  let cursor=2;while(cursor+8<bytes.length){if(bytes[cursor++]!==0xff)return null;while(bytes[cursor]===0xff)cursor++;const marker=bytes[cursor++];if(marker===0xd9||marker===0xda)return null;const length=bytes.readUInt16BE(cursor);if(length<2||cursor+length>bytes.length)return null;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {height:bytes.readUInt16BE(cursor+3),width:bytes.readUInt16BE(cursor+5)};cursor+=length;}return null;
}

/** Fit the CSS viewport into the viewer's device-pixel budget: never enlarged, 1/8 steps so small resizes reuse frames, at least 1/4. */
export function frameScale(viewport:{width:number;height:number},limits?:FrameLimits):number{
  const raw=Math.min(1,(limits?.maxWidth??Infinity)/viewport.width,(limits?.maxHeight??Infinity)/viewport.height);
  if(!Number.isFinite(raw)||raw<=0)return 1;
  return Math.max(0.25,Math.min(1,Math.ceil(raw*8)/8));
}

// Same trust level as the manager's viewport(): read by the page's own window, never written.
const VIEWPORT_EXPRESSION='(()=>{const v=globalThis.visualViewport;return {width:innerWidth,height:innerHeight,x:v?v.pageLeft:scrollX,y:v?v.pageTop:scrollY,zoom:v?v.scale:1};})()';
async function viewportMetrics(cdp:BrowserCDPSession):Promise<ViewportMetrics|null>{
  try{
    const value=(await cdp.send<{result?:{value?:ViewportMetrics}}>('Runtime.evaluate',{expression:VIEWPORT_EXPRESSION,returnByValue:true})).result?.value;
    return value&&[value.width,value.height,value.x,value.y,value.zoom].every(Number.isFinite)&&value.width>0&&value.height>0?value:null;
  }catch{return null;}
}
const SCALED_ATTEMPTS=3,SETTLE_MS=120;
const same=(a:ViewportMetrics|null,b:ViewportMetrics)=>!!a&&a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height&&a.zoom===b.zoom;

async function capture(cdp:BrowserCDPSession,quality:number,limits?:FrameLimits):Promise<CapturedFrame>{
  const screenshot=async(clip?:Record<string,number>)=>{
    const result=await cdp.send<{data:string}>('Page.captureScreenshot',{format:'jpeg',quality,fromSurface:true,captureBeyondViewport:false,...(clip?{clip}:{})});
    if(!result.data)throw new Error('浏览器未返回画面。');return Buffer.from(result.data,'base64');
  };
  for(let attempt=0;(limits?.maxWidth||limits?.maxHeight)&&attempt<SCALED_ATTEMPTS;attempt++){
    const view=await viewportMetrics(cdp),scale=view?frameScale(view,limits):1;
    if(!view||scale>=1||view.zoom!==1)break;
    // Clip coordinates are document coordinates: capture the visible viewport at its scroll offset.
    const bytes=await screenshot({x:view.x,y:view.y,width:view.width,height:view.height,scale});
    // A scroll or resize between measuring and capturing could misplace the clip. Wheel scrolling animates for
    // ~150 ms, so let it settle and retry; the unscaled capture below is the always-aligned last resort.
    if(same(await viewportMetrics(cdp),view))return {bytes,width:view.width,height:view.height,scale};
    if(attempt<SCALED_ATTEMPTS-1)await new Promise(resolve=>setTimeout(resolve,SETTLE_MS));
  }
  const bytes=await screenshot(),size=jpegSize(bytes);
  return {bytes,width:size?.width??0,height:size?.height??0,scale:1};
}

/** Capture the actual shared viewport without reapplying a Playwright connection's cached metrics. */
export async function captureBrowserFrame(context:BrowserContext,page:BrowserPage,quality:number,limits?:FrameLimits):Promise<CapturedFrame>{
  const cdp=await context.newCDPSession(page);let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([
      capture(cdp,quality,limits),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('浏览器截图超时，请重试。')),10000);}),
    ]);
  }finally{if(timer)clearTimeout(timer);await cdp.detach().catch(()=>{});}
}
