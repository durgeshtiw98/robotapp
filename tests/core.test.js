import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, DOCK, clearPoint, clearSegment, planPath, planRoute, raycast, parseOdom, parseScan, validateConfig, normalizeConfig, validMission } from '../core.js';

test('planner routes around a blocking obstacle without cutting corners', () => {
  const start = {x:2.2,y:2.4}, goal = {x:6,y:2.4};
  assert.equal(clearSegment(start,goal),false);
  const path = planPath(start,goal);
  assert.ok(path && path.length > 1);
  let previous = start;
  for (const point of path) {
    assert.ok(clearSegment(previous,point),JSON.stringify({previous,point}));
    previous = point;
  }
  assert.deepEqual(path.at(-1),goal);
});

test('planner rejects occupied destinations and enforces configured boundary', () => {
  assert.equal(planPath({x:2,y:2},{x:4.4,y:2.4}),null);
  assert.equal(planPath({x:2,y:2},{x:.5,y:2},1),null);
  assert.equal(clearPoint({x:NaN,y:1}),false);
  assert.ok(planPath({x:2.2,y:2},DOCK,1));
});

test('multi-destination routes remain clear at every segment', () => {
  const start = {x:2.2,y:2};
  const goals = [{x:1.2,y:4.8},{x:8.8,y:4.8},{x:6,y:1.2},DOCK];
  const route = planRoute(start,goals,1);
  assert.ok(route?.length);
  let from = start;
  for (const to of route) { assert.ok(clearSegment(from,to,1)); from=to; }
  assert.deepEqual(route.at(-1),DOCK);
});

test('rays return nearest obstacle or arena wall', () => {
  assert.ok(Math.abs(raycast(2,2.4,0,20).distance-2)<.00001);
  assert.equal(raycast(2,2,Math.PI,20).distance,2);
  assert.equal(raycast(2,2,Math.PI/2,.5).distance,.5);
});

const odom = {
  pose:{pose:{position:{x:1,y:2},orientation:{x:0,y:0,z:0,w:1}}},
  twist:{twist:{linear:{x:.2},angular:{z:.1}}},
};
test('odometry validation rejects malformed messages and invalid quaternions', () => {
  assert.deepEqual(parseOdom(odom),{x:1,y:2,th:0,v:.2,w:.1});
  assert.equal(parseOdom({}),null);
  assert.equal(parseOdom({...odom,twist:{twist:{linear:{x:'1'},angular:{z:0}}}}),null);
  const zero = structuredClone(odom); zero.pose.pose.orientation.w=0;
  assert.equal(parseOdom(zero),null);
});

test('scan validation drops invalid ranges and caps visualization size', () => {
  const scan={angle_min:0,angle_increment:.1,range_min:.1,range_max:4,ranges:[null,NaN,-1,0,.5,5,2]};
  assert.deepEqual(parseScan(scan),[{angle:.4,distance:.5},{angle:.6000000000000001,distance:2}]);
  assert.equal(parseScan({ranges:[]}),null);
  assert.ok(parseScan({...scan,ranges:Array(10000).fill(1)}).length<=180);
});

test('connection settings reject insecure, duplicate, and invalid boundaries', () => {
  const c={...DEFAULTS,mode:'ws'};
  assert.equal(validateConfig(c),'');
  assert.ok(validateConfig(c,true).includes('wss'));
  assert.ok(validateConfig({...c,wsUrl:'javascript:alert(1)'}));
  assert.ok(validateConfig({...c,cameraUrl:'https://user:secret@robot.local/stream'}));
  assert.ok(validateConfig({...c,cmdTopic:'/odom'}));
  assert.ok(validateConfig({...c,timeout:NaN}));
  assert.equal(validateConfig({...c,scanTopic:'',imuTopic:'',diagnosticsTopic:'',batteryTopic:''}),'');
  assert.deepEqual(normalizeConfig({timeout:-1}),DEFAULTS);
});

test('saved mission validation rejects out-of-arena or unbounded records', () => {
  const m={id:'a',name:'My mission',points:[{x:2,y:2}]};
  assert.equal(validMission(m),true);
  assert.equal(validMission({...m,points:[{x:100,y:2}]}),false);
  assert.equal(validMission({...m,points:Array(501).fill({x:2,y:2})}),false);
});
