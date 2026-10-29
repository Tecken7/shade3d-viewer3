import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {projectSurfaceText} from '../app/model-builder/surface-text.mjs'
const font=new FontLoader().parse(JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/inter-font.json',import.meta.url),'utf8')))
const options={text:'A',textSize:2,textDepth:.5,textMode:'emboss',textRotation:0,baseDirection:1}
const tree=geometry=>{geometry.boundsTree=new MeshBVH(geometry);return geometry}

test('wall text keeps the same projected footprint in preview and actual construction',()=>{
 const surface=tree(new THREE.PlaneGeometry(30,20)),placement={position:[0,0,0],normal:[0,0,1]}
 const actual=projectSurfaceText(font,options,placement,surface),preview=projectSurfaceText(font,options,placement,surface,{preview:true})
 assert.equal(actual.valid,true,actual.error);assert.equal(preview.valid,true,preview.error)
 const a=actual.geometry.attributes.position,b=preview.geometry.attributes.position
 for(let i=0;i<a.count;i++){assert.equal(a.getX(i),b.getX(i));assert.equal(a.getY(i),b.getY(i));assert.ok(Math.abs(b.getZ(i)-a.getZ(i)-.015)<1e-6)}
 actual.geometry.dispose();preview.geometry.dispose();surface.dispose()
})

test('text can wrap onto a crown top whose normal is parallel to the model vertical axis',()=>{
 const surface=tree(new THREE.SphereGeometry(6,64,48))
 const result=projectSurfaceText(font,options,{position:[0,6,0],normal:[0,1,0]},surface,{preview:true})
 assert.equal(result.valid,true,result.error)
 assert.ok([...result.geometry.attributes.position.array].every(Number.isFinite))
 assert.ok(result.geometry.boundingBox.max.y>6)
 result.geometry.dispose();surface.dispose()
})

test('a gap between sparse letter vertices is rejected with a visible diagnostic geometry',()=>{
 const surface=tree(mergeGeometries([new THREE.PlaneGeometry(30,10).translate(0,5.15,0),new THREE.PlaneGeometry(30,10).translate(0,-5.15,0)]))
 const result=projectSurfaceText(font,{...options,text:'I'},{position:[0,0,0],normal:[0,0,1]},surface,{preview:true})
 assert.equal(result.valid,false);assert.match(result.error,/povrch|mezeru/)
 assert.ok(result.geometry);assert.ok([...result.geometry.attributes.position.array].every(Number.isFinite))
 result.geometry.dispose();surface.dispose()
})
import {createTextSurfaceChart,tessellateText} from '../app/model-builder/text-surface-chart.mjs'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'
import {indexed,meshTopology} from '../app/model-builder/engine.mjs'

test('wrapping keeps physical letter width around a cylinder instead of stretching a view projection',()=>{
 const radius=6,surface=tree(new THREE.CylinderGeometry(radius,radius,20,256)),chart=createTextSurfaceChart(surface,new THREE.Vector3(0,0,radius),new THREE.Vector3(0,0,1),new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Box3(new THREE.Vector3(-5,-2,0),new THREE.Vector3(5,2,0)))
 for(const x of [-5,-3,-1,1,3,5]){
  const frame=chart(x,1),arc=radius*Math.atan2(frame.point.x,frame.point.z)
  assert.ok(Math.abs(arc-x)<.04,`surface distance ${arc}, type distance ${x}`)
  assert.ok(Math.abs(frame.point.y-1)<.015)
  assert.ok(frame.normal.dot(new THREE.Vector3(frame.point.x,0,frame.point.z).normalize())>.999)
 }
 surface.dispose()
})

test('a true sharp corner is refused instead of stretching a glyph around it',()=>{
 const surface=tree(new THREE.BoxGeometry(8,10,8)),result=projectSurfaceText(font,{...options,text:'Novák',textSize:3},{position:[2,0,4],normal:[0,0,1]},surface,{preview:true})
 assert.equal(result.valid,false);assert.match(result.error,/hraně|povrch|proporce/)
 result.geometry.dispose();surface.dispose()
})

test('subdivision preserves a closed letter solid and the wrapped N remains watertight',()=>{
 const original=new TextGeometry('N',{font,size:3,depth:.7,curveSegments:8,bevelEnabled:false}),refined=tessellateText(original),plain=indexed(refined.attributes.position.array,{exact:true}),plainTopology=meshTopology(plain.vertices,plain.faces)
 assert.equal(plainTopology.openEdges,0);assert.equal(plainTopology.nonManifold,0)
 const surface=tree(new THREE.CylinderGeometry(6,6,20,256)),result=projectSurfaceText(font,{...options,text:'N',textSize:3},{position:[0,0,6],normal:[0,0,1]},surface)
 assert.equal(result.valid,true,result.error)
 const wrapped=indexed(result.geometry.attributes.position.array,{exact:true}),topology=meshTopology(wrapped.vertices,wrapped.faces)
 assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
 original.dispose();refined.dispose();surface.dispose();result.geometry.dispose()
})

test('the visible front face of N keeps its width despite emboss depth on a tight round corner',()=>{
 const radius=3,depth=.5,raw=new TextGeometry('N',{font,size:3,depth:depth+.2,curveSegments:8,bevelEnabled:false});raw.computeBoundingBox()
 const width=raw.boundingBox.max.x-raw.boundingBox.min.x,surface=tree(new THREE.CylinderGeometry(radius,radius,20,256)),result=projectSurfaceText(font,{...options,text:'N',textSize:3,textDepth:depth},{position:[0,0,radius],normal:[0,0,1]},surface)
 assert.equal(result.valid,true,result.error)
 const angles=[],a=result.geometry.attributes.position
 for(let i=0;i<a.count;i++)if(Math.abs(Math.hypot(a.getX(i),a.getZ(i))-(radius+depth))<.006)angles.push(Math.atan2(a.getX(i),a.getZ(i)))
 const arc=(radius+depth)*(Math.max(...angles)-Math.min(...angles))
 assert.ok(Math.abs(arc-width)/width<.02,`visible letter width ${arc}, font width ${width}`)
 raw.dispose();result.geometry.dispose();surface.dispose()
})
import Module from 'manifold-3d'

test('wrapped Czech lettering unions with a curved solid as one closed printable component',async()=>{
 const M=await Module();M.setup()
 const surface=tree(new THREE.CylinderGeometry(8,8,20,128)),result=projectSurfaceText(font,{...options,text:'Novák',textSize:3},{position:[0,0,8],normal:[0,0,1]},surface)
 assert.equal(result.valid,true,result.error)
 const solid=geometry=>{const data=indexed(geometry.index?geometry.toNonIndexed().attributes.position.array:geometry.attributes.position.array);return new M.Manifold(new M.Mesh({numProp:3,vertProperties:new Float32Array(data.vertices),triVerts:new Uint32Array(data.faces)}))}
 const body=solid(surface),letters=solid(result.geometry)
 let union,parts=[]
 try{
  assert.equal(letters.status(),'NoError')
  union=body.add(letters);assert.equal(union.status(),'NoError');assert.ok(union.volume()>body.volume())
  parts=union.decompose();assert.equal(parts.length,1)
  const mesh=union.getMesh(),topology=meshTopology(Array.from(mesh.vertProperties),Array.from(mesh.triVerts))
  assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
 }finally{for(const part of parts)part.delete();union?.delete();body.delete();letters.delete();surface.dispose();result.geometry.dispose()}
})
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'

test('generated vertical walls stay developable despite smooth shading from a sloped shoulder',()=>{
 const raw=new THREE.LatheGeometry([new THREE.Vector2(8,-5),new THREE.Vector2(8,4),new THREE.Vector2(7.7,5)],64),surface=tree(toCreasedNormals(raw,Math.PI/6)),theta=.025
 for(const y of [-2,0,2]){
  const hit=surface.boundsTree.raycastFirst(new THREE.Ray(new THREE.Vector3(Math.sin(theta)*12,y,Math.cos(theta)*12),new THREE.Vector3(-Math.sin(theta),0,-Math.cos(theta))),THREE.DoubleSide)
  const result=projectSurfaceText(font,{...options,text:'Novák',textSize:2,baseDirection:-1},{position:hit.point.toArray(),normal:hit.face.normal.toArray()},surface)
  assert.equal(result.valid,true,result.error)
  const attr=result.geometry.attributes.position
  for(let i=0;i<attr.count;i++)assert.ok(Number.isFinite(attr.getX(i)))
  const data=indexed(attr.array,{exact:true}),topology=meshTopology(data.vertices,data.faces)
  assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
  result.geometry.dispose()
 }
 raw.dispose();surface.dispose()
})

test('concave wall validation measures the visible letter face, not the wider root footprint',()=>{
 const surface=new THREE.CylinderGeometry(3,3,20,256),ids=surface.index.array
 for(let i=0;i<ids.length;i+=3)[ids[i],ids[i+1]]=[ids[i+1],ids[i]]
 for(let i=0;i<surface.attributes.normal.array.length;i++)surface.attributes.normal.array[i]*=-1
 tree(surface)
 for(const preview of [false,true]){
  const result=projectSurfaceText(font,{...options,text:'N',textSize:3,baseDirection:-1},{position:[0,0,3],normal:[0,0,-1]},surface,{preview})
  assert.equal(result.valid,true,result.error)
  result.geometry.dispose()
 }
 surface.dispose()
})

test('small strain on a gently changing surface is accepted while pronounced distortion is rejected',()=>{
 for(const [bend,valid]of [[.15,true],[.25,false]]){
  const surface=new THREE.PlaneGeometry(40,20,120,60),positions=surface.attributes.position
  for(let i=0;i<positions.count;i++)positions.setZ(i,bend*positions.getX(i)*positions.getY(i))
  surface.computeVertexNormals();tree(surface)
  const result=projectSurfaceText(font,{...options,text:'Novák',textSize:2,baseDirection:-1},{position:[0,0,0],normal:[0,0,1]},surface)
  assert.equal(result.valid,valid,result.error)
  if(valid){
   const mesh=indexed(result.geometry.attributes.position.array,{exact:true}),topology=meshTopology(mesh.vertices,mesh.faces)
   assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
  }else assert.match(result.error,/proporce/)
  result.geometry.dispose();surface.dispose()
 }
})


test('near-vertical tapered base walls wrap each row onto the actual surface without tilted chart drift',()=>{
 const surface=tree(new THREE.CylinderGeometry(12,10,20,256,12)),normal=new THREE.Vector3(0,-.1,1).normalize()
 const chart=createTextSurfaceChart(surface,new THREE.Vector3(0,0,11),normal,new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,.1).normalize(),new THREE.Box3(new THREE.Vector3(-4,-2,0),new THREE.Vector3(4,2,0)),.5)
 for(const x of [-3,0,3])for(const y of [-1,0,1]){
  const frame=chart(x,y),hit=surface.boundsTree.closestPointToPoint(frame.point)
  assert.ok(hit.distance<.002,`wrapped row must touch the tapered wall: ${hit.distance}`)
  assert.ok(Math.abs(frame.point.y-y)<.005,'rows stay at their intended height instead of tilting with smooth shoulder normals')
 }
 surface.dispose()
})


test('small user rotations are preserved instead of being flattened by the base-wall shortcut',()=>{
 const surface=tree(new THREE.PlaneGeometry(30,20)),placement={position:[0,0,0],normal:[0,0,1]},angle=10*Math.PI/180
 const plain=projectSurfaceText(font,{...options,text:'ART'},placement,surface),rotated=projectSurfaceText(font,{...options,text:'ART',textRotation:10},placement,surface)
 assert.equal(plain.valid,true,plain.error);assert.equal(rotated.valid,true,rotated.error)
 const a=plain.geometry.attributes.position,b=rotated.geometry.attributes.position
 for(let i=0;i<a.count;i++){
  assert.ok(Math.abs(b.getX(i)-(a.getX(i)*Math.cos(angle)-a.getY(i)*Math.sin(angle)))<1e-5)
  assert.ok(Math.abs(b.getY(i)-(a.getX(i)*Math.sin(angle)+a.getY(i)*Math.cos(angle)))<1e-5)
 }
 plain.geometry.dispose();rotated.geometry.dispose();surface.dispose()
})


test('per-letter wrapping keeps Czech glyphs attached as one closed printable result',async()=>{
 const M=await Module();M.setup()
 const surface=tree(new THREE.CylinderGeometry(8,8,20,128)),result=projectSurfaceText(font,{...options,text:'Novák',textSize:3},{position:[0,0,8],normal:[0,0,1]},surface,{perGlyph:true})
 assert.equal(result.valid,true,result.error)
 const solid=g=>{const data=indexed(g.index?g.toNonIndexed().attributes.position.array:g.attributes.position.array);return new M.Manifold(new M.Mesh({numProp:3,vertProperties:new Float32Array(data.vertices),triVerts:new Uint32Array(data.faces)}))}
 const body=solid(surface),letters=solid(result.geometry);let union,parts=[]
 try{
  assert.equal(letters.status(),'NoError');union=body.add(letters);assert.equal(union.status(),'NoError')
  parts=union.decompose();assert.equal(parts.length,1)
  const data=union.getMesh(),topology=meshTopology(Array.from(data.vertProperties),Array.from(data.triVerts));assert.equal(topology.openEdges,0);assert.equal(topology.nonManifold,0)
 }finally{for(const part of parts)part.delete();union?.delete();letters.delete();body.delete();result.geometry.dispose();surface.dispose()}
})
