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
  const clip=selecting?'selection':'points'
  return <video key={clip} ref={videoRef} className={styles.video} width="480" height="360" muted loop playsInline preload="metadata" poster={`/guides/builder-trim-${clip}.webp`} src={selecting?'/guides/builder-trim-selection-zoom-upper-left.mp4':'/guides/builder-trim-points-zoom.mp4'} aria-hidden="true" disablePictureInPicture/>
}
