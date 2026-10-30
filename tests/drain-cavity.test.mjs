import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'manifold-3d'
import {drainCavityVolume} from '../app/models/reshape-original-base.mjs'
const M=await Module();M.setup()
test('a round drain can reach the actual cavity off its centre axis, but a blocked or material-filled passage cannot',()=>{
 const allocated=[],own=s=>{allocated.push(s);return s}
 try{
  const core=own(M.CrossSection.square([10,10],false)),outer=own(M.Manifold.cube([20,20,5]).translate([-10,-10,0])),cavity=own(core.extrude(5)),shell=own(outer.subtract(cavity))
  const cylinder=own(M.Manifold.cylinder(12,2,2,96)),rotated=own(cylinder.rotate([0,90,0])),sideEntry=own(rotated.translate([-5,-1,2.5])),miss=own(rotated.translate([-5,-5,2.5]))
  assert.ok(drainCavityVolume(M,sideEntry,shell,core,5)>5,'the axis is outside the cavity, but a useful part of the full drain opens into it')
  assert.equal(drainCavityVolume(M,miss,shell,core,5),0)
  assert.equal(drainCavityVolume(M,sideEntry,outer,core,5),0,'an apparent overlap inside solid material is not a resin passage')
 }finally{allocated.reverse().forEach(p=>p.delete())}
})
