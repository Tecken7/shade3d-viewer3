"use client"
import React,{useCallback,useEffect,useMemo,useState} from 'react'
import {BuilderPreview} from './BuilderPreview'
import {LAB_LOGO_FONT,labLogoOptions,labLogoPatch} from './lab-logo.mjs'
export default function LabLogoPreview({geometry,placement,options,change,onStatus,selected,placing,select,...rest}){
 const [searching,setSearching]=useState(false),[searchError,setSearchError]=useState('')
 useEffect(()=>{
  if(!geometry||!options.textLogoEnabled||options.textLogoPosition){setSearching(false);return}
  let live=true,worker
  setSearching(true);setSearchError('')
  fetch(LAB_LOGO_FONT).then(response=>{if(!response.ok)throw Error('Nepodařilo se načíst písmo loga.');return response.json()}).then(font=>{
   if(!live)return
   worker=new Worker(new URL('./lab-logo-placement.worker.js',import.meta.url))
   worker.onmessage=({data})=>{
    if(!live)return
    worker.terminate();setSearching(false)
    if(data.result)change({textLogoPosition:data.result.position,textLogoNormal:data.result.normal,textLogoSize:data.result.size})
    else setSearchError('Vhodné místo jsem nenašel. Logo můžete umístit ručně.')
   }
   worker.onerror=()=>{if(live){worker.terminate();setSearching(false);setSearchError('Automatické umístění se nepodařilo. Zkuste logo umístit ručně.')}}
   const positions=geometry.attributes.position.array.slice(),index=geometry.index?.array.slice()
   worker.postMessage({positions,index,placement,options,font},[positions.buffer,index?.buffer].filter(Boolean))
  }).catch(error=>{if(live){setSearching(false);setSearchError(error.message)}})
  return()=>{live=false;worker?.terminate()}
 },[geometry,placement,options.textLogoEnabled,options.textLogoPosition,options.textLogoSearchNonce,change])
 const status=useCallback(value=>onStatus({...value,searching,placing:placing&&selected==='logo',valid:!searching&&!!options.textLogoPosition&&value.valid,error:searching?'Hledám vhodnou vnitřní stěnu…':!options.textLogoPosition&&searchError?searchError:value.error}),[onStatus,searching,searchError,placing,selected,options.textLogoPosition])
 const patch=useCallback(value=>change(labLogoPatch(value)),[change]),choose=useCallback(()=>select('logo'),[select])
 const config=useMemo(()=>labLogoOptions(options),[options])
 return <BuilderPreview {...rest} geometry={geometry} options={config} change={patch} select={choose} onTextStatus={status} placing={placing&&selected==='logo'} interactionLocked={placing&&selected!=='logo'} overlayOnly fontUrlOverride={LAB_LOGO_FONT}/>
}
