import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { bridgeScript } from '../server/bridge-source';

// A stand-in for the Playwright MCP CLI: it only answers JSON-RPC requests, no browser involved.
const fakeMcp=`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fake',version:'1'},instructions:'fake child'}:{}})+'\\n');});`;

// The bridge only starts node_modules/@playwright/mcp/cli.js from its runtime directory, so the stand-in lives there.
async function fixture(state:Record<string,unknown>|null,mcpCli?:(root:string)=>string){
  const root=await mkdtemp(path.join(tmpdir(),'paseo-browser-bridge-'));
  const workspace=path.join(root,'workspace'),runtime=path.join(root,'runtime'),cli=path.join(runtime,'node_modules','@playwright','mcp','cli.js');
  await mkdir(workspace);await mkdir(path.dirname(cli),{recursive:true});
  await writeFile(path.join(root,'bridge.mjs'),bridgeScript(runtime));await writeFile(cli,fakeMcp);await writeFile(path.join(root,'elsewhere.mjs'),fakeMcp);
  if(state)await writeFile(path.join(workspace,'state.json'),JSON.stringify(state));
  const metadata=path.join(workspace,'session.json');
  const connect=()=>writeFile(metadata,JSON.stringify({version:2,workspaceId:'workspace',endpoint:'http://127.0.0.1:9',token:'test',cdpEndpoint:'http://127.0.0.1:9',mcpCli:mcpCli?mcpCli(root):cli,artifactDir:root,epoch:1}));
  return {root,metadata,connect};
}
async function initialize(root:string,metadata:string,env:Record<string,string>={}){
  const child=spawn(process.execPath,[path.join(root,'bridge.mjs'),metadata],{stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});
  const reply=new Promise<{result?:{instructions?:string};error?:{message:string}}>((resolve,reject)=>{
    createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(message.id===1)resolve(message);});
    child.once('exit',()=>reject(new Error('bridge exited before answering')));
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  try{return await reply;}
  finally{child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');clearTimeout(timer);}
}

test('MCP startup waits for a browser that is still being restored',{timeout:30000},async()=>{
  const {root,metadata,connect}=await fixture({version:2,desiredRunning:true,recoveryAttempts:[]});
  try{
    const connected=new Promise<void>(resolve=>setTimeout(()=>{void connect().then(resolve);},600));
    const reply=await initialize(root,metadata);await connected;
    assert.equal(reply.error,undefined);
    assert.match(reply.result?.instructions??'',/shared browser running on the Linux server[\s\S]*fake child/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('MCP startup fails at once with a readable message when the browser is meant to be stopped',{timeout:30000},async()=>{
  for(const state of [{version:2,desiredRunning:false},null,{version:2,desiredRunning:true,recoveryAttempts:[Date.now(),Date.now(),Date.now()]}]){
    const {root,metadata}=await fixture(state);
    try{
      const started=Date.now();const reply=await initialize(root,metadata);
      assert.match(reply.error?.message??'',/服务器浏览器尚未启动或正在恢复/);
      assert(Date.now()-started<10000,'no restoration wait for a stopped or exhausted browser');
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test('the startup wait is bounded',{timeout:30000},async()=>{
  const {root,metadata}=await fixture({version:2,desiredRunning:true,recoveryAttempts:[]});
  try{
    const reply=await initialize(root,metadata,{PASEO_SERVER_BROWSER_BRIDGE_WAIT_MS:'400'});
    assert.match(reply.error?.message??'',/服务器浏览器尚未启动或正在恢复/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('MCP startup refuses a Playwright MCP script outside the runtime directory',{timeout:30000},async()=>{
  for(const mcpCli of [(root:string)=>path.join(root,'elsewhere.mjs'),(root:string)=>`${root}/runtime/node_modules/@playwright/mcp/../../../../elsewhere.mjs`]){
    const {root,metadata,connect}=await fixture(null,mcpCli);
    try{
      await connect();
      const reply=await initialize(root,metadata);
      assert.match(reply.error?.message??'',/只能启动运行时目录里的 node_modules\/@playwright\/mcp\/cli\.js/);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
