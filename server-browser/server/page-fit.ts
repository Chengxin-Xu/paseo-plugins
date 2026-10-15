import { t } from '../shared/text';
import type { BrowserPage } from './browser-types';
import { BUDGETS, withTimeout } from './budgets';
import { setVerifiedViewport } from './viewport';

export type PageWidthMeasure={width:number;height:number;overflow:number;requiredWidth:number};

/** Include wide nested app/table panes; ignore hidden content and short ticker/carousel strips. A page that does not answer within timeoutMs fails the measurement. */
export async function measurePageWidth(page:BrowserPage,timeoutMs=BUDGETS.measureMs):Promise<PageWidthMeasure>{
  return withTimeout(page.evaluate<PageWidthMeasure>(`(() => {
    const width=innerWidth,height=innerHeight;
    const root=document.documentElement;
    let overflow=Math.max(0,root.scrollWidth-root.clientWidth);
    const minimumHeight=Math.min(120,height*.25);
    const nodes=document.body?document.body.querySelectorAll('*'):[];
    for(let i=0;i<Math.min(nodes.length,18000);i++){
      const element=nodes[i],rect=element.getBoundingClientRect();
      if(rect.width<Math.min(240,width*.3)||rect.height<minimumHeight||rect.right<=0||rect.left>=width||rect.bottom<=0||rect.top>=height)continue;
      const style=getComputedStyle(element);
      if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)continue;
      if(!['auto','scroll','hidden','clip'].includes(style.overflowX))continue;
      const excess=element.scrollWidth-element.clientWidth;
      if(excess>8)overflow=Math.max(overflow,excess);
    }
    return {width,height,overflow,requiredWidth:Math.ceil(width+overflow)};
  })()`),timeoutMs,()=>{throw new Error(t('serverError.measureTimeout'));});
}

/** Reflow the live viewport, never replace it with a full-page photograph. No page navigation. */
export async function fitPageWidth(page:BrowserPage,maxWidth=2560,timeoutMs=BUDGETS.measureMs):Promise<PageWidthMeasure&{limitReached:boolean}>{
  let measure=await measurePageWidth(page,timeoutMs);
  const height=measure.height;
  for(let attempt=0;attempt<3&&measure.overflow>8&&measure.width<maxWidth;attempt++){
    const width=Math.min(maxWidth,Math.ceil((measure.requiredWidth+16)/16)*16);
    await setVerifiedViewport(page,{width,height});
    await new Promise(resolve=>setTimeout(resolve,100));
    measure=await measurePageWidth(page,timeoutMs);
  }
  return {...measure,limitReached:measure.overflow>8};
}
