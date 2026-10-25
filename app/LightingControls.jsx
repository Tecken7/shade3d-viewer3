"use client"
import React, { useEffect, useRef } from "react"
import { DEFAULT_LIGHTING, LIGHTING_PRESETS } from "./viewer/scene-lighting.mjs"
import styles from "./LightingControls.module.css"
export default function LightingControls({ value, onChange, onClose, expanded, offset = 0 }) {
 const root = useRef(null), close = useRef(null)
 useEffect(() => { close.current?.focus() }, [])
 const update = (key, next) => onChange({ ...value, [key]: next, preset: "custom" })
 const direction = event => {
  const box = event.currentTarget.getBoundingClientRect()
  update('azimuth', Math.round(Math.atan2(event.clientX-box.left-box.width/2, -(event.clientY-box.top-box.height/2))*180/Math.PI))
 }
 const rad = value.azimuth*Math.PI/180
 return <section ref={root} className={styles.card} style={{ right: (expanded ? 320 : 78) + offset, maxWidth: `calc(100vw - ${(expanded ? 320 : 78) + offset + 20}px)` }} role="dialog" aria-label="Nasvícení scény">
  <header><strong>Nasvícení</strong><button ref={close} onClick={onClose} aria-label="Zavřít nasvícení">×</button></header>
  <div className={styles.presets}>{[['default','Výchozí'],['even','Rovnoměrné'],['detail','Detail povrchu']].map(([id,label]) => <button key={id} aria-pressed={value.preset===id} onClick={() => onChange({ ...LIGHTING_PRESETS[id] })}>{label}</button>)}</div>
  <label className={styles.row}><span>Jas <b>{Math.round(value.brightness*100)} %</b></span><input aria-label="Jas scény" type="range" min=".2" max="2" step=".01" value={value.brightness} onChange={event=>update('brightness',Number(event.target.value))}/></label>
  <div className={styles.direction}>
   <div role="slider" tabIndex={0} aria-label="Směr světla" aria-valuemin={-180} aria-valuemax={180} aria-valuenow={value.azimuth} aria-valuetext={`${value.azimuth} stupňů`} className={styles.dial}
    onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);direction(event)}} onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))direction(event)}}
    onKeyDown={event=>{if(['ArrowLeft','ArrowDown','ArrowRight','ArrowUp','Home'].includes(event.key)){event.preventDefault();update('azimuth',event.key==='Home'?0:Math.max(-180,Math.min(180,value.azimuth+(['ArrowLeft','ArrowDown'].includes(event.key)?-5:5))))}}}>
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="35" fill="none" stroke="#ffffff25"/><path d="M50 8v8m0 68v8M8 50h8m68 0h8" stroke="#ffffff35"/><path d={`M50 50L${50+Math.sin(rad)*35} ${50-Math.cos(rad)*35}`} stroke="#dedede"/><circle cx={50+Math.sin(rad)*35} cy={50-Math.cos(rad)*35} r="6" fill="#eeeeee"/><circle cx="50" cy="50" r="3" fill="#868686"/></svg>
   </div><div><span>Směr světla</span><b>{value.azimuth}°</b><small>Táhněte po kruhu</small></div>
  </div>
  <label className={styles.row}><span>Výška světla <b>{value.elevation}°</b></span><input aria-label="Výška světla" type="range" min="5" max="85" step="1" value={value.elevation} onChange={event=>update('elevation',Number(event.target.value))}/></label>
  <label className={styles.row}><span>Měkkost stínování <b>{Math.round(value.softness*100)} %</b></span><input aria-label="Měkkost stínování" type="range" min="0" max="1" step=".01" value={value.softness} onChange={event=>update('softness',Number(event.target.value))}/></label>
  <button className={styles.reset} onClick={()=>onChange({ ...DEFAULT_LIGHTING })}>Reset</button>
 </section>
}
