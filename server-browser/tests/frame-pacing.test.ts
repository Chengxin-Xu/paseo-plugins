import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOW_FRAME_MS, effectiveQuality, frameDelay, frameLimits, initialPacing, recordFrame, type FramePacing } from '../client/frame-pacing';
import { deviceOpenableUrl } from '../client/local-open';
import { isForeground, mergeOverview, overviewRequest, staleDelay, type OverviewData } from '../client/overview-model';
import { frameScale } from '../server/frame';
import type { BrowserOverviewItem } from '../shared/browser';

const run=(samples:{latency:number;changed:boolean;failed?:boolean}[],start:FramePacing=initialPacing)=>samples.reduce((pacing,sample,index)=>recordFrame(pacing,{requestedAt:index*1000,...sample}),start);

test('viewers request only the device pixels their stage shows, capped at 2x',()=>{
  assert.deepEqual(frameLimits({width:390,height:600},3),{maxWidth:780,maxHeight:1200},'a 3x phone is served at 2x');
  assert.deepEqual(frameLimits({width:1000.4,height:560},1),{maxWidth:1001,maxHeight:560});
  assert.deepEqual(frameLimits({width:390,height:600},0.5),{maxWidth:390,maxHeight:600},'never below 1 device pixel per point');
  assert.equal(frameLimits({width:0,height:0},2),undefined,'hidden or unmeasured stages send no budget');
  assert.equal(frameLimits({width:390,height:600},Number.NaN)?.maxWidth,390);
});

test('the server fits the viewport into the budget in 1/8 steps without enlarging',()=>{
  // Desktop-sized page on a phone: 780x1200 device pixels for a 1120x720 viewport.
  assert.equal(frameScale({width:1120,height:720},{maxWidth:780,maxHeight:1200}),0.75);
  assert.equal(frameScale({width:1440,height:900},{maxWidth:780,maxHeight:1200}),0.625);
  assert.equal(frameScale({width:390,height:760},{maxWidth:780,maxHeight:1200}),1,'a phone-sized page is never enlarged');
  assert.equal(frameScale({width:1120,height:720}),1,'no budget keeps full resolution');
  assert.equal(frameScale({width:1120,height:720},{maxWidth:1000}),1,'within one step of full size stays full size');
  assert.equal(frameScale({width:2560,height:1600},{maxWidth:64,maxHeight:64}),0.25,'never below a quarter');
  assert.equal(frameScale({width:0,height:0},{maxWidth:780}),1);
});

test('slow changed frames lower the requested quality one step at a time and quick ones restore it',()=>{
  const slow=SLOW_FRAME_MS+1;
  let pacing=run([{latency:slow,changed:true}]);
  assert.equal(pacing.degrade,1);assert.equal(effectiveQuality('sharp',pacing),'balanced');
  pacing=run([{latency:slow,changed:true},{latency:slow,changed:true}],pacing);
  assert.equal(effectiveQuality('sharp',pacing),'smooth','never below the lowest quality');
  assert.equal(effectiveQuality('balanced',pacing),'smooth');
  pacing=run([{latency:slow,changed:false},{latency:slow,changed:false}],pacing);
  assert.equal(pacing.degrade,2,'slow unchanged polls do not count as frame transfers');
  pacing=run([{latency:100,changed:true},{latency:100,changed:true},{latency:100,changed:true}],pacing);
  assert.equal(pacing.degrade,2);
  pacing=run([{latency:100,changed:true}],pacing);
  assert.equal(pacing.degrade,1,'four quick frames restore one step');
  pacing=run([{latency:100,changed:true},{latency:900,changed:true},{latency:100,changed:true},{latency:100,changed:true},{latency:100,changed:true}],pacing);
  assert.equal(pacing.degrade,1,'a middling frame resets the streak');
  pacing=run([{latency:100,changed:true}],pacing);
  assert.equal(effectiveQuality('sharp',pacing),'sharp');
});

test('poll delay keeps the chosen cadence, backs off while idle and never outruns the link',()=>{
  assert.equal(frameDelay(initialPacing,'sharp'),1200);
  assert.equal(frameDelay(initialPacing,'smooth'),250);
  assert.equal(frameDelay({duration:900,unchanged:0},'smooth'),1800,'frames wait for twice the observed round trip');
  const idle=[0,1,2,3,4,5,9,20].map(unchanged=>frameDelay({duration:40,unchanged},'sharp'));
  assert.deepEqual(idle,[1200,1200,1800,2400,3000,3600,6000,6000]);
  assert.equal(frameDelay({duration:3000,unchanged:20},'sharp'),8000,'idle backoff is capped at 8 s');
  assert.equal(frameDelay({duration:3000,unchanged:20},'sharp',true),1000,'recovery is watched every second');
  const failed=run([{latency:30000,changed:false,failed:true}]);
  assert.equal(failed.unchanged,3,'a failed poll backs off like an idle page');
});

test('an unchanged overview keeps the rendered items and their identity',()=>{
  const items=[{workspace:{id:'one',title:'One',cwd:'/one'},observedAt:1}] as unknown as BrowserOverviewItem[];
  const previous:OverviewData={items,checkedAt:1,revision:'r1'};
  assert.deepEqual(overviewRequest(undefined),{});
  assert.deepEqual(overviewRequest(previous),{revision:'r1'});
  const kept=mergeOverview(previous,{unchanged:true,revision:'r1',checkedAt:2});
  assert.equal(kept.items,items,'same array: memoized tab groups are not rebuilt');
  assert.equal(kept.checkedAt,2);assert.equal(kept.revision,'r1');
  const changed=mergeOverview(previous,{items:[],revision:'r2',checkedAt:3});
  assert.deepEqual(changed,{items:[],checkedAt:3,revision:'r2'});
  assert.deepEqual(mergeOverview(undefined,{unchanged:true,revision:'r1',checkedAt:4}),{items:[],checkedAt:4},'an unexpected short answer never keeps a revision');
  assert.equal(staleDelay(1_000,5_000),8_000);assert.equal(staleDelay(1_000,20_000),0);
});

test('only a foreground app polls; iOS inactive counts as hidden',()=>{
  assert.equal(isForeground('active'),true);
  assert.equal(isForeground(null),true);assert.equal(isForeground('unknown'),true);
  assert.equal(isForeground('inactive'),false);assert.equal(isForeground('background'),false);
});

test('pages opened on the viewer device are plain HTTP(S) URLs without credentials',()=>{
  assert.equal(deviceOpenableUrl('https://example.com/docs?q=1#top'),'https://example.com/docs?q=1#top');
  assert.equal(deviceOpenableUrl('http://user:secret@example.com/'),'http://example.com/');
  for(const value of ['about:blank','file:///etc/passwd','javascript:alert(1)','','not a url',null,undefined])assert.equal(deviceOpenableUrl(value),null);
});
