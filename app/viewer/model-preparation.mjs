import * as THREE from "three"
export function autoSmoothGeometry(geometry, angleDeg = 30) {
  const angle = Math.max(0, Math.min(89.9, angleDeg))
  const angleRad = (angle * Math.PI) / 180
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const pos = g.getAttribute("position")
  const triCount = pos.count / 3
  const faceNormals = new Array(triCount)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const cb = new THREE.Vector3(), ab = new THREE.Vector3()
  for (let f = 0; f < triCount; f++) {
    const i0 = f * 3, i1 = i0 + 1, i2 = i0 + 2
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    cb.subVectors(c, b)
    ab.subVectors(a, b)
    cb.cross(ab).normalize()
    faceNormals[f] = cb.clone()
  }
  const groups = new Map()
  const keyOf = (ix) => `${pos.getX(ix).toFixed(5)},${pos.getY(ix).toFixed(5)},${pos.getZ(ix).toFixed(5)}`
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i)
    let arr = groups.get(k); if (!arr) { arr = []; groups.set(k, arr) }
    arr.push(i)
  }
  const normals = new Float32Array(pos.count * 3)
  const tmp = new THREE.Vector3()
  const cosThresh = Math.cos(angleRad)
  groups.forEach((cornerIndices) => {
    const localFaceNs = cornerIndices.map((ci) => faceNormals[Math.floor(ci / 3)])
    for (let idx = 0; idx < cornerIndices.length; idx++) {
      const ci = cornerIndices[idx]
      const nRef = localFaceNs[idx]
      let nx = 0, ny = 0, nz = 0
      for (let j = 0; j < localFaceNs.length; j++) {
        const nj = localFaceNs[j]
        if (nRef.dot(nj) >= cosThresh) { nx += nj.x; ny += nj.y; nz += nj.z }
      }
      tmp.set(nx, ny, nz); if (tmp.lengthSq() === 0) tmp.copy(nRef); tmp.normalize()
      const w = ci * 3; normals[w] = tmp.x; normals[w+1] = tmp.y; normals[w+2] = tmp.z
    }
  })
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3))
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}


export function packGeometry(geometry) {
 return { attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,{array:a.array,itemSize:a.itemSize,normalized:a.normalized}])), index:geometry.index?.array || null, groups:geometry.groups, box:geometry.boundingBox ? [geometry.boundingBox.min.toArray(),geometry.boundingBox.max.toArray()] : null, sphere:geometry.boundingSphere ? [geometry.boundingSphere.center.toArray(),geometry.boundingSphere.radius] : null }
}
export function unpackGeometry(data) {
 const g=new THREE.BufferGeometry()
 for(const [name,a] of Object.entries(data.attributes))g.setAttribute(name,new THREE.BufferAttribute(a.array,a.itemSize,a.normalized))
 if(data.index)g.setIndex(new THREE.BufferAttribute(data.index,1))
 for(const group of data.groups)g.addGroup(group.start,group.count,group.materialIndex)
 if(data.box)g.boundingBox=new THREE.Box3(new THREE.Vector3().fromArray(data.box[0]),new THREE.Vector3().fromArray(data.box[1]))
 if(data.sphere)g.boundingSphere=new THREE.Sphere(new THREE.Vector3().fromArray(data.sphere[0]),data.sphere[1])
 return g
}
export function packObject(object) {
 object.updateMatrix()
 return {type:object.type,name:object.name,matrix:object.matrix.toArray(),geometry:object.geometry?packGeometry(object.geometry):null,material:object.material?(Array.isArray(object.material)?object.material.map(m=>m.toJSON()):object.material.toJSON()):null,children:object.children.map(packObject)}
}
export function unpackObject(data) {
 const materialLoader=new THREE.MaterialLoader()
 const material=data.material?(Array.isArray(data.material)?data.material.map(m=>materialLoader.parse(m)):materialLoader.parse(data.material)):null
 const geometry=data.geometry?unpackGeometry(data.geometry):null
 const object=geometry?(data.type==='LineSegments'?new THREE.LineSegments(geometry,material):data.type==='Points'?new THREE.Points(geometry,material):new THREE.Mesh(geometry,material)):new THREE.Group()
 object.name=data.name;new THREE.Matrix4().fromArray(data.matrix).decompose(object.position,object.quaternion,object.scale)
 data.children.forEach(child=>object.add(unpackObject(child)))
 return object
}
export function modelTransferables(value, buffers=new Set()) {
 if(ArrayBuffer.isView(value))buffers.add(value.buffer)
 else if(value&&typeof value==='object')Object.values(value).forEach(v=>modelTransferables(v,buffers))
 return [...buffers]
}
