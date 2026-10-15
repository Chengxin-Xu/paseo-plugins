import { t, type MessageId } from '../shared/text';
import { randomUUID } from 'node:crypto';
import type { BrowserActivity } from '../shared/browser';

const actions:Record<string,MessageId>={
 navigate:'activity.navigate',back:'activity.back',forward:'activity.forward',reload:'activity.reload',demo:'activity.demo',
 stop:'activity.stop',restart:'activity.restart',newTab:'activity.newTab',tab:'activity.tab',closeTab:'activity.closeTab',pin:'activity.pin',
 click:'activity.click',scroll:'activity.scroll',text:'activity.text',key:'activity.key',mode:'activity.mode',viewport:'activity.viewport',devicePreset:'activity.devicePreset',handleDialog:'activity.handleDialog',fitWidth:'activity.fitWidth',
 browser_navigate:'activity.navigate',browser_navigate_back:'activity.back',browser_navigate_forward:'activity.forward',
 browser_click:'activity.click',browser_type:'activity.text',browser_fill_form:'activity.fillForm',browser_press_key:'activity.key',
 browser_select_option:'activity.selectOption',browser_hover:'activity.hover',browser_drag:'activity.drag',browser_resize:'activity.viewport',
 browser_snapshot:'activity.snapshot',browser_find:'activity.find',browser_wait_for:'activity.wait',browser_take_screenshot:'activity.screenshot',
 browser_console_messages:'activity.console',browser_network_requests:'activity.network',browser_evaluate:'activity.evaluate',
 browser_run_code:'activity.runCode',browser_file_upload:'activity.upload',browser_handle_dialog:'activity.handleDialog',
 browser_read_page:'activity.read',browser_diagnostics:'activity.diagnostics',browser_tabs:'activity.tabs',
 'tabs:list':'activity.tabs','tabs:new':'activity.newTab','tabs:select':'activity.tab','tabs:close':'activity.closeTab',
};
export type ActivityPage={tabId:string|null;pageTitle:string;pageUrl:string};
function activityId(name:unknown,tabAction?:unknown):MessageId{
 if(name==='browser_tabs'&&typeof tabAction==='string'&&Object.hasOwn(actions,`tabs:${tabAction}`))return actions[`tabs:${tabAction}`];
 return typeof name==='string'&&Object.hasOwn(actions,name)?actions[name]:'activity.operation';
}
export function activityAction(name:unknown,tabAction?:unknown):string{return t(activityId(name,tabAction));}
export function activityUrl(raw:unknown):string{
 if(typeof raw!=='string'||!raw)return '';
 // i18n-ignore: legacy protocol sentinel, translated by the client; never used as identity.
 try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)?`${url.origin}${url.pathname}`:'本地页面';}catch{return '';}
}
function safePage(page:ActivityPage):ActivityPage{
 return {tabId:page.tabId,pageTitle:page.pageTitle.replace(/https?:\/\/[^\s"'<>]+/gi,url=>activityUrl(url)).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160),pageUrl:/^[a-z][a-z0-9+.-]*:/i.test(page.pageUrl)&&!/^https?:/i.test(page.pageUrl)?'about:blank':activityUrl(page.pageUrl)};
}
/** Deliberately memory-only; actions never contain inputs, cookies, errors or tool arguments. */
export class BrowserActivityLog{
 private entries:(Omit<BrowserActivity,'action'>&{actionId:MessageId})[]=[];
 start(source:BrowserActivity['source'],name:unknown,page:ActivityPage,tabAction?:unknown):string{
  const id=randomUUID();this.entries.unshift({id,source,actionId:activityId(name,tabAction),status:'running',...safePage(page),startedAt:Date.now(),endedAt:null});this.entries=this.entries.slice(0,12);return id;
 }
 /** Typing or scrolling arrives in many small batches: one that follows the same kind on the same tab within windowMs extends that entry instead of pushing the history out. */
 continue(source:BrowserActivity['source'],name:unknown,page:ActivityPage,windowMs=10_000):string{
  const latest=this.entries[0],actionId=activityId(name);
  if(latest&&latest.source===source&&latest.actionId===actionId&&latest.tabId===page.tabId&&latest.status==='completed'&&latest.endedAt!==null&&Date.now()-latest.endedAt<=windowMs){latest.status='running';latest.endedAt=null;return latest.id;}
  return this.start(source,name,page);
 }
 update(id:string,page:ActivityPage,tabAction?:string):void{
  const entry=this.entries.find(item=>item.id===id);if(!entry||entry.status!=='running')return;
  Object.assign(entry,safePage(page));if(tabAction)entry.actionId=activityId('browser_tabs',tabAction);
 }
 finish(id:string,failed:boolean,page?:ActivityPage):void{
  const entry=this.entries.find(item=>item.id===id);if(!entry||entry.status!=='running')return;
  if(page)Object.assign(entry,safePage(page));entry.status=failed?'failed':'completed';entry.endedAt=Date.now();
 }
 failRunning(preserveManualLifecycle=false):void{for(const entry of this.entries)if(entry.status==='running'&&!(preserveManualLifecycle&&entry.source==='manual'&&['activity.stop','activity.restart'].includes(entry.actionId)))this.finish(entry.id,true);}
 snapshot():BrowserActivity[]{return this.entries.map(({actionId,...entry})=>({...entry,actionId,action:t(actionId),pageUrl:activityUrl(entry.pageUrl)}));}
}
