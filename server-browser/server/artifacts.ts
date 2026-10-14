import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserSettings } from '../shared/browser';

export type ArtifactStats={bytes:number;count:number;cleaned:number};
/**
 * Every regular file directly in the browser's own artifacts/ directory is managed here: what Agent tools save there
 * (screenshots, snapshots, console logs, request and response parts) and what pages download while Playwright MCP is
 * attached, saved under the site's own file name. Links and subdirectories are never followed.
 */
export async function maintainArtifacts(directory:string,settings:BrowserSettings,cleanup=true,now=Date.now()):Promise<ArtifactStats>{
  const files:{file:string;size:number;mtime:number}[]=[];
  try{
    const root=await lstat(directory);if(!root.isDirectory()||root.isSymbolicLink())return {bytes:0,count:0,cleaned:0};
    for(const name of await readdir(directory)){
      const file=path.join(directory,name),info=await lstat(file).catch(()=>null);
      if(info?.isFile()&&!info.isSymbolicLink())files.push({file,size:info.size,mtime:info.mtimeMs});
    }
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {bytes:0,count:0,cleaned:0};throw error;}
  files.sort((a,b)=>b.mtime-a.mtime);
  let bytes=files.reduce((total,file)=>total+file.size,0),count=files.length,cleaned=0;
  if(cleanup){
    const newest=files[0]?.file;
    for(const item of [...files].reverse()){
      if(item.file===newest||now-item.mtime<5*60_000)continue;
      if(now-item.mtime<settings.artifactMaxAgeHours*3600_000&&bytes<=settings.maxArtifactMB*1024*1024)continue;
      // Never follow a replacement symlink, and never recurse into downloads or the profile.
      const current=await lstat(item.file).catch(()=>null);
      if(!current?.isFile()||current.isSymbolicLink()||current.mtimeMs!==item.mtime)continue;
      if(await unlink(item.file).then(()=>true,()=>false)){bytes-=item.size;count--;cleaned++;}
    }
  }
  return {bytes,count,cleaned};
}
