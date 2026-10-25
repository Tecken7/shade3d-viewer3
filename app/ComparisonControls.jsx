"use client"
import React, { useEffect, useRef, useState } from "react"
import lighting from "./LightingControls.module.css"
import styles from "./ComparisonControls.module.css"

export default function ComparisonControls({ mode = "comparison", exiting = false, expanded, mobile, onClose, modelA, modelB, onSwap, eyeIcon, tolerance, onToleranceChange, ready, calculating, computed, onCalculate, stats, visible, onVisibleChange }) {
  const occlusion = mode === "occlusion"
  const title = occlusion ? "Okluze" : "Porovnání"
  const mapLabel = occlusion ? "mapu okluze" : "mapu odchylek"
  const root = useRef(null)
  const close = useRef(null)
  const [swapping, setSwapping] = useState(false)
  const swapTimer = useRef(null)
  useEffect(() => { close.current?.focus(); return () => clearTimeout(swapTimer.current) }, [])
  const swap = () => {
    if (!ready || calculating || swapping) return
    setSwapping(true)
    onSwap()
    swapTimer.current = setTimeout(() => setSwapping(false), 360)
  }
  return <section ref={root} data-exiting={exiting || undefined} aria-hidden={exiting || undefined} inert={exiting ? "" : undefined} className={`${lighting.card} ${styles.card} ${mobile ? styles.mobile : ""}`} style={{ right: mobile ? 10 : expanded ? 320 : 78 }} role="dialog" aria-label={occlusion ? "Okluze modelů" : "Porovnání modelů"}>
    <header><strong>{title}</strong><button ref={close} type="button" className={styles.close} onClick={onClose} aria-label={occlusion ? "Zavřít okluzi" : "Zavřít porovnání"}>×</button></header>
    <div className={styles.models} data-swapping={swapping || undefined}>
      <div className={styles.field}><span>Analyzovaný model</span>{modelA}</div>
      <div className={styles.field}><span>Referenční model</span>{modelB}</div>
      <button className={styles.swap} type="button" disabled={!ready || calculating || swapping} onClick={swap} aria-label="Vyměnit modely" title="Vyměnit modely">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4" /></svg>
      </button>
    </div>
    {!occlusion && <label className={`${lighting.row} ${styles.tolerance}`}><span>Tolerance shody <b>{tolerance.toFixed(2)} mm</b></span><input aria-label="Tolerance shody" type="range" min={.05} max={1} step={.01} value={tolerance} disabled={calculating} onChange={event => onToleranceChange(Number(event.target.value))} /></label>}
    <button className={styles.calculate} type="button" disabled={!ready || calculating} onClick={onCalculate}>{calculating ? "Počítám…" : occlusion ? (computed ? "Přepočítat okluzi" : "Vypočítat okluzi") : (computed ? "Přepočítat porovnání" : "Vypočítat porovnání")}</button>
    {computed && (occlusion || stats) && <div className={styles.result}>
      <div className={styles.resultHeader}><span>Výpočet dokončen</span><span aria-hidden="true">✓</span></div>
      <div className={styles.visibility}><span>{occlusion ? "Mapa okluze" : "Mapa odchylek"}</span><button type="button" className={styles.eye} aria-label={visible ? `Skrýt ${mapLabel}` : `Zobrazit ${mapLabel}`} aria-pressed={visible} onClick={() => onVisibleChange(!visible)} title={visible ? `Skrýt ${mapLabel}` : `Zobrazit ${mapLabel}`}><img src={eyeIcon} width={14} height={14} alt="" /></button></div>
      {!occlusion && stats && <dl>{[["Průměrná odchylka", `${stats.mean.toFixed(3)} mm`], ["RMS", `${stats.rms.toFixed(3)} mm`], ["95. percentil", `${stats.percentile95.toFixed(3)} mm`], ["Maximum", `${stats.max.toFixed(3)} mm`], ["V toleranci", `${stats.withinTolerance.toFixed(1)} %`]].map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>}
      {occlusion && <p className={styles.hint}>Záporná hodnota znamená průnik. Dvojklikem připnete hodnotu do scény.</p>}
    </div>}
  </section>
}
