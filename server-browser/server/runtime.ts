import { homedir } from 'node:os';
import path from 'node:path';
import { blockedHostResolverRules } from './navigation';

/** Host runtime (Playwright, Playwright MCP, reader libraries, optional lib/ and fonts.conf); prepared once by scripts/setup-runtime.mjs. */
export function defaultRuntimeRoot(env:NodeJS.ProcessEnv=process.env):string{return env.PASEO_SERVER_BROWSER_RUNTIME||path.join(homedir(),'.local/share/paseo-server-browser');}
/** Optional proxy for the shared Chromium only. Without it Chromium follows the daemon's HTTP(S)_PROXY / ALL_PROXY variables. */
export function browserProxy(env:NodeJS.ProcessEnv=process.env):string|undefined{
 const value=env.PASEO_SERVER_BROWSER_PROXY?.trim();if(!value)return undefined;
 if(/[\s\u0000-\u001f]/.test(value))throw new Error('PASEO_SERVER_BROWSER_PROXY 格式无效：应为 host:port 或 scheme://host:port。');
 // The value becomes a Chromium argument, which every local account can read in the process list.
 if(value.includes('@'))throw new Error('PASEO_SERVER_BROWSER_PROXY 不能包含账号密码：它会出现在 Chromium 的命令行里。请改用不需要认证的代理地址。');
 return value;
}
/**
 * Chromium's own sandbox. auto (unset): on, and if Chromium cannot start with it, off with a warning in page diagnostics.
 * PASEO_SERVER_BROWSER_SANDBOX=1 always on (start fails where unsupported); 0 always off.
 */
export type SandboxMode='auto'|'on'|'off';
export function browserSandboxMode(env:NodeJS.ProcessEnv=process.env):SandboxMode{const value=env.PASEO_SERVER_BROWSER_SANDBOX?.trim();return value==='1'?'on':value==='0'?'off':'auto';}
export function chromiumArguments(options:{profileDir:string;width:number;height:number;proxy?:string;sandbox?:boolean}):string[]{
 return ['--headless',...(options.sandbox?[]:['--no-sandbox']),'--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
  '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--host-resolver-rules=${blockedHostResolverRules()}`,...(options.proxy?[`--proxy-server=${options.proxy}`]:[]),`--user-data-dir=${options.profileDir}`,`--window-size=${options.width},${options.height}`,'about:blank'];
}
/** Environment variables a child process may inherit: paths, locale, time zone, temporary and XDG folders. Everything else in the daemon's environment stays out. */
const BASE_ENVIRONMENT=['PATH','HOME','USER','LOGNAME','LANG','LANGUAGE','TZ','TMPDIR','LD_LIBRARY_PATH'];
const BASE_PREFIXES=['LC_','XDG_'];
/** Chromium also needs proxy settings, fontconfig and the setuid sandbox helper path when the host uses one. */
const CHROMIUM_ENVIRONMENT=[...BASE_ENVIRONMENT,'FONTCONFIG_FILE','FONTCONFIG_PATH','CHROME_DEVEL_SANDBOX','http_proxy','https_proxy','all_proxy','no_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'];
/** Playwright MCP only talks to Chromium on 127.0.0.1 and writes files, so it gets the base set. */
export const MCP_ENVIRONMENT={names:BASE_ENVIRONMENT,prefixes:BASE_PREFIXES};
export function inheritedEnvironment(env:NodeJS.ProcessEnv,names:readonly string[],prefixes:readonly string[]=BASE_PREFIXES):NodeJS.ProcessEnv{
 const allowed=new Set(names);
 return Object.fromEntries(Object.entries(env).filter(([key,value])=>value!==undefined&&(allowed.has(key)||prefixes.some(prefix=>key.startsWith(prefix)))));
}
/** The runtime's lib/ joins LD_LIBRARY_PATH only when it exists; its fonts.conf replaces FONTCONFIG_FILE when present. */
export function chromiumEnvironment(env:NodeJS.ProcessEnv,options:{libDirectory?:string;fontsConf?:string}={}):NodeJS.ProcessEnv{
 const environment=inheritedEnvironment(env,CHROMIUM_ENVIRONMENT);
 const libraries=[options.libDirectory,env.LD_LIBRARY_PATH].filter(Boolean).join(':');
 if(libraries)environment.LD_LIBRARY_PATH=libraries;else delete environment.LD_LIBRARY_PATH;
 if(options.fontsConf)environment.FONTCONFIG_FILE=options.fontsConf;
 return environment;
}
export const missingRuntime=(root:string)=>`服务器浏览器运行时未准备：${root} 中没有 Playwright。请在 daemon 主机运行插件目录里的 scripts/setup-runtime.mjs，或用 PASEO_SERVER_BROWSER_RUNTIME 指定运行时目录。`;
export const missingChromium='找不到 Chromium：请为运行时安装 Playwright 的 chromium-headless-shell，或用 PASEO_SERVER_BROWSER_EXECUTABLE 指定 Chromium 可执行文件。';
