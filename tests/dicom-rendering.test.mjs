import test from 'node:test'
import assert from 'node:assert/strict'
import {sampleDicomTrilinear} from '../app/viewer/dicom-sampling.mjs'
import {dicomPreviewPixels} from '../app/viewer/dicom-preview.mjs'
test('CPU DICOM sections use WebGL texel centres without stretching the volume',()=>{
 const v={width:2,height:1,depth:1,data:new Uint8Array([0,255])}
 assert.equal(sampleDicomTrilinear(v,.25,.5,.5),0)
 assert.equal(sampleDicomTrilinear(v,.75,.5,.5),255)
 assert.equal(sampleDicomTrilinear(v,.5,.5,.5),127.5)
 assert.equal(sampleDicomTrilinear(v,0,.5,.5),0)
 assert.equal(sampleDicomTrilinear(v,1,.5,.5),255)
})
test('trilinear sampling preserves all three physical axes',()=>{
 const v={width:2,height:2,depth:2,data:new Uint8Array([0,10,20,30,40,50,60,70])}
 assert.equal(sampleDicomTrilinear(v,.5,.5,.5),35)
 assert.equal(sampleDicomTrilinear(v,.75,.25,.75),50)
})
test('CT preview is stable, bounded and samples the central axial slice',()=>{
 const volume={width:4,height:2,depth:3,data:new Uint8Array(24)}
 volume.data.fill(255,8,16)
 const a=dicomPreviewPixels(volume),b=dicomPreviewPixels(volume)
 assert.deepEqual(a,b);assert.equal(a.width,4);assert.equal(a.height,2)
 assert(a.pixels.every(value=>value===255))
 assert.equal(dicomPreviewPixels(null),null)
 const big=dicomPreviewPixels({width:512,height:512,depth:1,data:new Uint8Array(512*512)})
 assert.equal(big.width,192);assert.equal(big.height,192)
})
