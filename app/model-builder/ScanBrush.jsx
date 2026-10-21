"use client"
import {useEffect,useRef,useState} from 'react'
import {useThree} from '@react-three/fiber'
import * as THREE from 'three'

const noRaycast=()=>null
export function ScanBrush({context,tool,options,paint,onStart,onEnd,onBusy,onMessage,controlsRef}) {
  const {camera,gl}=useThree(),latest=useRef(null),[cursor,setCursor]=useState(null)
  latest.current={tool,options,paint,onStart,onEnd,onBusy,onMessage,controlsRef}
  useEffect(()=>{
    if(!context?.sourceObject)return
    const canvas=gl.domElement,ray=new THREE.Raycaster(),pointer=new THREE.Vector2()
    let stroke=null,worker=null,workerMesh=null,waiting=false,queue=[],ending=false,lastPoint=null,request=0,altOrbit=false
    const hitAt=e=>{
      const box=canvas.getBoundingClientRect();pointer.set((e.clientX-box.left)/box.width*2-1,-(e.clientY-box.top)/box.height*2+1)
      ray.setFromCamera(pointer,camera)
      return ray.intersectObject(context.sourceObject,true)[0]
    }
    const unlock=()=>requestAnimationFrame(()=>{if(latest.current.controlsRef.current)latest.current.controlsRef.current.enabled=true})
    const busy=value=>latest.current.onBusy(value)
    const finish=()=>{
      if(!stroke)return
      const done=stroke;stroke=null;waiting=false;queue=[];ending=false;lastPoint=null
      latest.current.onEnd(done.backup,done.changed)
      busy(false)
    }
    const flush=()=>{
      if(waiting||!worker)return
      if(!queue.length){if(ending)finish();return}
      waiting=true;worker.postMessage({id:++request,type:'dab',payload:{dabs:queue.splice(0,4)}})
    }
    const dab=(hit,e)=>{
      const config=latest.current
      const sourcePoint=context.sourceObject.worldToLocal(hit.point.clone())
      const normal=hit.face?.normal?.clone()||new THREE.Vector3(0,0,1)
      normal.transformDirection(hit.object.matrixWorld).transformDirection(context.sourceObject.matrixWorld.clone().invert())
      const quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),normal)
      setCursor({point:sourcePoint.toArray(),quaternion})
      if(['paint','erase'].includes(config.tool)) {config.paint(sourcePoint,config.options.radius,config.tool==='erase'||e.ctrlKey);return}
      if(!stroke||hit.object!==stroke.mesh)return
      const local=stroke.mesh.worldToLocal(hit.point.clone())
      const scale=stroke.mesh.getWorldScale(new THREE.Vector3()),unit=Math.max(.0001,(scale.x+scale.y+scale.z)/3)
      const radius=config.options.radius/unit
      if(lastPoint&&local.distanceTo(lastPoint)<radius*.15)return
      const previous=lastPoint?.clone();lastPoint=local.clone()
      const count=previous?Math.min(32,Math.max(1,Math.ceil(previous.distanceTo(local)/(radius*.2)))):1
      for(let i=1;i<=count;i++)queue.push({point:(previous?previous.clone().lerp(local,i/count):local).toArray(),options:{...config.options,dyntopo:false,radius,tool:e.shiftKey?'smooth':config.tool,invert:e.ctrlKey}})
      // Backpressure keeps long strokes responsive without dropping the path.
      if(queue.length>64)queue=queue.filter((_,i)=>i%2===0)
      flush()
    }
    const down=e=>{
      const config=latest.current
      if(e.altKey){altOrbit=true;if(config.controlsRef.current)config.controlsRef.current.enabled=true;return}
      if(e.button!==0||config.tool==='navigate'||stroke)return
      const hit=hitAt(e);if(!hit)return
      e.preventDefault();e.stopImmediatePropagation();canvas.setPointerCapture(e.pointerId)
      if(config.controlsRef.current)config.controlsRef.current.enabled=false
      if(['paint','erase'].includes(config.tool)){stroke={paint:true,changed:false};busy(true);dab(hit,e);return}
      const mesh=hit.object,g=mesh.userData._baseGeom?.isBufferGeometry?mesh.userData._baseGeom:mesh.geometry
      const backup=config.onStart(mesh)
      stroke={mesh,backup,changed:false};busy(true)
      const positions=Array.from(g.attributes.position.array),indices=g.index?Array.from(g.index.array):null,colors=g.attributes.color?Array.from(g.attributes.color.array):null,uvs=g.attributes.uv?Array.from(g.attributes.uv.array):null
      const materials=Array.from({length:(indices?indices.length:positions.length/3)/3},(_,i)=>g.groups.find(group=>i*3>=group.start&&i*3<group.start+group.count)?.materialIndex||0)
      const reuse=worker&&workerMesh===mesh
      if(!reuse){worker?.terminate();worker=new Worker(new URL('../workers/sculpt.worker.js',import.meta.url),{type:'module'});workerMesh=mesh}
      worker.onmessage=event=>{
        const result=event.data
        waiting=false
        if(result.type==='error'){
          const failed=stroke
          worker?.terminate();worker=null;stroke=null;queue=[];ending=false
          config.onEnd(failed?.backup,false,true);busy(false);config.onMessage(result.error);return
        }
        if(result.type==='result'&&stroke){
          const data=result.geometry,geometry=new THREE.BufferGeometry()
          geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));geometry.setIndex(new THREE.BufferAttribute(data.indices,1))
          if(data.colors)geometry.setAttribute('color',new THREE.BufferAttribute(data.colors,3))
          if(data.uvs)geometry.setAttribute('uv',new THREE.BufferAttribute(data.uvs,2))
          let start=0
          while(start<data.materials.length){let end=start+1;while(end<data.materials.length&&data.materials[end]===data.materials[start])end++;geometry.addGroup(start*3,(end-start)*3,data.materials[start]);start=end}
          geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();geometry.computeBoundsTree?.({indirect:true})
          const old=stroke.mesh.geometry
          stroke.mesh.geometry=geometry;stroke.mesh.userData._baseGeom=geometry;stroke.mesh.userData._derivedGeom=geometry;stroke.mesh.userData._originalColors=geometry.attributes.color?.clone()||null
          if(old!==stroke.backup.geometry){old.disposeBoundsTree?.();old.dispose()}
          stroke.changed ||= result.stats.changed>0||result.stats.split>0||result.stats.collapsed>0
          config.onMessage(`Štětec · upraveno ${result.stats.changed} vrcholů${config.options.dyntopo?` · dynotopo +${result.stats.split} / −${result.stats.collapsed}`:''}`)
        }
        flush()
      }
      worker.onerror=()=>{const failed=stroke;worker?.terminate();worker=null;stroke=null;queue=[];config.onEnd(failed?.backup,false,true);busy(false);config.onMessage('Výpočet štětce se nepodařil. Tah byl vrácen.')}
      waiting=!reuse;if(!reuse)worker.postMessage({type:'start',payload:[positions,indices,colors,uvs,materials]});dab(hit,e)
    }
    const move=e=>{
      if(latest.current.tool==='navigate'||altOrbit){setCursor(null);return}
      const hit=hitAt(e);if(!hit){setCursor(null);return}
      if(stroke)dab(hit,e)
      else{
        const p=context.sourceObject.worldToLocal(hit.point.clone()),n=(hit.face?.normal?.clone()||new THREE.Vector3(0,0,1)).transformDirection(hit.object.matrixWorld).transformDirection(context.sourceObject.matrixWorld.clone().invert())
        setCursor({point:p.toArray(),quaternion:new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),n)})
      }
    }
    const up=e=>{
      unlock();if(altOrbit){altOrbit=false;return}
      if(!stroke)return
      if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId)
      if(stroke.paint){stroke=null;lastPoint=null;busy(false);return}
      ending=true;flush()
    }
    const cancel=e=>{unlock();if(stroke?.paint){stroke=null;busy(false);return}if(stroke){queue=[];ending=true;flush()}if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId)}
    canvas.addEventListener('pointerdown',down,true);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',cancel)
    return()=>{unlock();worker?.terminate();canvas.removeEventListener('pointerdown',down,true);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',cancel)}
  },[context,camera,gl])
  if(!cursor||tool==='navigate')return null
  return <group matrix={context.sourceObject.matrix} matrixAutoUpdate={false}><mesh position={cursor.point} quaternion={cursor.quaternion} raycast={noRaycast} renderOrder={2100}><ringGeometry args={[options.radius*.97,options.radius,64]}/><meshBasicMaterial color={tool==='erase'?'#fb7185':tool==='paint'?'#fbbf24':tool==='subtract'?'#fb7185':'#38bdf8'} side={THREE.DoubleSide} depthTest={false}/></mesh></group>
}
