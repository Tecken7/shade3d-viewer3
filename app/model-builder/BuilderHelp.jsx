"use client"
import React,{useEffect,useId,useRef,useState} from 'react'
import styles from './BuilderHelp.module.css'
export default function BuilderHelp({label,children}){
 const [open,setOpen]=useState(false),root=useRef(null),id=useId()
 useEffect(()=>{if(!open)return;const close=e=>{if(e.type==='keydown'?e.key==='Escape':!root.current?.contains(e.target))setOpen(false)};window.addEventListener('pointerdown',close);window.addEventListener('keydown',close);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',close)}},[open])
 return <span ref={root} className={styles.root}><button type="button" className={styles.trigger} aria-label={`Nápověda: ${label}`} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)}>?</button>{open&&<span id={id} role="tooltip" className={styles.bubble}>{children}</span>}</span>
}
