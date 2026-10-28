"use client"
import {useLayoutEffect} from 'react'
export default function useAnimatedPanelHeight(panelRef,contentRef,active){
 useLayoutEffect(()=>{
  const panel=panelRef.current,content=contentRef.current
  if(!active||!panel||!content)return
  let previous=null,animation
  const update=()=>{
   const css=getComputedStyle(panel),next=content.offsetHeight+parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+parseFloat(css.borderTopWidth)+parseFloat(css.borderBottomWidth)
   const from=animation?.playState==='running'?panel.getBoundingClientRect().height:previous
   animation?.cancel();previous=next
   if(from!==null&&Math.abs(next-from)>.5&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches)animation=panel.animate([{height:`${from}px`},{height:`${next}px`}],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'})
  }
  update();const observer=new ResizeObserver(update);observer.observe(content)
  return()=>{observer.disconnect();animation?.cancel()}
 },[panelRef,contentRef,active])
}
