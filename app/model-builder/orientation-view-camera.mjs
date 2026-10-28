import * as THREE from 'three'
export function orientationViewCamera(camera,bounds,view,aspect,planeCenter,planeSize,frontSign=1){
 if(bounds.isEmpty())return
 const box=bounds.clone()
 if(view==='top'&&planeCenter&&planeSize)box.expandByPoint(new THREE.Vector3(planeCenter[0],box.getCenter(new THREE.Vector3()).y,planeCenter[2]+frontSign*planeSize*.48))
 const center=box.getCenter(new THREE.Vector3()),dims=box.getSize(new THREE.Vector3()),ratio=Math.max(.35,aspect||1)
 const width=view.startsWith('side')?dims.z:dims.x,height=view==='top'?dims.z:dims.y
 const half=Math.max(height*.5,width/(2*ratio),1)*1.24,distance=Math.max(dims.x,dims.y,dims.z,1)*3.2+8
 Object.assign(camera,{left:-half*ratio,right:half*ratio,top:half,bottom:-half,zoom:1,near:.01,far:distance*12+100})
 camera.up.set(0,1,0)
 if(view==='top'){camera.position.set(center.x,center.y+distance,center.z);camera.up.set(0,0,-1)}
 else if(view==='side-left')camera.position.set(center.x-distance,center.y,center.z)
 else if(view==='side-right')camera.position.set(center.x+distance,center.y,center.z)
 else camera.position.set(center.x,center.y,center.z+distance)
 camera.lookAt(center);camera.updateProjectionMatrix()
}
