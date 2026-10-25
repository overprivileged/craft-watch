import test from 'node:test';
import assert from 'node:assert/strict';
import { laneYAt, connectorPoints, followLanePath } from '../site/connector-path.js';
import { normalizeAppearance } from '../site/appearance.js';
const lane = Array.from({length:101},(_,i)=>({x:i*10,y:80*Math.sin(i/100*Math.PI/2)}));
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('follow-lane connectors retain exact endpoints and keep time monotonic',()=>{
  const from={x:103.2,y:laneYAt(lane,103.2)-18},to={x:974.7,y:laneYAt(lane,974.7)+18};
  for(const strength of [0,1,3]) {
    const points=connectorPoints(lane,from,to,strength);
    assert.deepEqual(points[0],from); assert.deepEqual(points.at(-1),to);
    points.forEach((p,i)=>{
      if(i) assert.ok(p.x>points[i-1].x);
      assert.ok(Math.abs(p.y-laneYAt(lane,p.x))<=18+1e-8);
    });
    const path=followLanePath(lane,from,to,strength);
    assert.ok(path.startsWith(`M${from.x},${from.y} C`));
    assert.ok(path.endsWith(`${to.x},${to.y}`));
    assert.ok(!/NaN|Infinity/.test(path));
  }
});
test('opposite offsets cross at midpoint and are symmetric relative to curved lane',()=>{
  const points=connectorPoints(lane,{x:100,y:laneYAt(lane,100)-20},{x:900,y:laneYAt(lane,900)+20},1);
  const middle=points[(points.length-1)/2]; near(middle.x,500);near(middle.y,laneYAt(lane,500));
  points.forEach((p,i)=>{const q=points.at(-1-i);near(p.y-laneYAt(lane,p.x),-(q.y-laneYAt(lane,q.x)));});
});
test('same-side connectors follow the lane without an invented crossing; equal-time endpoints stay finite',()=>{
  const points=connectorPoints(lane,{x:0,y:12},{x:1000,y:92},2);
  points.forEach(p=>near(p.y-laneYAt(lane,p.x),12));
  assert.equal(followLanePath(lane,{x:500,y:20},{x:500,y:40}), 'M500,20 L500,40');
});
test('bend strength preserves endpoints while adjusting the middle transition; preferences validate',()=>{
  const from={x:0,y:-20},to={x:1000,y:100};
  const mild=connectorPoints(lane,from,to,0),strong=connectorPoints(lane,from,to,3);
  const i=Math.floor(mild.length/4);
  assert.ok(strong[i].y<mild[i].y);
  assert.equal(normalizeAppearance({arcs:{connectorShape:'follow',bend:0}}).arcs.bend,0);
  assert.equal(normalizeAppearance({arcs:{connectorShape:'bad',bend:-2}}).arcs.connectorShape,'straight');
  assert.equal(normalizeAppearance({arcs:{bend:Infinity}}).arcs.bend,1);
});
