/** Narrow runtime contract: Playwright's optional Electron types must not enter the plugin bundle. */
export interface BrowserFrame { url():string }
export interface BrowserRequest {
  isNavigationRequest():boolean;
  frame():BrowserFrame;
  failure():{errorText:string}|null;
}
export interface BrowserResponse { status():number; request():BrowserRequest; frame():BrowserFrame }
export interface BrowserCDPSession { send<T=any>(method:string,params?:Record<string,unknown>):Promise<T>; detach():Promise<void> }
export interface BrowserPage {
  on(event:'close',listener:()=>void):unknown;
  on(event:'dialog',listener:(dialog:{dismiss():Promise<void>})=>void):unknown;
  on(event:'framenavigated',listener:(frame:BrowserFrame)=>void):unknown;
  on(event:'response',listener:(response:BrowserResponse)=>void):unknown;
  on(event:'requestfailed',listener:(request:BrowserRequest)=>void):unknown;
  mainFrame():BrowserFrame;
  isClosed():boolean;
  title():Promise<string>;
  content():Promise<string>;
  url():string;
  viewportSize():{width:number;height:number}|null;
  setViewportSize(size:{width:number;height:number}):Promise<void>;
  setContent(html:string,options?:{waitUntil?:string}):Promise<void>;
  goto(url:string,options?:{waitUntil?:string;timeout?:number}):Promise<unknown>;
  goBack(options?:{waitUntil?:string}):Promise<unknown>;
  goForward(options?:{waitUntil?:string}):Promise<unknown>;
  reload(options?:{waitUntil?:string}):Promise<unknown>;
  evaluate<R=unknown>(expression:string|((arg:any)=>R),arg?:any):Promise<R>;
  screenshot(options:{type:'jpeg';quality:number;timeout:number}):Promise<Buffer>;
  bringToFront():Promise<void>;
  close():Promise<void>;
  mouse:{click(x:number,y:number):Promise<void>;wheel(deltaX:number,deltaY:number):Promise<void>};
  keyboard:{insertText(text:string):Promise<void>;press(key:string):Promise<void>};
}
export interface BrowserContext {
  pages():BrowserPage[];
  newPage():Promise<BrowserPage>;
  newCDPSession(page:BrowserPage):Promise<BrowserCDPSession>;
  setDefaultTimeout(timeout:number):void;
  setDefaultNavigationTimeout(timeout:number):void;
  on(event:'page',listener:(page:BrowserPage)=>void):unknown;
}
export interface BrowserConnection { contexts():BrowserContext[]; close():Promise<void> }
