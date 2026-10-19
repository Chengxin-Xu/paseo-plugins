// Prepares the host runtime the plugin loads at run time. Run it yourself on the daemon host; Paseo never runs it.
//   node scripts/setup-runtime.mjs           install the locked runtime packages into the runtime directory, then check it
//   node scripts/setup-runtime.mjs --check   only check what is already there
// The runtime directory is $PASEO_SERVER_BROWSER_RUNTIME, by default ~/.local/share/paseo-server-browser.
// runtime-deps/package.json and runtime-deps/package-lock.json are copied there and installed with `npm ci`, so every host
// gets the same dependency tree. Packages come from the npm registry configured on this host, with install scripts disabled.
// Chromium itself is not downloaded.
import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime=process.env.PASEO_SERVER_BROWSER_RUNTIME||path.join(homedir(),'.local/share/paseo-server-browser');
const locked=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','runtime-deps');
const {dependencies}=JSON.parse(await readFile(path.join(locked,'package.json'),'utf8'));
console.log(`Runtime directory: ${runtime}`);
// The plugin loads code from this directory, so it must be a real directory owned by this user and closed to others (0700).
// The plugin refuses to start a browser from anything else.
async function checkRuntimeDirectory(fix){
 const info=await lstat(runtime).catch(error=>{if(error.code==='ENOENT'&&!fix)throw new Error(`${runtime} does not exist yet; run this script without --check to install the runtime.`);throw error;});
 if(info.isSymbolicLink()||!info.isDirectory())throw new Error(`${runtime} is not a real directory (it may be a symbolic link). Use a plain directory owned by this user.`);
 if(process.getuid&&info.uid!==process.getuid())throw new Error(`${runtime} belongs to another user. Use a directory owned by the user that runs the Paseo daemon.`);
 if((info.mode&0o777)===0o700)return;
 if(fix)await chmod(runtime,0o700);
 else console.log(`Note: ${runtime} has mode ${(info.mode&0o777).toString(8)}; the plugin sets it to 700 when it starts a browser.`);
}
if(!process.argv.includes('--check')){
 await mkdir(runtime,{recursive:true,mode:0o700});
 await checkRuntimeDirectory(true);
 // The shipped manifest replaces whatever package.json the runtime had; npm ci then installs exactly the shipped lockfile.
 for(const file of ['package.json','package-lock.json'])await writeFile(path.join(runtime,file),await readFile(path.join(locked,file)),{mode:0o600});
 const child=spawn('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 if(code!==0)throw new Error('Runtime dependency installation failed.');
}
else await checkRuntimeDirectory(false);
const load=createRequire(path.join(runtime,'package.json'));
for(const dependency of Object.keys(dependencies)){load.resolve(dependency);console.log(`${dependency}: available`);}
const {chromium}=load('playwright');
const exists=file=>access(file).then(()=>true,()=>false);
// Same table as headlessShellExecutable() in server/runtime.ts.
function headlessShell(){
 const shells={'linux-x64':'chrome-headless-shell-linux64/chrome-headless-shell','linux-arm64':'chrome-headless-shell-linux-arm64/chrome-headless-shell',
  'darwin-x64':'chrome-headless-shell-mac-x64/chrome-headless-shell','darwin-arm64':'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'win32-x64':'chrome-headless-shell-win64/chrome-headless-shell.exe','win32-arm64':'chrome-headless-shell-win64/chrome-headless-shell.exe'};
 return shells[`${process.platform}-${process.arch}`];
}
// Same lookup order as the plugin: an explicit executable, the newest cached headless shell, then Playwright's own build.
async function findChromium(){
 const configured=process.env.PASEO_SERVER_BROWSER_EXECUTABLE;
 if(configured)return await exists(configured)?`${configured} (PASEO_SERVER_BROWSER_EXECUTABLE)`:null;
 const cache=process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(homedir(),'.cache/ms-playwright');
 const shell=headlessShell(),builds=shell?(await readdir(cache).catch(()=>[])).filter(item=>/^chromium_headless_shell-\d+$/.test(item)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1))):[];
 for(const build of builds){const file=path.join(cache,build,shell);if(await exists(file))return file;}
 const own=chromium.executablePath();return await exists(own)?own:null;
}
const browser=await findChromium();
if(browser)console.log(`Chromium: ${browser}`);
else{
 console.log('Chromium: not found. Install Playwright\'s headless shell for this runtime, for example');
 console.log(`  node ${path.join(runtime,'node_modules/playwright/cli.js')} install chromium-headless-shell`);
 console.log('or set PASEO_SERVER_BROWSER_EXECUTABLE to an existing Chromium or Chrome.');
 process.exitCode=1;
}
console.log(`Optional: ${path.join(runtime,'lib')} is added to LD_LIBRARY_PATH and ${path.join(runtime,'fonts.conf')} is used as FONTCONFIG_FILE when present.`);
console.log('Use the plugin\'s page diagnostics to confirm that Chromium starts and renders fonts on this host.');
