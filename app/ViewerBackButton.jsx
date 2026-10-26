import React from 'react'
import styles from './ViewerBackButton.module.css'

export default function ViewerBackButton({onClick,disabled=false}) {
  return <button type="button" className={styles.button} onClick={onClick} disabled={disabled} aria-label="Zpět do prohlížeče">
    <span className={styles.brand}><span className={styles.main}><b>ART</b><span>HETIC</span></span><span className={styles.sub}>CASE CLOUD</span></span>
    <span className={styles.arrow} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5m7 7-7-7 7-7" /></svg></span>
  </button>
}
