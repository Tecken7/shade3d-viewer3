import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {projectSurfaceText} from '../app/model-builder/surface-text.mjs'
import {updateLiveTextPreview,isTextPlacementClick} from '../app/model-builder/text-live-preview.mjs'
import {TEXT_WEIGHTS,textFontUrl,textWeight} from '../app/model-builder/text-font.mjs'
import {builderTextSignature} from '../app/model-builder/builder-workflow.mjs'
const font=new FontLoader().parse(JSON.parse(fs.readFileSync(new URL('../public/wasm/model-builder/inter-font.json',import.meta.url))))
const options={text:'Novák',textSize:4,textDepth:.5,textMode:'emboss',textRotation:0,baseDirection:1}
test('live preview follows the curved wall while leaving exact worker output and canonical glyphs untouched',()=>{
 const surface=new THREE.CylinderGeometry(12,12,20,256);surface.boundsTree=new MeshBVH(surface)
 const exact=projectSurfaceText(font,options,{position:[0,0,12],normal:[0,0,1]},surface,{preview:true}),before=exact.geometry.attributes.position.array.slice(),local=exact.geometry.attributes.textLocal.array.slice(),live=exact.geometry.clone()
 for(const angle of [.1,.2,.3]){
  const point={position:[Math.sin(angle)*12,0,Math.cos(angle)*12],normal:[Math.sin(angle),0,Math.cos(angle)]}
  assert.equal(updateLiveTextPreview(live,options,point,surface),true)
  assert.deepEqual(exact.geometry.attributes.position.array,before);assert.deepEqual(live.attributes.textLocal.array,local)
  const a=live.attributes.position
  for(let i=0;i<a.count;i++)assert.ok(Math.abs(Math.hypot(a.getX(i),a.getZ(i))-12)<.54,'live letters must stay against the curved wall')
 }
 assert.ok(live.boundingBox.getCenter(new THREE.Vector3()).x>2)
 live.dispose();exact.geometry.dispose();surface.dispose()
})
test('unprojectable live positions leave the last visible geometry intact',()=>{
 const surface=new THREE.PlaneGeometry(30,20);surface.boundsTree=new MeshBVH(surface)
 const exact=projectSurfaceText(font,options,{position:[0,0,0],normal:[0,0,1]},surface,{preview:true}),before=exact.geometry.attributes.position.array.slice()
 assert.equal(updateLiveTextPreview(exact.geometry,options,{position:[100,0,0],normal:[0,0,1]},surface),false)
 assert.deepEqual(exact.geometry.attributes.position.array,before);exact.geometry.dispose();surface.dispose()
})
test('click places text but a drag, modified click, or other mouse button remains a camera gesture',()=>{
 const start={x:50,y:60},event={clientX:52,clientY:62,button:0}
 assert.equal(isTextPlacementClick(start,event),true)
 for(const extra of [{clientX:70},{altKey:true},{shiftKey:true},{ctrlKey:true},{button:2}])assert.equal(isTextPlacementClick(start,{...event,...extra}),false)
 assert.equal(isTextPlacementClick(null,event),false)
 assert.equal(isTextPlacementClick({...start,moved:true},event),false)
})
test('Inter weights include Czech glyphs, have distinct outlines, and invalidate the applied label cache',()=>{
 const outlines=new Set(),signatures=new Set()
 for(const {value}of TEXT_WEIGHTS){
  const data=JSON.parse(fs.readFileSync(new URL('../public'+textFontUrl(value),import.meta.url)))
  assert.equal(data.cssFontWeight,value);assert.ok([...'Příliš žluťoučký kůň'].every(char=>data.glyphs[char]))
  outlines.add(data.glyphs.N.o);signatures.add(builderTextSignature({...options,textWeight:value}))
 }
 assert.equal(outlines.size,TEXT_WEIGHTS.length);assert.equal(signatures.size,TEXT_WEIGHTS.length)
 assert.equal(textWeight('700'),700);assert.equal(textWeight('bad'),400);assert.equal(textFontUrl(undefined),textFontUrl(400))
})


test('placement mode keeps camera controls enabled, while dragging the actual inscription locks the camera',()=>{
 const source=fs.readFileSync(new URL('../app/ClientPage.jsx',import.meta.url),'utf8'),tag=source.slice(source.lastIndexOf('<TouchTrackballControls'),source.indexOf('/>',source.lastIndexOf('<TouchTrackballControls'))),expression=tag.match(/enabled=\{([^}]+)\}/)[1]
 const state={sliceDrawing:false,builderDragging:false,builderPlacing:true,sliceOverlayInteracting:false,alignmentBusy:false,cadBusy:false,cadStage:'text',trimDraggingPoint:null,trimBusy:false,trimStage:'model'}
 const evaluate=()=>new Function(...Object.keys(state),`return (${expression})`)(...Object.values(state))
 assert.equal(evaluate(),true);state.builderDragging=true;assert.equal(evaluate(),false)
})
