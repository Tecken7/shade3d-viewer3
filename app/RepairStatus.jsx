import React from 'react'
import styles from './RepairStatus.module.css'

export function RepairCheck() {
  return <span className={styles.check} aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><path d="m4 8 2.6 2.6L12 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
}
export function RepairStep({active, done, children}) {
  return <div className={styles.step} data-active={active || undefined} aria-current={active ? 'step' : undefined}>{done && <RepairCheck />}<span>{children}</span></div>
}
export default function RepairStatus({clear, verticesChecked, report}) {
  return <div className={styles.statuses} role="status" aria-live="polite">
    {clear && <div className={styles.status}><RepairCheck /><span>Otevřené hrany <b>0</b></span></div>}
    {verticesChecked ? <div className={styles.status} title={report}><RepairCheck /><span>Vrcholky v toleranci</span></div> : report && <div className={styles.notice}>{report}</div>}
  </div>
}
