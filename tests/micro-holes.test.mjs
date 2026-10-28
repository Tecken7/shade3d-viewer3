import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {closeBaseMicroHoles} from '../app/model-builder/micro-holes.mjs'
import {meshTopology} from '../app/model-builder/engine.mjs'

// Small non-planar contour, translated away from any original model coordinates.
const defect = [[0,0,0],[.044298457,-.033954838,-.052232828],[.074688451,-.038620074,-.05725188],[.086907982,-.012438615,-.092044806],[.108222358,-.001270275,-.091775664],[.124699534,-.007600822,-.074400368],[.177178657,-.03915307,0],[.14974088,-.042646877,-.004539906],[.147596839,-.010305574,.041029595],[.117543428,-.013071756,.032691793],[.076798285,-.03023531,.002101282],[.041760544,-.017463184,-.004754793]]
export function microSurface(scale=1, inverted=false) {
  const outer=[[-4,-4],[4,-4],[4,4],[-4,4]].map(p=>new THREE.Vector2(...p))
  const hole=defect.map(p=>new THREE.Vector2(p[0]*scale,p[2]*scale))
  const vertices=[...outer.flatMap(p=>[p.x,0,p.y]),...defect.flatMap(p=>p.map(x=>x*scale))]
  const faces=THREE.ShapeUtils.triangulateShape(outer,[hole]).flatMap(t=>inverted?[t[0],t[2],t[1]]:t)
  return {vertices,faces}
}

test('curved microhole closes without moving source vertices, original triangles or the main opening',()=>{
  for(const inverted of [false,true]) {
    const {vertices,faces}=microSurface(1,inverted),before=structuredClone({vertices,faces})
    const original=meshTopology(vertices,faces),result=closeBaseMicroHoles(vertices,faces,original.loops),after=meshTopology(vertices,result.faces)
    assert.equal(original.loops.length,2)
    assert.equal(result.closedMicroHoles,1)
    assert.equal(result.faces.length-faces.length,30)
    assert.equal(after.loops.length,1)
    assert.equal(after.nonManifold,0)
    assert.deepEqual(after.loops[0],original.loops[0])
    assert.deepEqual(result.faces.slice(0,faces.length),faces)
    assert.deepEqual({vertices,faces},before)
    assert.ok(result.microHoleArea<.04)
    assert.equal(closeBaseMicroHoles(vertices,result.faces,after.loops).closedMicroHoles,0)
  }
})

test('larger holes remain open and a single small main rim is never capped',()=>{
  const {vertices,faces}=microSurface(5),top=meshTopology(vertices,faces)
  const result=closeBaseMicroHoles(vertices,faces,top.loops)
  assert.equal(result.closedMicroHoles,0);assert.equal(result.faces,faces)
  const main=[0,0,0,.1,0,0,0,0,.1],triangle=[0,1,2]
  assert.equal(closeBaseMicroHoles(main,triangle,meshTopology(main,triangle).loops).closedMicroHoles,0)
})

test('an unconnected micro fragment is retained rather than closed as if it belonged to the scan',()=>{
  const vertices=[-4,0,-4,4,0,-4,4,0,4,-4,0,4,0,0,0,.05,0,0,0,0,.05],faces=[0,1,2,0,2,3,4,5,6]
  const result=closeBaseMicroHoles(vertices,faces,meshTopology(vertices,faces).loops)
  assert.equal(result.closedMicroHoles,0);assert.equal(result.faces,faces)
})

test('collinear microhole samples are preserved so the cap has no T-junctions',()=>{
  const ring=[[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0]]
  const vertices=[...ring.flatMap(p=>[p[0]*4,0,p[1]*4]),...ring.flatMap(p=>[p[0]*.05,0,p[1]*.05])],faces=[]
  for(let i=0;i<8;i++){const j=(i+1)%8;faces.push(i,j,j+8,i,j+8,i+8)}
  const result=closeBaseMicroHoles(vertices,faces,meshTopology(vertices,faces).loops),top=meshTopology(vertices,result.faces)
  assert.equal(result.closedMicroHoles,1);assert.equal(top.loops.length,1);assert.equal(top.nonManifold,0)
})

test('a self-crossing micro contour is not auto-filled',()=>{
  const vertices=[-4,0,-4,4,0,-4,4,0,4,-4,0,4,-.05,0,-.05,.05,0,.05,-.05,0,.05,.05,0,-.05],faces=[]
  for(let i=0;i<4;i++){const j=(i+1)%4;faces.push(i,j,j+4,i,j+4,i+4)}
  const result=closeBaseMicroHoles(vertices,faces,meshTopology(vertices,faces).loops)
  assert.equal(result.closedMicroHoles,0);assert.equal(result.faces,faces)
})

test('the base generator repairs microholes only with the reversible surface-repair option enabled',async()=>{
  const {default:Module}=await import('manifold-3d')
  const {default:fs}=await import('node:fs')
  const {buildModel}=await import('../app/model-builder/engine.mjs')
  const M=await Module();M.setup()
  const font=JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/font.json',import.meta.url)))
  const {vertices,faces}=microSurface(),positions=new Float32Array(faces.flatMap(id=>vertices.slice(id*3,id*3+3))),before=positions.slice()
  const options={arch:'upper',totalHeight:5,wall:1,bevel:.5,smoothing:0,rounding:0,holes:[{enabled:false},{enabled:false}]}
  await assert.rejects(buildModel(M,positions,options,font),/Opravit hranici a drobné otvory/)
  const result=await buildModel(M,positions,{...options,repairBoundary:true},font)
  const topology=meshTopology(Array.from(result.positions),Array.from(result.indices))
  assert.equal(result.stats.boundaryRepair.closedMicroHoles,1)
  assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
  assert.equal(result.stats.components,1)
  assert.deepEqual(positions,before)
})
