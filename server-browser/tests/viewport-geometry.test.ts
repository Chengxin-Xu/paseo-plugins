import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeViewportLayout, mapViewportPoint } from '../client/viewport-geometry';

const near = (actual:number, expected:number) => assert(Math.abs(actual-expected)<1e-8, `${actual} should be near ${expected}`);

test('viewport contains the full server frame, centers letterboxing and never enlarges pixels',()=>{
  const wide=computeViewportLayout({containerWidth:1000,containerHeight:500,frameWidth:1120,frameHeight:720});
  near(wide.imageHeight,500);
  near(wide.imageWidth,777.7777777777778);
  near(wide.offsetX,111.11111111111109);
  near(wide.offsetY,0);
  near(wide.imageWidth/wide.imageHeight,1120/720);
  const spacious=computeViewportLayout({containerWidth:1440,containerHeight:900,frameWidth:1120,frameHeight:720});
  assert.deepEqual(spacious,{imageWidth:1120,imageHeight:720,offsetX:160,offsetY:90,scale:1});
});

test('phone letterbox edges are inert and image coordinates map to the original viewport',()=>{
  const frame={frameWidth:1120,frameHeight:720};
  const layout=computeViewportLayout({containerWidth:320,containerHeight:390,...frame});
  near(layout.imageWidth,320);
  near(layout.imageHeight,205.71428571428572);
  near(layout.offsetY,92.14285714285714);
  assert.equal(mapViewportPoint({x:160,y:layout.offsetY-0.01},layout,frame),null);
  assert.equal(mapViewportPoint({x:160,y:layout.offsetY+layout.imageHeight},layout,frame),null);
  assert.equal(mapViewportPoint({x:-0.01,y:195},layout,frame),null);
  assert.equal(mapViewportPoint({x:320,y:195},layout,frame),null);
  assert.deepEqual(mapViewportPoint({x:layout.offsetX,y:layout.offsetY},layout,frame),{x:0,y:0});
  const center=mapViewportPoint({x:160,y:195},layout,frame)!;
  near(center.x,560);near(center.y,360);
  const lowerRight=mapViewportPoint({x:319.999,y:layout.offsetY+layout.imageHeight-0.001},layout,frame)!;
  assert(lowerRight.x<1120 && lowerRight.x>1119);
  assert(lowerRight.y<720 && lowerRight.y>719);
});

test('desktop and phone stage shapes preserve every visible corner through fractional coordinate mapping',()=>{
  for(const size of [{width:1121,height:635},{width:957,height:455},{width:390,height:646},{width:320,height:370},{width:844,height:220}]) {
    const frame={frameWidth:1120,frameHeight:720};
    const layout=computeViewportLayout({containerWidth:size.width,containerHeight:size.height,...frame});
    assert(layout.imageWidth<=size.width+1e-8 && layout.imageHeight<=size.height+1e-8);
    assert(layout.offsetX>=-1e-8 && layout.offsetY>=-1e-8);
    near(layout.imageWidth+2*layout.offsetX,size.width);
    near(layout.imageHeight+2*layout.offsetY,size.height);
    for(const expected of [{x:0,y:0},{x:0.25,y:0.75},{x:560.125,y:360.375},{x:1119.5,y:719.5}]) {
      const mapped=mapViewportPoint({x:layout.offsetX+expected.x*layout.scale,y:layout.offsetY+expected.y*layout.scale},layout,frame)!;
      assert(mapped);near(mapped.x,expected.x);near(mapped.y,expected.y);
    }
  }
});

test('invalid dimensions and nonfinite pointers cannot generate browser actions',()=>{
  const frame={frameWidth:1120,frameHeight:720};
  for(const invalid of [0,-1,NaN,Infinity,-Infinity]) {
    const invalidLayout=computeViewportLayout({containerWidth:invalid,containerHeight:500,...frame});
    assert.deepEqual(invalidLayout,{imageWidth:0,imageHeight:0,offsetX:0,offsetY:0,scale:0});
    assert.equal(mapViewportPoint({x:10,y:10},invalidLayout,frame),null);
  }
  const layout=computeViewportLayout({containerWidth:1000,containerHeight:500,...frame});
  for(const invalid of [NaN,Infinity,-Infinity]) {
    assert.equal(mapViewportPoint({x:invalid,y:200},layout,frame),null);
    assert.equal(mapViewportPoint({x:500,y:invalid},layout,frame),null);
  }
});
