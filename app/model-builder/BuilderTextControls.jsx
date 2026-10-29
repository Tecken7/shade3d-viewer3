'use client'
import React from 'react'
import FontWeightSelect from './FontWeightSelect'
import styles from './BuilderControls.module.css'

export default function BuilderTextControls({options:p,change,busy,cancel,placing,selected,setPlacing,select,textStatus,logoStatus}){
 const field=(label,key,min,max,step=.1)=><label className={styles.textField}>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={p[key]} onChange={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))change({[key]:e.target.valueAsNumber})}}/></label>
 return <aside className={`artheticBuilderControls ${styles.panel}`} aria-label="Text modelu">
  <h2>Text modelu</h2>
  <fieldset disabled={busy}>
   <label className={styles.textField}>Text<input aria-label="Text popisku" maxLength={60} value={p.text} onChange={e=>change({text:e.target.value})}/></label>
   <div className={styles.textModes}>
    <button type="button" aria-pressed={p.textMode==='emboss'} onClick={()=>change({textMode:'emboss'})}>Vystouplý</button>
    <button type="button" aria-pressed={p.textMode==='engrave'} onClick={()=>change({textMode:'engrave'})}>Vyrytý</button>
   </div>
   <div className={styles.textField}><span>Řez písma Inter</span><FontWeightSelect value={p.textWeight} disabled={busy} onChange={value=>change({textWeight:value})}/></div>
   {field('Velikost textu (mm)','textSize',1,12)}
   {field('Hloubka textu (mm)','textDepth',.1,3)}
   {field('Otočení textu (°)','textRotation',-180,180,5)}
   <button type="button" aria-pressed={placing&&selected==='text'} disabled={!p.text.trim()} onClick={()=>{select('text');setPlacing(!(placing&&selected==='text'))}}>{placing&&selected==='text'?'Klikněte na model':'Umístit text na model'}</button>
   {p.text.trim()&&<p role="status">{textStatus?.error||'Kliknutím umístěte text, tažením otáčejte modelem. Umístěný text přesunete tažením za písmena.'}</p>}
   <div className={styles.logoSection}>
    <button type="button" className={styles.mode} aria-label="Logo laboratoře" aria-pressed={!!p.textLogoEnabled} onClick={()=>change({textLogoEnabled:!p.textLogoEnabled})}><span className={styles.modeText}>Logo laboratoře<strong>Designed by ARTHETIC · uvnitř dutiny</strong></span><span className={styles.switch} aria-hidden="true"><i/></span></button>
    {p.textLogoEnabled&&<>{field('Velikost podpisu (mm)','textLogoSize',1,6)}<div className={styles.textModes}><button type="button" disabled={logoStatus?.searching} onClick={()=>{select('logo');change({textLogoPosition:null,textLogoNormal:null,textLogoSearchNonce:(p.textLogoSearchNonce||0)+1})}}>Najít místo</button><button type="button" aria-pressed={placing&&logoStatus?.placing} onClick={()=>{select('logo');setPlacing(!(placing&&logoStatus?.placing))}}>{placing&&logoStatus?.placing?'Klikněte na model':'Umístit logo'}</button></div><p role="status">{logoStatus?.error||'Logo můžete přesunout tažením za písmena.'}</p></>}
   </div>
  </fieldset>
  {busy&&<button type="button" className={styles.cancel} onClick={cancel}>Zrušit výpočet</button>}
 </aside>
}
