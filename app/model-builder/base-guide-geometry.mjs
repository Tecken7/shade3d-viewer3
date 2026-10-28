import * as THREE from 'three'
import {toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// The worker has already constructed the regularized bevel. No approximate
// mitering or resampling on the render thread: changing height only translates it.
export function makeBaseGuideGeometry(profile){
  const raw=new THREE.BufferGeometry()
  raw.setAttribute('position',new THREE.BufferAttribute(profile.positions,3))
  raw.setIndex(new THREE.BufferAttribute(profile.indices,1));raw.computeVertexNormals()
  const geometry=toCreasedNormals(raw,Math.PI/6);raw.dispose();geometry.computeBoundingBox();return geometry
}
