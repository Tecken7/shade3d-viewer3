'use client'
import React from 'react'
import styles from './BuilderControls.module.css'

export default function BuilderTextControls({options:p,change,busy,cancel,placing,setPlacing,select,textStatus}){
 const field=(label,key,min,max,step=.1)=><label className={styles.textField}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={p[key]} onChange={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))change({[key]:e.target.valueAsNumber})}}/></label>
 return <aside className={`artheticBuilderControls ${styles.panel}`} aria-label="Text modelu">
  <h2>Text modelu</h2>
  <fieldset disabled={busy}>
   <label className={styles.textField}>Text<input aria-label="Text popisku" maxLength={60} value={p.text} onChange={e=>change({text:e.target.value})}/></label>
   <div className={styles.textModes}>
    <button type="button" aria-pressed={p.textMode==='emboss'} onClick={()=>change({textMode:'emboss'})}>Vystouplý</button>
    <button type="button" aria-pressed={p.textMode==='engrave'} onClick={()=>change({textMode:'engrave'})}>Vyrytý</button>
   </div>
   {field('Velikost textu (mm)','textSize',1,12)}
   {field('Hloubka textu (mm)','textDepth',.1,3)}
   {field('Otočení textu (°)','textRotation',-180,180,5)}
   <button type="button" aria-pressed={placing} disabled={!p.text.trim()} onClick={()=>{select('text');setPlacing(!placing)}}>{placing?'Klikněte na model':'Umístit text na model'}</button>
   {p.text.trim()&&<p role="status">{textStatus?.error||'Text umístěte kliknutím na povrch. Potom ho můžete po modelu posouvat tažením.'}</p>}
  </fieldset>
  {busy&&<button type="button" className={styles.cancel} onClick={cancel}>Zrušit výpočet</button>}
 </aside>
}
