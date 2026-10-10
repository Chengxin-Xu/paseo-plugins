// Prepares the host runtime the plugin loads at run time. Run it yourself on the daemon host; Paseo never runs it.
//   node scripts/setup-runtime.mjs           install the locked runtime packages into the runtime directory, then check it
//   node scripts/setup-runtime.mjs --check   only check what is already there
// The runtime directory is $PASEO_SERVER_BROWSER_RUNTIME, by default ~/.local/share/paseo-server-browser.
// runtime-deps/package.json and runtime-deps/package-lock.json are copied there and installed with `npm ci`, so every host
// gets the same dependency tree. Packages come from the npm registry configured on this host, with install scripts disabled.
// Chromium itself is not downloaded.
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime=process.env.PASEO_SERVER_BROWSER_RUNTIME||path.join(homedir(),'.local/share/paseo-server-browser');
const locked=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','runtime-deps');
const {dependencies}=JSON.parse(await readFile(path.join(locked,'package.json'),'utf8'));
console.log(`Runtime directory: ${runtime}`);
if(!process.argv.includes('--check')){
 await mkdir(runtime,{recursive:true,mode:0o700});
 // The shipped manifest replaces whatever package.json the runtime had; npm ci then installs exactly the shipped lockfile.
 for(const file of ['package.json','package-lock.json'])await writeFile(path.join(runtime,file),await readFile(path.join(locked,file)),{mode:0o600});
 const child=spawn('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 if(code!==0)throw new Error('Runtime dependency installation failed.');
}
const load=createRequire(path.join(runtime,'package.json'));
for(const dependency of Object.keys(dependencies)){load.resolve(dependency);console.log(`${dependency}: available`);}
const {chromium}=load('playwright');
const exists=file=>access(file).then(()=>true,()=>false);
// Same lookup order as the plugin: an explicit executable, the newest cached headless shell, then Playwright's own build.
async function findChromium(){
 const configured=process.env.PASEO_SERVER_BROWSER_EXECUTABLE;
 if(configured)return await exists(configured)?`${configured} (PASEO_SERVER_BROWSER_EXECUTABLE)`:null;
 const cache=process.env.PLAYWRIGHT_BROWSERS_PATH||path.join(homedir(),'.cache/ms-playwright');
 const builds=(await readdir(cache).catch(()=>[])).filter(item=>/^chromium_headless_shell-\d+$/.test(item)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
 for(const build of builds){const file=path.join(cache,build,'chrome-headless-shell-linux64/chrome-headless-shell');if(await exists(file))return file;}
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
