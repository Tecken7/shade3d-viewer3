import * as THREE from 'three'
import {MeshBVH} from 'three-mesh-bvh'
import {weldByDistance} from '../model-builder/mesh-weld.mjs'
self.onmessage = ({data}) => {
  try {
    let result, transfers = []
    if (data.type === 'weld') {
      const welded = weldByDistance(data.points, data.triangles, data.tolerance, data.vertexGroups)
      result = {stats:welded.stats, positions:Float64Array.from(welded.positions), keep:Uint32Array.from(welded.keep)}
      transfers = [result.positions.buffer,result.keep.buffer]
    } else if (data.type === 'bvh') {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3))
      if (data.index) geometry.setIndex(new THREE.BufferAttribute(data.index,1))
      geometry.groups = data.groups
      const tree = new MeshBVH(geometry,{indirect:true})
      result = MeshBVH.serialize(tree,{cloneBuffers:false})
      transfers = [...result.roots]
      if (result.index) transfers.push(result.index.buffer)
      if (result.indirectBuffer) transfers.push(result.indirectBuffer.buffer)
    } else throw Error('Neznámá úloha přípravy sítě.')
    self.postMessage({result},transfers)
  } catch(error) { self.postMessage({error:error.message || 'Příprava sítě selhala.',code:error.code}) }
}
