"use client"
import React from "react"
import styles from "./SliceEmptyState.module.css"
export default function SliceEmptyState({ awaiting = true }) {
  return <div className={styles.empty} role="status">
    {awaiting && <svg className={styles.demo} width="200" height="130" viewBox="0 0 200 130" fill="none" aria-hidden="true">
      <path d="M48 91V59a52 36 0 0 1 104 0v32h-19V60a33 20 0 0 0-66 0v31Z" stroke="#a3aaa5" strokeWidth="2.5" strokeLinejoin="round"/>
      <path className={styles.cut} d="M29 101 169 27" stroke="#bfd5c4" strokeWidth="2.5" strokeDasharray="6 6" strokeLinecap="round"/>
      <g className={styles.cursor}><path d="m0 0 2 19 5-6 7 1Z" fill="#dfe9e2" stroke="#171c19" strokeWidth="1.5"/></g>
    </svg>}
    <strong>{awaiting ? "Nakreslete čáru přes sken" : "Řez neprotíná viditelný model"}</strong>
    <span>{awaiting ? "Tažením nakreslíte řez. Shift + tažení otočí model." : "Posuňte rovinu nebo nakreslete nový řez."}</span>
  </div>
}
