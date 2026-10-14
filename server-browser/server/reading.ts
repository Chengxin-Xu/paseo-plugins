import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrowserPage } from './browser-types';
import { BUDGETS, withTimeout } from './budgets';
import { withoutCredentials } from './navigation';
import { defaultRuntimeRoot } from './runtime';
import type { BrowserReading, BrowserReadInput } from '../shared/browser';

type ReadingInput = Omit<BrowserReadInput, 'workspaceId'>;
type Capture = { title:string; url:string; html:string; visible:string; sourceTruncated:boolean };
type ReaderRuntime = {
  JSDOM:new (html:string,options:Record<string,unknown>)=>{window:{document:any;close():void}};
  Readability:new (document:any,options:Record<string,unknown>)=>{parse():{title?:string;content?:string;textContent?:string}|null};
  Turndown:new (options:Record<string,unknown>)=>{turndown(content:string):string};
};
const runtimes=new Map<string,ReaderRuntime>();
function readerRuntime(root:string):ReaderRuntime {
  let value=runtimes.get(root);
  if(!value){
    const require=createRequire(path.join(root,'package.json'));
    value={JSDOM:require('jsdom').JSDOM,Readability:require('@mozilla/readability').Readability,Turndown:require('turndown')};
    runtimes.set(root,value);
  }
  return value;
}

/** Read only the selected live page. No navigation, script execution from HTML, or credential access. A page that does not answer within timeoutMs fails the read. */
export async function readPageContent(page:BrowserPage,tabId:string,input:ReadingInput,runtimeRoot?:string,timeoutMs=BUDGETS.pageReadMs):Promise<BrowserReading> {
  const selector=input.selector?.trim()??'';
  if(selector.length>500)throw new Error('页面区域选择器过长。');
  const captured=await withTimeout(page.evaluate(`(() => {
    const selector=${JSON.stringify(selector)};
    let element;
    try { element=selector?document.querySelector(selector):document.body; }
    catch { throw new Error('页面区域选择器无效。'); }
    if(!element)throw new Error('指定的页面区域不存在，请刷新页面或检查选择器。');
    const clone=element.cloneNode(true);
    for(const node of clone.querySelectorAll('script,style,noscript,template,iframe,input,textarea,select,[hidden],[aria-hidden="true"]'))node.remove();
    // Resolve relative links before passing the inert document to the article reader.
    for(const node of clone.querySelectorAll('a[href]')){
      try{const u=new URL(node.getAttribute('href'),document.baseURI);if(!['http:','https:','mailto:'].includes(u.protocol)){node.removeAttribute('href');continue;}node.setAttribute('href',u.href);}catch{node.removeAttribute('href');}
    }
    const html=clone.outerHTML??'';
    const visible=element.innerText??element.textContent??'';
    return {title:document.title,url:location.href,html:html.slice(0,2000000),visible:visible.slice(0,400000),sourceTruncated:html.length>2000000||visible.length>400000};
  })()`) as Promise<Capture>,timeoutMs,()=>{throw new Error('网页长时间没有响应，读取已停止。');});
  let content=captured.visible.trim();
  let title=captured.title;
  let method:BrowserReading['method']='dom';
  let format:BrowserReading['format']='text';
  if(input.mode==='article'&&!selector){
    try{
      const runtime=readerRuntime(runtimeRoot??defaultRuntimeRoot());
      const dom=new runtime.JSDOM(captured.html,{url:/^https?:/.test(captured.url)?captured.url:'https://local.invalid/'});
      try{
        const article=new runtime.Readability(dom.window.document,{charThreshold:100,maxElemsToParse:25000}).parse();
        if(article?.content&&(article.textContent?.trim().length??0)>=80){
          const turndown=new runtime.Turndown({headingStyle:'atx',codeBlockStyle:'fenced'});
          content=turndown.turndown(article.content).trim();title=article.title?.trim()||title;method='readability';format='markdown';
        }
      }finally{dom.window.close();}
    }catch{
      // A non-article layout or unavailable reader dependencies retains the visible text fallback.
    }
  }
  const query=input.query?.trim();
  if(query){
    const lines=content.split('\n'),matched=new Set<number>();
    lines.forEach((line,index)=>{if(line.toLocaleLowerCase().includes(query.toLocaleLowerCase()))for(let i=Math.max(0,index-1);i<=Math.min(lines.length-1,index+1);i++)matched.add(i);});
    content=matched.size?[...matched].sort((a,b)=>a-b).map(index=>lines[index]).join('\n'):'未找到匹配内容。可切换到完整可见文字，或缩短搜索词。';
  }
  const maxChars=Math.max(500,Math.min(60000,input.maxChars??16000));
  const characters=content.length;
  return {tabId,title,url:withoutCredentials(captured.url),content:content.slice(0,maxChars),format,method,truncated:captured.sourceTruncated||characters>maxChars,characters};
}
