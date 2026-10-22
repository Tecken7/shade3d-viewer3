import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'manifold-3d'
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { collectTrianglesInRoot } from '../app/model-builder/scene-input.mjs'
import { roundShoulder } from '../app/model-builder/transition.mjs'
import { drainPassage } from '../app/model-builder/drains.mjs'
import { prepareRepairVertices, weldByDistance } from '../app/model-builder/mesh-preflight.mjs'
import { orientRepairPatch } from '../app/model-builder/repair-orientation.mjs'
import { buildModel, meshTopology, indexed } from '../app/model-builder/engine.mjs'
import { holeDirection } from '../app/model-builder/hole-placement.mjs'
const M=await Module();M.setup()
const font=JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/font.json',import.meta.url)))
const contour=[[-20,-15],[-8,-15],[-8,4],[-5,9],[5,9],[8,4],[8,-15],[20,-15],[20,6],[13,18],[-13,18],[-20,6]].map(p=>new THREE.Vector2(...p))
const scan=[]
for(const tri of THREE.ShapeUtils.triangulateShape(contour,[])){
 const vs=tri.map(i=>[contour[i].x,0,contour[i].y]);const [a,b,c]=vs.map(p=>new THREE.Vector3(...p));if(b.sub(a).cross(c.sub(a)).y>0)vs.reverse();scan.push(...vs.flat())
}
const build=opts=>buildModel(M,new Float32Array(scan),{arch:'upper',smoothing:0,...opts},font)
let baseline
test('base generation accepts reversed cut faces and duplicates without changing the resulting solid', async () => {
  const options = { arch:'upper', smoothing:0, holes:[{enabled:false},{enabled:false}] }
  const reference = await buildModel(M, new Float32Array(scan), options, font)
  const damaged = scan.slice()
  for (let i = 0; i < damaged.length; i += 27) {
    const b = damaged.slice(i + 3, i + 6), c = damaged.slice(i + 6, i + 9)
    if (c.length === 3) damaged.splice(i + 3, 6, ...c, ...b)
  }
  damaged.push(...scan.slice(0,9))
  const result = await buildModel(M, new Float32Array(damaged), options, font)
  assert.ok(Math.abs(result.stats.volume - reference.stats.volume) < 0.001)
  assert.equal(meshTopology(Array.from(result.positions), Array.from(result.indices)).nonManifold, 0)
})
function bvh(out){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(out.positions,3));g.setIndex(new THREE.BufferAttribute(out.indices,1));return new MeshBVH(g)}
test('open hollow horseshoe: requested height, unchanged outer footprint, wall thickness, manifold topology',async()=>{
 baseline=await build({holes:[{enabled:false},{enabled:false}]})
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(baseline.positions,3));g.computeBoundingBox();const box=g.boundingBox
 assert.ok(Math.abs(box.max.y-box.min.y-25)<0.001)
 assert.ok(box.min.x>=-20.001&&box.max.x<=20.001)
 assert.equal(baseline.stats.components,1)
 const t=meshTopology(Array.from(baseline.positions),Array.from(baseline.indices));assert.equal(t.openEdges,0);assert.equal(t.nonManifold,0)
 const tree=bvh(baseline)
 const side=tree.raycast(new THREE.Ray(new THREE.Vector3(-30,12,0),new THREE.Vector3(1,0,0)),THREE.DoubleSide).sort((a,b)=>a.distance-b.distance)
 const xs=[...new Set(side.map(h=>h.point.x.toFixed(2)))].map(Number)
 assert.ok(Math.abs(xs[0]+20)<0.01);assert.ok(Math.abs(xs[1]+17.5)<0.1)
 const roof=tree.raycastFirst(new THREE.Ray(new THREE.Vector3(-14,30,0),new THREE.Vector3(0,-1,0)),THREE.DoubleSide)
 assert.ok(Math.abs(roof.point.y-2.5)<0.1,'no bottom lid; first surface is the inner roof')
 const chamfer=tree.raycastFirst(new THREE.Ray(new THREE.Vector3(-19.5,30,0),new THREE.Vector3(0,-1,0)),THREE.DoubleSide);assert.ok(Math.abs(chamfer.point.y-24.5)<0.05,'the exported bevel follows a 45 degree surface, not just smooth shading')
})

test('base cap follows wall winding for globally inverted upper and lower scans', async () => {
  const inverted=scan.slice()
  for(let i=0;i<inverted.length;i+=9){
    const b=inverted.slice(i+3,i+6),c=inverted.slice(i+6,i+9)
    inverted.splice(i+3,6,...c,...b)
  }
  for(const [arch,bevel] of [['upper',1],['lower',1],['upper',0],['lower',0]]){
    const options={arch,bevel,smoothing:0,cutHoles:false,holes:[{enabled:false},{enabled:false}]}
    const reference=await buildModel(M,new Float32Array(scan),options,font)
    const result=await buildModel(M,new Float32Array(inverted),options,font)
    // Reversing the contour can choose different loft diagonals and sampled
    // cavity cells. Require the same volume within 0.1%, not identical floats.
    assert.ok(Math.abs(result.stats.volume-reference.stats.volume)/reference.stats.volume<.001,`${arch}: winding must preserve the base volume`)
    const topology=meshTopology(Array.from(result.positions),Array.from(result.indices))
    assert.equal(topology.nonManifold,0)
    assert.equal(topology.openEdges,0)
    assert.equal(result.stats.components,1)
  }
})
test('two independent vent cutters remove material and preserve a single closed mesh',async()=>{
 const out=await build({});assert.equal(out.holes.length,2);assert.ok(out.holes.every(h=>h.enabled&&h.diameter===4.5));assert.deepEqual(out.holes[0].normal,out.holes[1].normal);assert.ok(out.holes.every(h=>(h.baseY-h.position[1])*h.baseDirection<h.diameter/2),'cuts cross the beveled bottom rim');assert.ok(out.stats.volume<baseline.stats.volume)
 const changed=out.holes.map((h,i)=>({...h,diameter:i===0?6:4.5,length:i===0?10:8,autoDepth:false}))
 const edited=await build({holes:changed});assert.equal(edited.holes[0].diameter,6);assert.equal(edited.holes[1].diameter,4.5);assert.ok(edited.stats.volume<out.stats.volume)
})

test('automatic drains extend a blind cut while manual depth reports the obstruction',async()=>{
 const defaults=await build({})
 const short=defaults.holes.map(h=>({...h,length:0.6,autoDepth:false}))
 const manual=await build({holes:short});assert.ok(manual.holes.every(h=>!h.through))
 const automatic=await build({holes:short.map(h=>({...h,autoDepth:true}))})
 assert.ok(automatic.holes.every(h=>h.through&&h.length>0.6));assert.ok(automatic.stats.volume<manual.stats.volume)
})

test('drain clearance detects a blocked crescent even when the centre line is clear',()=>{
 const geometry=new THREE.BoxGeometry(12,12,8).toNonIndexed(),positions=geometry.attributes.position
 for(let i=0;i<positions.count;i++)if(positions.getZ(i)<0)positions.setZ(i,positions.getZ(i)-positions.getX(i)*0.7)
 geometry.translate(0,0,-4);geometry.computeVertexNormals()
 const tree=new MeshBVH(geometry),clearance=drainPassage(tree,new THREE.Vector3(),new THREE.Vector3(0,0,1),2.25,50)
 assert.ok(clearance.requiredLength>9.8&&clearance.requiredLength<10,'8 mm clears the centre but not the disk edge')
 assert.ok(clearance.intersectingRays>300);geometry.dispose()
})

test('failed automatic drain leaves a valid preview and can be placed manually afterwards', async () => {
  const defaults = await build({})
  const valid = { ...defaults.holes[0], enabled: true }
  const failed = { ...defaults.holes[1], enabled: true, autoPosition: true, position: [1000, 1000, 1000] }
  const expected = await build({ holes: [valid, { ...failed, enabled: false }] })
  const fallback = await build({ holes: [valid, failed] })
  assert.equal(fallback.holes[0].enabled, true)
  assert.equal(fallback.holes[1].enabled, false)
  assert.equal(fallback.warnings.length, 1)
  assert.match(fallback.warnings[0], /ručně/)
  assert.ok(Math.abs(fallback.stats.volume - expected.stats.volume) < 0.001, 'failed cutter must not remove any material')
  const topology = meshTopology(Array.from(fallback.positions), Array.from(fallback.indices))
  assert.equal(topology.nonManifold, 0)
  assert.equal(topology.openEdges, 0)
  const manual = { ...fallback.holes[1], ...defaults.holes[1], enabled: true, autoPosition: false, warning: null }
  const repaired = await build({ holes: [valid, manual] })
  assert.equal(repaired.warnings.length, 0)
  assert.equal(repaired.holes[1].through, true)
  assert.ok(repaired.stats.volume < fallback.stats.volume)
  await assert.rejects(() => build({ holes: [{ ...failed, autoPosition: false }] }), /Otvor 1/)
})

test('blue cylinder drafts leave the base intact until explicit confirmation', async () => {
  const draft = await build({ cutHoles:false, followContour:true })
  assert.equal(draft.holes.length, 2)
  assert.ok(draft.holes.every(hole => hole.length===5 && hole.outerLength===3))
  assert.ok(draft.holes.every(hole => hole.enabled && Math.abs(hole.position[1]-(draft.placement.baseY-draft.placement.direction*0.5))<1e-8))
  const without = await build({ holes:[{enabled:false}, {enabled:false}] })
  assert.ok(Math.abs(draft.stats.volume - without.stats.volume) < .001)
  const changed = draft.holes.map((hole,i) => ({ ...hole, diameter:3, length:12, autoDepth:false, yaw:i?8:-8 }))
  const beforeConfirmation = await build({ cutHoles:false, followContour:true, holes:changed })
  assert.ok(Math.abs(beforeConfirmation.stats.volume - without.stats.volume) < .001)
  const confirmed = await build({ cutHoles:true, followContour:true, holes:beforeConfirmation.holes })
  for(const hole of confirmed.holes) assert.deepEqual(hole.normal,holeDirection(confirmed.placement.bottomContour,hole.position,hole.yaw))
  assert.ok(confirmed.stats.volume < beforeConfirmation.stats.volume)
  const topology = meshTopology(Array.from(confirmed.positions), Array.from(confirmed.indices))
  assert.equal(topology.nonManifold, 0)
  assert.equal(topology.openEdges, 0)
})
test('embossed and engraved Czech text modify the exported solid in opposite directions',async()=>{
 const params={holes:[{enabled:false},{enabled:false}],text:'Žluť',textSize:2.5,textDepth:0.5,textPosition:[-20,12,0],textNormal:[-1,0,0]}
 const embossed=await build({...params,textMode:'emboss'});const engraved=await build({...params,textMode:'engrave'})
 assert.ok(embossed.stats.volume>baseline.stats.volume);assert.ok(engraved.stats.volume<baseline.stats.volume)
 assert.equal(embossed.stats.components,1);assert.equal(engraved.stats.components,1)
 const minX=Math.min(...embossed.positions.filter((_,i)=>i%3===0));assert.ok(Math.abs(minX+20.5)<0.01)
})
test('invalid dimensions and floating text fail instead of exporting stale or invalid geometry',async()=>{
 await assert.rejects(build({totalHeight:0}),/výška/)
 await assert.rejects(build({wall:-1}),/tloušťka/)
 await assert.rejects(build({text:'TEST'}),/umístěte/)
 await assert.rejects(build({text:'TEST',textPosition:[-80,12,0],textNormal:[-1,0,0]}),/stěně/)
})

test('margin smoothing rounds the edge without changing total height or expanding the base',async()=>{
 const smooth=await build({smoothing:0.8,holes:[{enabled:false},{enabled:false}]});
 assert.ok(smooth.stats.volume<baseline.stats.volume);
 const g=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(smooth.positions,3));g.computeBoundingBox();
 assert.ok(g.boundingBox.min.x>=-20.001&&g.boundingBox.max.x<=20.001);assert.ok(Math.abs(g.boundingBox.max.y-g.boundingBox.min.y-25)<0.001);
})

test('STL round trip retains a closed shell and the requested height',()=>{
 const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(baseline.positions,3));geometry.setIndex(new THREE.BufferAttribute(baseline.indices,1));
 const binary=new STLExporter().parse(new THREE.Mesh(geometry),{binary:true});
 const imported=new STLLoader().parse(binary.buffer);imported.computeBoundingBox();
 const m=indexed(imported.attributes.position.array),t=meshTopology(m.vertices,m.faces);
 assert.equal(t.openEdges,0);assert.equal(t.nonManifold,0);assert.ok(Math.abs(imported.boundingBox.max.y-imported.boundingBox.min.y-25)<0.001);
})

test('a repeated preview keeps the same input coordinates after the hidden source detaches',()=>{
 const root=new THREE.Group();root.position.set(14,-18,7);root.rotation.set(0.2,-0.3,0.1);
 const source=new THREE.Group();source.position.set(2,3,-4);source.rotation.set(-0.2,0.1,0.3);
 source.add(new THREE.Mesh(new THREE.BoxGeometry(4,6,8)));root.add(source);
 const attached=collectTrianglesInRoot(source,root);root.remove(source);const detached=collectTrianglesInRoot(source,root);
 assert.equal(attached.length,detached.length);attached.forEach((value,i)=>assert.ok(Math.abs(value-detached[i])<1e-9));
})

test('rounded shoulder changes the actual corner while preserving the scan outside its band',()=>{
 const v=[],f=[],boundary=[],weights=new Map(),cols=17,rows=21
 // A sloping scan joins a vertical wall. Regular sampling makes displacement
 // measurable independently of normals used to display the finished mesh.
 for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
  const t=(row-10)*0.3,z=(col-8)*0.3,id=v.length/3
  v.push(t<0?t:0,t<0?t*0.15:t,z)
  if(row===10)boundary.push([0,0,z])
  if(row>10)weights.set(id,Math.max(0,1-t/2.25)**2)
 }
 for(let row=0;row<rows-1;row++)for(let col=0;col<cols-1;col++){
  const a=row*cols+col,b=a+1,c=a+cols,d=c+1;f.push(a,c,b,b,c,d)
 }
 const original=v.slice(),corner=(10*cols+8)*3
 roundShoulder(v,f,boundary,weights,11*cols,1.5,-0.45)
 assert.ok(v[corner]<-0.08&&v[corner+1]>0.08,'the corner is physically rounded inward')
 for(let id=0;id<5*cols;id++)assert.deepEqual(v.slice(id*3,id*3+3),original.slice(id*3,id*3+3),'distant anatomy stays exact')
 for(let id=19*cols;id<rows*cols;id++)assert.deepEqual(v.slice(id*3,id*3+3),original.slice(id*3,id*3+3),'lower wall stays fixed')
 const untouched=original.slice();roundShoulder(untouched,f,boundary,weights,11*cols,0,-0.45);assert.deepEqual(untouched,original)
})

test('repair preflight joins split seams, preserves colour/UV attributes and is idempotent',()=>{
 const geometry=new THREE.BoxGeometry(10,10,10).toNonIndexed(),position=geometry.attributes.position
 const colors=new Float32Array(position.count*3);colors.forEach((_,i)=>{colors[i]=(i%7)/7});geometry.setAttribute('color',new THREE.BufferAttribute(colors,3))
 for(let i=0;i<position.count;i++)position.setX(i,position.getX(i)+(Math.floor(i/6)%3)*0.001)
 const beforeUv=Array.from(geometry.attributes.uv.array),beforeColor=Array.from(colors)
 const root=new THREE.Group(),mesh=new THREE.Mesh(geometry);root.add(mesh)
 const result=prepareRepairVertices(root);assert.ok(result.stats.moved>0);assert.ok(result.stats.maxDisplacement<=0.005);assert.equal(result.backup.length,1)
 assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array),beforeUv);assert.deepEqual(Array.from(mesh.geometry.attributes.color.array),beforeColor)
 const expanded=mesh.geometry.toNonIndexed(),m=indexed(expanded.attributes.position.array),topology=meshTopology(m.vertices,m.faces)
 assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
 assert.equal(prepareRepairVertices(root).backup.length,0)
 assert.equal(result.backup[0].geometry,geometry)
})

test('merge-by-distance crosses hash-cell borders without merging beyond the requested distance',()=>{
 const result=weldByDistance([0.0049,0,0,0.0051,0,0,0.02,0,0],[],0.005)
 assert.equal(result.ids[0],result.ids[1]);assert.notEqual(result.ids[0],result.ids[2])
})

test('preflight rejects a collapse that would open a thin closed solid',()=>{
 assert.throws(()=>weldByDistance([0,0,0,0.001,0,0,0,1,0,0,0,1],[0,2,1,0,1,3,0,3,2,1,2,3]),/Původní scan/)
})

test('preflight uses the authoritative mesh rather than its shading copy',()=>{
 const base=new THREE.BoxGeometry(10,10,10).toNonIndexed(),p=base.attributes.position
 for(let i=0;i<p.count;i++)p.setX(i,p.getX(i)+(Math.floor(i/6)%3)*0.001)
 const display=base.clone();display.translate(100,0,0)
 const mesh=new THREE.Mesh(display);mesh.userData._baseGeom=base
 const prepared=prepareRepairVertices(mesh)
 assert.ok(prepared.stats.moved>0);assert.equal(prepared.backup[0].geometry,display)
 assert.ok(mesh.geometry.boundingBox.max.x<6,'shading coordinates cannot replace the authoritative scan')
 assert.equal(prepared.backup[0].baseGeom,base)
})

test('browser BVH creation preserves triangle order before CGAL repair',()=>{
 const previous=THREE.BufferGeometry.prototype.computeBoundsTree
 THREE.BufferGeometry.prototype.computeBoundsTree=function(options){this.boundsTree=new MeshBVH(this,options)}
 try{
  const geometry=new THREE.BoxGeometry(10,10,10).toNonIndexed(),p=geometry.attributes.position
  for(let i=0;i<p.count;i++)p.setX(i,p.getX(i)+(Math.floor(i/6)%3)*0.001)
  const mesh=new THREE.Mesh(geometry);prepareRepairVertices(mesh)
  assert.deepEqual(Array.from(mesh.geometry.index.array),Array.from({length:p.count},(_,i)=>i))
  assert.ok(mesh.geometry.boundsTree)
 }finally{
  if(previous)THREE.BufferGeometry.prototype.computeBoundsTree=previous
  else delete THREE.BufferGeometry.prototype.computeBoundsTree
 }
})

test('repair winding follows shared scan edges for correct, inverted and mixed patches',()=>{
 const source=[[0,1,4],[1,2,5],[2,3,6],[3,0,7]],boundary=[0,1,2,3],origins=[0,1,2,3]
 const correct=[0,3,2,0,2,1]
 const good=orientRepairPatch(source,boundary,correct,origins,boundary)
 assert.equal(good.flippedFaces,0);assert.equal(good.matchedEdges,4)
 const inverted=orientRepairPatch(source,boundary,[0,2,3,0,1,2],origins,boundary)
 assert.equal(inverted.flippedFaces,2);assert.deepEqual(Array.from(inverted.triangles),correct)
 const mixed=orientRepairPatch(source,boundary,[0,3,2,0,1,2],origins,boundary)
 assert.equal(mixed.flippedFaces,1);assert.deepEqual(Array.from(mixed.triangles),correct)
 assert.throws(()=>orientRepairPatch(source,boundary,[0,3,2],origins,boundary),/Okraj|okraj/)
})

test('patch shading normals follow winding even when the boundary average points backwards',()=>{
 const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8')
 const start=source.indexOf('function buildCGALPatchVertexNormals('),end=source.indexOf('function buildCGALRepairPatchData(',start)
 const normals=new Function('THREE','repairAverageBoundaryNormal',source.slice(start,end)+';return buildCGALPatchVertexNormals')(THREE,()=>new THREE.Vector3(0,0,-1))
 const anchors=new Map([[5,{normal:[0,0,-1]}]])
 const result=normals([0,0,0,1,0,0,0,1,0],[0,1,2],anchors,[0,-1,-1],[5],{boundary:[]})
 assert.ok(result.every(n=>n[2]>0.999),'both the interior and boundary normals must agree with the actual face')
})
