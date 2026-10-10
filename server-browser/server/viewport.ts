import type { BrowserPage } from './browser-types';
import { BUDGETS, withTimeout } from './budgets';

type Size={width:number;height:number};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** The page's own size, or null when it cannot answer in time. */
async function actual(page:BrowserPage):Promise<Size|null>{
  try{return await withTimeout(page.evaluate<Size|null>('({width:innerWidth,height:innerHeight})'),BUDGETS.viewportProbeMs,()=>null);}catch{return null;}
}
function matches(a:Size|null,b:Size){return a?.width===b.width&&a.height===b.height;}

/** Playwright caches emulation per CDP connection; another viewer can invalidate that cache. */
export async function setVerifiedViewport(page:BrowserPage,size:Size):Promise<void>{
  await page.setViewportSize(size);
  if(matches(await actual(page),size))return;
  await sleep(40);
  if(matches(await actual(page),size))return;
  // A distinct intermediate value makes Playwright issue a fresh metrics override.
  // Use the supported public API so its internal state agrees with the final size.
  await page.setViewportSize({width:size.width===2560?2559:size.width+1,height:size.height});
  await page.setViewportSize(size);
  const end=Date.now()+1200;
  while(Date.now()<end){if(matches(await actual(page),size))return;await sleep(50);}
  throw new Error('网页尺寸尚未同步，请稍后重新匹配窗口。');
}
