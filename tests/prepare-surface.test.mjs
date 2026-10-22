import test from 'node:test'
import assert from 'node:assert/strict'
import { indexed, meshTopology } from '../app/model-builder/engine.mjs'
import { prepareSurface } from '../app/model-builder/prepare-surface.mjs'

test('a reversed rim face is repaired without moving any vertices', () => {
  const vertices = [0,0,0, 1,0,0, 1,0,1, 0,0,1, .5,0,.5]
  const faces = [0,1,4, 1,2,4, 2,3,4, 3,4,0]
  assert.throws(() => meshTopology(vertices, faces), /větví/)
  const prepared = prepareSurface(vertices, faces)
  assert.equal(prepared.vertices, vertices)
  const topology = meshTopology(prepared.vertices, prepared.faces)
  assert.equal(topology.loops.length, 1)
  assert.equal(topology.nonManifold, 0)
})

test('duplicate faces are removed and a reversed first face does not reverse the rest of the scan', () => {
  const vertices = [0,0,0, 1,0,0, 1,0,1, 0,0,1, .5,0,.5]
  const original = [0,1,4, 1,2,4, 2,3,4, 3,0,4]
  const damaged = [0,4,1, ...original.slice(3), 0,1,4]
  const prepared = prepareSurface(vertices, damaged)
  assert.deepEqual(prepared.faces, original)
  assert.equal(meshTopology(vertices, prepared.faces).nonManifold, 0)
  assert.deepEqual(prepareSurface(vertices, prepared.faces), prepared)
})

test('exact indexing preserves distinct near-touching cut vertices', () => {
  // Two lobes connected by a very narrow strip: rounding pinches their rims.
  const vertices = [0,0,0, -1,0,-1, 1,0,-1, .000003,0,0, 1,0,1, -1,0,1]
  const points = [0,1,2, 0,2,3, 0,3,4, 0,4,5].flatMap(id => vertices.slice(id * 3, id * 3 + 3))
  const rounded = indexed(points), exact = indexed(points, { exact: true })
  assert.equal(rounded.vertices.length / 3, 5)
  assert.equal(exact.vertices.length / 3, 6)
  assert.throws(() => meshTopology(rounded.vertices, rounded.faces), /větví/)
  assert.equal(meshTopology(exact.vertices, exact.faces).loops.length, 1)
})

test('genuine branching is not hidden by the winding repair', () => {
  const vertices = [0,0,0, 1,0,0, 0,0,1, -1,0,0, 0,0,-1]
  const prepared = prepareSurface(vertices, [0,1,2, 0,3,4])
  assert.throws(() => meshTopology(vertices, prepared.faces), /větví/)
})

test('every combination of inverted faces on a curved open scan is normalized without changing its shape', () => {
  const vertices=[]
  for(let z=0;z<3;z++)for(let x=0;x<3;x++){
    // Curved and tilted: orientation must follow shared edges, not a fixed axis.
    vertices.push(x*.7+z*.3, x*x*.2+z*.4, z*.9-x*.1)
  }
  const original=[]
  for(let z=0;z<2;z++)for(let x=0;x<2;x++){
    const a=z*3+x;original.push(a,a+1,a+4,a,a+4,a+3)
  }
  for(let mask=0;mask<256;mask++){
    const damaged=original.slice()
    for(let face=0;face<8;face++)if(mask&(1<<face)){
      const offset=face*3;[damaged[offset+1],damaged[offset+2]]=[damaged[offset+2],damaged[offset+1]]
    }
    const prepared=prepareSurface(vertices,damaged)
    const topology=meshTopology(prepared.vertices,prepared.faces)
    assert.equal(topology.nonManifold,0,`mask ${mask}`)
    assert.equal(topology.loops.length,1,`mask ${mask}`)
    assert.equal(topology.openEdges,8,`mask ${mask}`)
    assert.equal(prepared.vertices,vertices)
    assert.deepEqual(prepared.faces.slice().sort((a,b)=>a-b),original.slice().sort((a,b)=>a-b))
    assert.deepEqual(prepareSurface(vertices,prepared.faces).faces,prepared.faces)
  }
})

test('all inverted-face combinations on a closed surface remain closed after preparation',()=>{
  const vertices=[0,0,0, 2,0,0, 0,2,0, 0,0,2],original=[0,2,1, 0,1,3, 1,2,3, 2,0,3]
  for(let mask=0;mask<16;mask++){
    const faces=original.slice()
    for(let face=0;face<4;face++)if(mask&(1<<face)){
      const offset=face*3;[faces[offset+1],faces[offset+2]]=[faces[offset+2],faces[offset+1]]
    }
    const prepared=prepareSurface(vertices,faces),topology=meshTopology(vertices,prepared.faces)
    assert.equal(topology.openEdges,0)
    assert.equal(topology.nonManifold,0)
  }
})

test('a non-orientable strip is rejected instead of silently changing connectivity',()=>{
  const vertices=[],faces=[],count=5
  for(let i=0;i<count;i++){
    const t=2*Math.PI*i/count
    for(const w of [-.2,.2])vertices.push((1+w*Math.cos(t/2))*Math.cos(t),w*Math.sin(t/2),(1+w*Math.cos(t/2))*Math.sin(t))
    const a=2*i,b=a+1,nextA=i===count-1?1:a+2,nextB=i===count-1?0:a+3
    faces.push(a,nextA,nextB,a,nextB,b)
  }
  const before=faces.slice()
  assert.throws(()=>prepareSurface(vertices,faces),/překřížené napojení/)
  assert.deepEqual(faces,before)
})
