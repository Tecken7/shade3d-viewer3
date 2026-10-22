import test from 'node:test'
import assert from 'node:assert/strict'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { bakePlyPixels } from '../app/thumbnail/bake.mjs'

const pixels={width:2,height:2,data:new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255])}
function model(properties,vertices,faceProperties='',face='3 0 1 2') {
 return new TextEncoder().encode(`ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n${properties}element face 1\nproperty list uchar int vertex_indices\n${faceProperties}end_header\n${vertices}\n${face}\n`).buffer
}
test('vertex UVs with extra properties bake flipped-V pixel colors and preserve geometry',()=>{
 const source=model('property float nx\nproperty float texture_u\nproperty float texture_v\n','0 0 0 1 0 1\n1 0 0 1 1 1\n0 1 0 1 0 0')
 const result=new PLYLoader().parse(bakePlyPixels(source,pixels))
 assert.deepEqual(Array.from(result.attributes.position.array),[0,0,0,1,0,0,0,1,0])
 assert.deepEqual(Array.from(result.attributes.color.array),[1,0,0,0,1,0,0,0,1])
 assert.equal(result.index.count,3)
})
test('face UV coordinates are expanded before baking',()=>{
 const source=model('', '0 0 0\n1 0 0\n0 1 0','property list uchar float texcoord\n','3 0 1 2 6 0 1 1 1 0 0')
 const result=new PLYLoader().parse(bakePlyPixels(source,pixels))
 assert.deepEqual(Array.from(result.attributes.color.array),[1,0,0,0,1,0,0,0,1])
})
test('missing UVs fail instead of uploading a falsely colored model',()=>{
 assert.throws(()=>bakePlyPixels(model('','0 0 0\n1 0 0\n0 1 0'),pixels),/UV/)
})
test('an already colored PLY without UVs keeps its original bytes',()=>{
 const source=model('property uchar red\nproperty uchar green\nproperty uchar blue\n','0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255')
 assert.equal(bakePlyPixels(source,pixels),source)
})
