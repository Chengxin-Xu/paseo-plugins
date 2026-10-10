import { randomUUID } from 'node:crypto';
import type { BrowserActivity } from '../shared/browser';

const actions:Record<string,string>={
 navigate:'打开网页',back:'返回上一页',forward:'前往下一页',reload:'刷新网页',demo:'打开体验页',
 stop:'停止浏览器',restart:'重启浏览器',newTab:'新建标签',tab:'切换标签',closeTab:'关闭标签',pin:'固定标签',
 click:'点击页面',scroll:'滚动页面',text:'输入文字',key:'按下按键',mode:'切换操作模式',viewport:'调整画面尺寸',fitWidth:'适应完整页面宽度',
 browser_navigate:'打开网页',browser_navigate_back:'返回上一页',browser_navigate_forward:'前往下一页',
 browser_click:'点击页面',browser_type:'输入文字',browser_fill_form:'填写表单',browser_press_key:'按下按键',
 browser_select_option:'选择选项',browser_hover:'移动鼠标',browser_drag:'拖动页面',browser_resize:'调整画面尺寸',
 browser_snapshot:'查看页面',browser_find:'查找页面元素',browser_wait_for:'等待页面',browser_take_screenshot:'截取页面',
 browser_console_messages:'查看控制台',browser_network_requests:'查看网络请求',browser_evaluate:'执行页面操作',
 browser_run_code:'执行浏览器操作',browser_file_upload:'上传文件',browser_handle_dialog:'处理网页对话框',
 browser_read_page:'阅读网页',browser_diagnostics:'查看页面诊断',browser_tabs:'查看标签列表',
 'tabs:list':'查看标签列表','tabs:new':'新建标签','tabs:select':'切换标签','tabs:close':'关闭标签',
};
export type ActivityPage={tabId:string|null;pageTitle:string;pageUrl:string};
export function activityAction(name:unknown,tabAction?:unknown):string{
 if(name==='browser_tabs'&&typeof tabAction==='string'&&Object.hasOwn(actions,`tabs:${tabAction}`))return actions[`tabs:${tabAction}`];
 return typeof name==='string'&&Object.hasOwn(actions,name)?actions[name]:'浏览器操作';
}
export function activityUrl(raw:unknown):string{
 if(typeof raw!=='string'||!raw)return '';
 try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)?`${url.origin}${url.pathname}`:'本地页面';}catch{return '';}
}
function safePage(page:ActivityPage):ActivityPage{
 return {tabId:page.tabId,pageTitle:page.pageTitle.replace(/https?:\/\/[^\s"'<>]+/gi,url=>activityUrl(url)).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160),pageUrl:activityUrl(page.pageUrl)};
}
/** Deliberately memory-only; actions never contain inputs, cookies, errors or tool arguments. */
export class BrowserActivityLog{
 private entries:BrowserActivity[]=[];
 start(source:BrowserActivity['source'],name:unknown,page:ActivityPage,tabAction?:unknown):string{
  const id=randomUUID();this.entries.unshift({id,source,action:activityAction(name,tabAction),status:'running',...safePage(page),startedAt:Date.now(),endedAt:null});this.entries=this.entries.slice(0,12);return id;
 }
 update(id:string,page:ActivityPage,tabAction?:string):void{
  const entry=this.entries.find(item=>item.id===id);if(!entry||entry.status!=='running')return;
  Object.assign(entry,safePage(page));if(tabAction)entry.action=activityAction('browser_tabs',tabAction);
 }
 finish(id:string,failed:boolean,page?:ActivityPage):void{
  const entry=this.entries.find(item=>item.id===id);if(!entry||entry.status!=='running')return;
  if(page)Object.assign(entry,safePage(page));entry.status=failed?'failed':'completed';entry.endedAt=Date.now();
 }
 failRunning(preserveManualLifecycle=false):void{for(const entry of this.entries)if(entry.status==='running'&&!(preserveManualLifecycle&&entry.source==='manual'&&['停止浏览器','重启浏览器'].includes(entry.action)))this.finish(entry.id,true);}
 snapshot():BrowserActivity[]{return this.entries.map(entry=>({...entry}));}
}
