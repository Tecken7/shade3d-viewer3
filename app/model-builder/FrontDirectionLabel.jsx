'use client'
import React,{useEffect,useMemo,useState} from 'react'
import * as THREE from 'three'
import {FontLoader} from 'three/examples/jsm/loaders/FontLoader.js'
import {TextGeometry} from 'three/examples/jsm/geometries/TextGeometry.js'

let request
export function FrontDirectionLabel({size,compact,frontSign=1}){
 const [font,setFont]=useState(null)
 useEffect(()=>{
  let live=true
  request??=fetch('/wasm/model-builder/font.json').then(r=>{if(!r.ok)throw new Error('font');return r.json()}).then(data=>new FontLoader().parse(data)).catch(()=>{request=null;return null})
  request.then(value=>{if(live)setFont(value)})
  return()=>{live=false}
 },[])
 const geometry=useMemo(()=>{
  if(!font)return null
  const text=new TextGeometry('FRONT',{font,size:Math.max(1.5,size*(compact ? .028 : .045)),depth:.005,curveSegments:3,bevelEnabled:false})
  text.computeBoundingBox();text.translate(-(text.boundingBox.min.x+text.boundingBox.max.x)/2,-(text.boundingBox.min.y+text.boundingBox.max.y)/2,0)
  return text
 },[font,size,compact])
 useEffect(()=>()=>geometry?.dispose(),[geometry])
 return geometry?<mesh geometry={geometry} dispose={null} position={[0,.04,frontSign*size*.43]} rotation={[-Math.PI/2,0,0]} raycast={()=>null} renderOrder={4}><meshBasicMaterial color="#60a5fa" transparent opacity={.5} depthTest depthWrite={false} side={THREE.DoubleSide}/></mesh>:null
}
