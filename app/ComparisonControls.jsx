"use client"
import React, { useEffect, useRef } from "react"
import lighting from "./LightingControls.module.css"
import styles from "./ComparisonControls.module.css"

export default function ComparisonControls({ expanded, mobile, onClose, modelA, modelB, tolerance, onToleranceChange, ready, calculating, computed, onCalculate, stats, visible, onVisibleChange }) {
  const root = useRef(null)
  const close = useRef(null)
  useEffect(() => {
    close.current?.focus()
    const key = event => { if (event.key === "Escape") onClose() }
    const outside = event => {
      if (!root.current?.contains(event.target) && !event.target.closest?.('[data-tool-id="porovnani"]')) onClose()
    }
    document.addEventListener("keydown", key)
    document.addEventListener("pointerdown", outside)
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside) }
  }, [onClose])
  return <section ref={root} className={`${lighting.card} ${styles.card} ${mobile ? styles.mobile : ""}`} style={{ right: mobile ? 10 : expanded ? 320 : 78 }} role="dialog" aria-label="Porovnání modelů">
    <header><strong>Porovnání</strong><button ref={close} type="button" className={styles.close} onClick={onClose} aria-label="Zavřít porovnání">×</button></header>
    <div className={styles.field}><span>Analyzovaný model</span>{modelA}</div>
    <div className={styles.field}><span>Referenční model</span>{modelB}</div>
    <label className={`${lighting.row} ${styles.tolerance}`}><span>Tolerance shody <b>{tolerance.toFixed(2)} mm</b></span><input aria-label="Tolerance shody" type="range" min={.05} max={50} step={.05} value={tolerance} disabled={calculating} onChange={event => onToleranceChange(Number(event.target.value))} /></label>
    <button className={styles.calculate} type="button" disabled={!ready || calculating} onClick={onCalculate}>{calculating ? "Počítám…" : computed ? "Přepočítat porovnání" : "Vypočítat porovnání"}</button>
    {computed && stats && <div className={styles.result}>
      <div className={styles.resultHeader}><span>Výpočet dokončen</span><span aria-hidden="true">✓</span></div>
      <label className={styles.visibility}><span>Zobrazit mapu odchylek</span><input type="checkbox" role="switch" checked={visible} onChange={event => onVisibleChange(event.target.checked)} /></label>
      <dl>{[["Průměrná odchylka", `${stats.mean.toFixed(3)} mm`], ["RMS", `${stats.rms.toFixed(3)} mm`], ["95. percentil", `${stats.percentile95.toFixed(3)} mm`], ["Maximum", `${stats.max.toFixed(3)} mm`], ["V toleranci", `${stats.withinTolerance.toFixed(1)} %`]].map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
    </div>}
  </section>
}
