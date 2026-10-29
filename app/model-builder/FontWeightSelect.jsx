"use client"
import React,{useEffect,useLayoutEffect,useId,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import useAnimatedPresence from '../useAnimatedPresence'
import {TEXT_WEIGHTS,textWeight} from './text-font.mjs'
import styles from './FontWeightSelect.module.css'
export default function FontWeightSelect({value,onChange,disabled=false}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState(null),button=useRef(null),menu=useRef(null),id=useId(),{present,exiting}=useAnimatedPresence(open,160),selected=textWeight(value)
 useEffect(()=>{if(disabled)setOpen(false)},[disabled])
 useLayoutEffect(()=>{
  if(!open)return
  const place=()=>{const box=button.current.getBoundingClientRect(),below=innerHeight-box.bottom-12,above=box.top-12,upward=below<180&&above>below;setPosition({left:Math.max(8,Math.min(box.left,innerWidth-box.width-8)),width:box.width,maxHeight:Math.min(238,Math.max(60,upward?above:below)),...(upward?{bottom:innerHeight-box.top+6}:{top:box.bottom+6})})}
  place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
  return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)}
 },[open])
 useEffect(()=>{
  if(!open)return
  const outside=event=>{if(!button.current?.contains(event.target)&&!menu.current?.contains(event.target))setOpen(false)}
  window.addEventListener('pointerdown',outside,true)
  return()=>window.removeEventListener('pointerdown',outside,true)
 },[open])
 useEffect(()=>{if(open&&position)menu.current?.querySelector('[aria-selected=true]')?.focus({preventScroll:true})},[open,!!position])
 const choose=weight=>{onChange(weight);setOpen(false);button.current?.focus()}
 const keys=event=>{
  const items=[...menu.current?.querySelectorAll('[role=option]')||[]],active=items.indexOf(document.activeElement)
  if(event.key==='Escape'){event.preventDefault();setOpen(false);button.current?.focus()}
  else if(event.key==='Tab'){setOpen(false);button.current?.focus()}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
   event.preventDefault();if(!open){setOpen(true);return}
   const next=event.key==='Home'?0:event.key==='End'?items.length-1:(active+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
   items[next]?.focus()
  }
 }
 return <><button ref={button} type="button" className={styles.trigger} disabled={disabled} aria-label="Řez písma Inter" aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} onKeyDown={keys} onClick={()=>setOpen(!open)}><span>{TEXT_WEIGHTS.find(weight=>weight.value===selected).label}</span><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{transform:open?'rotate(180deg)':undefined}}><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4"/></svg></button>
 {present&&position&&createPortal(<div ref={menu} id={id} role="listbox" aria-label="Řez písma Inter" className={styles.menu} data-exiting={exiting||undefined} aria-hidden={exiting||undefined} inert={exiting?'':undefined} style={position} onKeyDown={keys}>{TEXT_WEIGHTS.map(weight=><button type="button" role="option" tabIndex={-1} aria-selected={weight.value===selected} className={styles.option} key={weight.value} onClick={()=>choose(weight.value)}><span className={styles.sample} style={{fontWeight:weight.value}}>Aa</span><span>{weight.label}</span><span className={styles.check} aria-hidden="true">{weight.value===selected?'✓':''}</span></button>)}</div>,document.body)}</>
}
