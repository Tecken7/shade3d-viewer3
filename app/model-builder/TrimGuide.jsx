"use client"
import {useEffect,useRef} from 'react'
import styles from './TrimGuide.module.css'

export default function TrimGuide({selecting=false}) {
  const videoRef=useRef(null)
  useEffect(()=>{
    const video=videoRef.current
    if(!video)return
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync=()=>{
      if(preference.matches||document.hidden)video.pause()
      else video.play().catch(()=>{})
    }
    sync()
    preference.addEventListener('change',sync)
    document.addEventListener('visibilitychange',sync)
    return()=>{
      video.pause()
      preference.removeEventListener('change',sync)
      document.removeEventListener('visibilitychange',sync)
    }
  },[selecting])
  if(!selecting)return <video ref={videoRef} className={styles.video} width="480" height="360" muted loop playsInline preload="metadata" poster="/guides/builder-trim-points.webp" src="/guides/builder-trim-points-zoom.mp4" aria-hidden="true" disablePictureInPicture/>
  return <svg className={styles.guide} data-selecting={selecting||undefined} viewBox="0 0 88 54" fill="none" aria-hidden="true">
    <path d="M13 43V25C13 4 75 4 75 25v18H62V26c0-10-36-10-36 0v17Z" fill="#ffffff06" stroke="#989898" strokeWidth="1.4" strokeLinejoin="round"/>
    <path className={styles.region} d="M18 37V25c0-17 52-17 52 0v12h-4V25c0-13-44-13-44 0v12Z" fill="#fff" fillOpacity=".22"/>
    <path className={styles.line} d="M18 37V25c0-17 52-17 52 0v12" stroke="#eee" strokeWidth="1.5" strokeDasharray="3 3"/>
    {[[18,37],[28,16],[59,16],[70,37]].map(([cx,cy],i)=><circle key={i} className={styles.point} style={{'--i':i}} cx={cx} cy={cy} r="2.6" fill="#eee"/>)}
    <g className={styles.cursor}><path d="m0 0 1 12 3-4 5 1Z" fill="#eee" stroke="#202020" strokeWidth="1"/><circle className={styles.click} r="6" stroke="#fff" strokeWidth="1.2"/></g>
  </svg>
}
