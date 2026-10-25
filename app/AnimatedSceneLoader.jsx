"use client"
import { useEffect, useState } from 'react'
export function useLoaderPresence(active) {
  const [phase, setPhase] = useState(active ? 'loading' : 'hidden')
  useEffect(() => {
    if (active) { setPhase('loading'); return }
    if (phase === 'hidden') return
    setPhase('complete')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const fade = setTimeout(() => setPhase('exiting'), reduced ? 0 : 200)
    const hide = setTimeout(() => setPhase('hidden'), reduced ? 0 : 620)
    return () => { clearTimeout(fade); clearTimeout(hide) }
  }, [active])
  return { visible: active || phase !== 'hidden', exiting: !active && phase === 'exiting' }
}
export default function AnimatedSceneLoader({visible,exiting,status,progress,progressLabel="Načítání CBCT"}) {
  if (!visible) return null
  const percent = Math.round(Math.max(0,Math.min(100,progress)))
  return <div data-dicom-loader="true" style={{position:'absolute',inset:0,zIndex:10000,background:'rgba(0,0,0,.42)',backdropFilter:'blur(2px)',WebkitBackdropFilter:'blur(2px)',display:'flex',alignItems:'center',justifyContent:'center',opacity:exiting?0:1,transition:'opacity .42s ease-out',pointerEvents:exiting?'none':'auto',color:'white',fontFamily:'Inter,ui-sans-serif,system-ui,sans-serif'}}>
    <div role="status" aria-live="polite" aria-label={status} style={{boxSizing:'border-box',width:266,maxWidth:'calc(100vw - 40px)',padding:22,borderRadius:16,background:'rgba(12,12,12,.96)',border:'1px solid rgba(255,255,255,.09)',boxShadow:'0 24px 70px rgba(0,0,0,.52)',transform:exiting?'translateY(-6px) scale(.985)':'translateY(0) scale(1)',transition:'transform .42s ease-out'}}>
      <div className="scene-loading-mark" role="img" aria-label="ARTHETIC"><img src="/arthetic-loader-mark.svg" alt="" width={220} height={34} draggable={false}/><span className="scene-loading-mask" aria-hidden="true"><span className="scene-loading-sweep"/></span></div>
      <div className="scene-loading-track" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span className="scene-loading-fill" style={{transform:`scaleX(${percent/100})`}}/><span className="scene-loading-activity" aria-hidden="true"/></div>
      <div style={{marginTop:10,display:'flex',justifyContent:'space-between',gap:8,color:'#a3a3a3',fontSize:10,fontWeight:600,fontVariantNumeric:'tabular-nums'}}><span>{status}</span><span style={{flexShrink:0}}>{percent} %</span></div>
    </div>
  </div>
}
