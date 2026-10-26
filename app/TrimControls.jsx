import React from 'react'
import { RepairCheck, RepairStep } from './RepairStatus'
import actions from './RepairToolbar.module.css'
import styles from './TrimControls.module.css'

export default function TrimControls({ stage, closed, pointCount, busy, message, showMessage, picker, ready, leaving, canUndo, exportBusy, onRemovePoint, onReset, onCloseLoop, onApply, onUndo, onDownload, onFinish }) {
  const done = { model: stage !== 'model', boundary: closed || stage === 'result', region: stage === 'result', result: stage === 'result' }
  return <>
    <section className={styles.workspace} aria-label="Ořez sítě" aria-busy={busy}>
      <h2>Ořez sítě</h2>
      <div className={styles.steps}>
        {[['model','Model'],['boundary','Hranice'],['region','Oblast'],['result','Výsledek']].map(([key,label], index) => <React.Fragment key={key}>
          {index > 0 && <span className={styles.connector} aria-hidden="true" />}
          <RepairStep active={key === stage} done={done[key]}>{label}</RepairStep>
        </React.Fragment>)}
      </div>
      <div className={styles.content}>
        {stage === 'model' ? <div className={styles.task} data-busy={busy || undefined}>
          <div className={styles.picker} aria-hidden={busy || undefined} inert={busy ? '' : undefined}>{picker}</div>
          <div className={styles.preparation} role={busy ? 'status' : undefined} aria-hidden={!busy || undefined}>
            <span className={actions.spinner} /><span>Připravuji povrch modelu…</span>
            <div className={styles.progress}><i /></div>
          </div>
        </div> : <div key={stage} className={styles.stage}>
          {stage === 'result' ? <div className={styles.success}><RepairCheck /><span>Ořez dokončen</span></div> : <>
            <p>{!closed ? 'Klikáním na povrch vytvořte hranici. Body můžete přetahovat; dvojklikem na první bod hranici uzavřete.' : stage === 'boundary' ? 'Kliknutím vyberte část modelu, kterou chcete zachovat.' : 'Zvýrazněná oblast zůstane zachována.'}</p>
            <div className={styles.editActions}>
              {!closed && pointCount > 0 && <button type="button" onClick={onRemovePoint} disabled={busy}>Smazat poslední</button>}
              <button type="button" onClick={onReset} disabled={busy}>Reset hranice</button>
              {!closed && pointCount >= 3 && <button type="button" onClick={onCloseLoop} disabled={busy}>Uzavřít hranici</button>}
            </div>
          </>}
        </div>}
        {showMessage && !busy && <p className={styles.notice} role="status">{message}</p>}
        {(ready || (busy && stage === 'region')) && <div className={actions.actions}>
          <div className={actions.actionPresence}>
            <button type="button" className={actions.primary} data-leaving={(leaving && !busy) || undefined} onClick={onApply} disabled={busy}>
              {busy && <span className={actions.spinner} />} {busy ? 'Ořezávám…' : 'Oříznout'}
            </button>
          </div>
        </div>}
      </div>
    </section>
    {canUndo && <aside className={styles.side} aria-label="Výsledek ořezu">
      <button type="button" onClick={onUndo} disabled={busy || exportBusy}><span aria-hidden="true">↶</span> Undo</button>
      <button type="button" onClick={onDownload} disabled={busy || exportBusy}>{exportBusy ? 'Připravuji…' : 'Stáhnout'}</button>
      {stage === 'result' && <div className={actions.done}><button type="button" className={actions.primary} onClick={onFinish} disabled={busy || exportBusy}>Hotovo</button></div>}
    </aside>}
  </>
}
