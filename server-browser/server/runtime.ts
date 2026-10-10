import { homedir } from 'node:os';
import path from 'node:path';

/** Host runtime (Playwright, Playwright MCP, reader libraries, optional lib/ and fonts.conf); prepared once by scripts/setup-runtime.mjs. */
export function defaultRuntimeRoot(env:NodeJS.ProcessEnv=process.env):string{return env.PASEO_SERVER_BROWSER_RUNTIME||path.join(homedir(),'.local/share/paseo-server-browser');}
/** Optional proxy for the shared Chromium only. Without it Chromium follows the daemon's HTTP(S)_PROXY / ALL_PROXY variables. */
export function browserProxy(env:NodeJS.ProcessEnv=process.env):string|undefined{
 const value=env.PASEO_SERVER_BROWSER_PROXY?.trim();if(!value)return undefined;
 if(/[\s\u0000-\u001f]/.test(value))throw new Error('PASEO_SERVER_BROWSER_PROXY 格式无效：应为 host:port 或 scheme://host:port。');return value;
}
/** Chromium's own sandbox stays off by default, as in Playwright; PASEO_SERVER_BROWSER_SANDBOX=1 enables it on hosts that support it. */
export const browserSandbox=(env:NodeJS.ProcessEnv=process.env)=>env.PASEO_SERVER_BROWSER_SANDBOX==='1';
export function chromiumArguments(options:{profileDir:string;width:number;height:number;proxy?:string;sandbox?:boolean}):string[]{
 return ['--headless',...(options.sandbox?[]:['--no-sandbox']),'--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',...(options.proxy?[`--proxy-server=${options.proxy}`]:[]),`--user-data-dir=${options.profileDir}`,`--window-size=${options.width},${options.height}`,'about:blank'];
}
export const missingRuntime=(root:string)=>`服务器浏览器运行时未准备：${root} 中没有 Playwright。请在 daemon 主机运行插件目录里的 scripts/setup-runtime.mjs，或用 PASEO_SERVER_BROWSER_RUNTIME 指定运行时目录。`;
export const missingChromium='找不到 Chromium：请为运行时安装 Playwright 的 chromium-headless-shell，或用 PASEO_SERVER_BROWSER_EXECUTABLE 指定 Chromium 可执行文件。';
