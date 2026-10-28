'use client'
import React,{useRef} from 'react'
import styles from './BuilderControls.module.css'

function ModeIcon({kind}){
  return <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='shell'?<><ellipse cx="16" cy="8" rx="10" ry="4"/><ellipse cx="16" cy="8" rx="6" ry="2"/><path d="M6 8v15c0 5 20 5 20 0V8M10 9v14M22 9v14"/><path d="M6 22c0 5 20 5 20 0"/></>:kind==='bevel'?<><path d="m5 10 11-5 11 5v12l-4 4H9l-4-4zM5 22h22M9 26v-4m14 4v-4M5 10l11 5 11-5M16 15v7"/></>:<><path d="M5 12v11c3 5 19 5 22 0V12M5 12c2-8 20-8 22 0M5 20c3 5 19 5 22 0"/><ellipse cx="9" cy="19" rx="2" ry="3"/><ellipse cx="23" cy="19" rx="2" ry="3"/></>}
  </svg>
}
function Mode({label,value,active,disabled,onClick,kind}){
 return <button type="button" className={styles.mode} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}><span className={styles.icon}><ModeIcon kind={kind}/></span><span className={styles.modeText}><span>{label}</span><strong>{value}</strong></span><span className={styles.switch} aria-hidden="true"><i/></span></button>
}
export function BuilderControls({options:p,change,busy,locked=false,cancel,height,minHeight,maxHeight,onHeightChange,heightDraft,onHeightDraft,onCommitHeight}){
 const savedBevel=useRef(p.bevel||1)
 const toggleBevel=()=>{if(p.bevel>0){savedBevel.current=p.bevel;change({bevel:0})}else change({bevel:Math.min(savedBevel.current,2,p.wall*.7)})}
 return <aside className={`artheticBuilderControls ${styles.panel}`} aria-label="Nastavení Model Builderu">
  <h2>Nastavení báze</h2>
  <fieldset disabled={busy||locked}>
   <Mode label="Dutý model" value={p.hollow?'Dutý':'Plný'} kind="shell" active={p.hollow} onClick={()=>change({hollow:!p.hollow})}/>
   <Mode label="Bevel" value={p.bevel>0?'Zapnuto':'Vypnuto'} kind="bevel" active={p.bevel>0} onClick={toggleBevel}/>
   <Mode label="Odtokové otvory" value={p.hollow&&p.drainsEnabled!==false?'Zapnuto':'Vypnuto'} kind="drains" active={p.hollow&&p.drainsEnabled!==false} disabled={!p.hollow} onClick={()=>change({drainsEnabled:p.drainsEnabled===false})}/>
   <div className={styles.height}>
    <div className={styles.heightHeading}><label htmlFor="builder-base-height">Celková výška</label><span className={styles.exactHeight}><input aria-label="Přesná celková výška modelu v milimetrech" inputMode="decimal" value={heightDraft} onChange={e=>onHeightDraft(e.target.value)} onBlur={e=>onCommitHeight(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur()}if(e.key==='Escape'){onHeightDraft(height.toFixed(2));e.currentTarget.value=height.toFixed(2);e.currentTarget.blur()}}}/><span>mm</span></span></div>
    <input id="builder-base-height" aria-label="Celková výška báze" type="range" min={minHeight} max={maxHeight} step=".01" value={height} onChange={e=>onHeightChange(e.target.value)}/>
   </div>
  </fieldset>
  {busy&&<button type="button" className={styles.cancel} onClick={cancel}>Zrušit výpočet</button>}
 </aside>
}
