'use client'
import React, { useMemo } from 'react'
import { createPortal, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { TransformControls, Html } from '@react-three/drei'
import { contourPosition, nearestContourPosition, seatHoleOnContour } from './hole-placement.mjs'

const fieldStyle = { width: '100%', boxSizing: 'border-box', background: '#252525', color: '#eee', border: '1px solid #484848', padding: '7px 8px', borderRadius: 6 }
function NumberField({ label, value, onChange, min, max, step = 0.1 }) {
  return <label style={{ display: 'grid', gap: 5, fontSize: 12 }}>{label}<input aria-label={label} style={fieldStyle} type="number" min={min} max={max} step={step} value={value} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber) }} /></label>
}
export function BuilderControls({ options: p, change, selected, select, placing, setPlacing, dirty, busy, cancel, hasPreview, cutHoles }) {
  const hole = selected?.startsWith('hole:') ? Number(selected.split(':')[1]) : -1
  const editHole = patch => change({ holes: p.holes.map((h, i) => i === hole ? { ...h, ...patch, autoPosition: false, warning: null } : h) })
  const button = (active = false) => ({ ...fieldStyle, width: 'auto', cursor: 'pointer', background: active ? '#3b5645' : '#303030', fontSize: 12 })
  return <aside className="artheticBuilderControls" aria-label="Nastavení Model Builderu" style={{ position: 'absolute', top: 160, right: 18, bottom: 20, width: 292, overflowY: 'auto', overflowX: 'hidden', zIndex: 80, background: 'rgba(22,22,22,.96)', border: '1px solid #444', borderRadius: 12, padding: 16, color: '#ddd', fontFamily: 'system-ui', boxSizing: 'border-box' }}>
    <style>{`.artheticBuilderControls button:not(:disabled):hover {filter:brightness(1.25);border-color:#93c5fd!important}.artheticBuilderControls input:hover,.artheticBuilderControls select:hover {border-color:#93c5fd!important}.artheticBuilderControls button {transition:filter .12s,border-color .12s}`}</style>
    <h2 style={{ fontSize: 16, margin: '0 0 10px' }}>Nastavení modelu</h2>
    <p style={{ fontSize: 12, color: '#bbb', lineHeight: 1.5 }}>Dutina je zespodu otevřená. Bez rozšíření báze a bez výplně.</p>
    {busy && <button type="button" style={button()} onClick={cancel}>Zrušit výpočet</button>}
    <fieldset disabled={busy} style={{ border: 0, minWidth: 0, padding: 0, margin: 0, display: 'grid', gap: 14 }}>
      <label style={{ fontSize: 13 }}><input type="checkbox" checked={p.hollow} onChange={e => change({ hollow: e.target.checked })} /> Dutý model</label>
      <label style={{ fontSize: 12 }}><input type="checkbox" checked={!!p.flipBaseDirection} onChange={e => change({ flipBaseDirection:e.target.checked })} /> Obrátit směr tvorby báze</label>
      {p.hollow && <NumberField label="Tloušťka stěny (mm)" value={p.wall} min={0.8} max={10} onChange={wall => change({ wall })} />}
      <NumberField label="Spodní bevel (mm)" value={p.bevel} min={0} max={Math.min(2, p.wall * 0.7)} onChange={bevel => change({ bevel })} />
      <p style={{ margin: 0, fontSize: 11, color: '#aaa' }}>Výchozí bevel 1 mm / 45° odpovídá dodanému modelu z Meditu.</p>
      <NumberField label="Vyhlazení okraje (mm)" value={p.smoothing ?? 0.8} min={0} max={2} onChange={smoothing => change({ smoothing })} />
      <p style={{ margin: 0, fontSize: 11, color: '#aaa' }}>Vyhlazuje jen úzký pás u ořezu a napojení na bázi. Nula vyhlazení vypne.</p>
      <NumberField label="Zaoblení napojení scanu (mm)" value={p.rounding ?? 1} min={0} max={3} onChange={rounding => change({ rounding })} />
      <p style={{ margin: 0, fontSize: 11, color: '#aaa' }}>Plynulý přechod scanu do stěny báze. Hodnota určuje šířku upravovaného pásu; nula zachová ostré napojení.</p>
      <hr style={{ width: '100%', border: 0, borderTop: '1px solid #444' }} />
      <strong style={{ fontSize: 13 }}>Popisek</strong>
      <label style={{ display: 'grid', gap: 5, fontSize: 12 }}>Text<input aria-label="Text popisku" style={fieldStyle} maxLength={60} value={p.text} onChange={e => change({ text: e.target.value })} /></label>
      <label style={{ display: 'grid', gap: 5, fontSize: 12 }}>Provedení<select aria-label="Provedení popisku" style={fieldStyle} value={p.textMode} onChange={e => change({ textMode: e.target.value })}><option value="emboss">Vystouplý</option><option value="engrave">Vyrytý</option></select></label>
      <NumberField label="Vystoupení / hloubka textu (mm)" value={p.textDepth} min={0.1} max={3} onChange={textDepth => change({ textDepth })} />
      <NumberField label="Velikost textu (mm)" value={p.textSize} min={1} max={12} onChange={textSize => change({ textSize })} />
      <NumberField label="Otočení textu (°)" value={p.textRotation} min={-180} max={180} step={5} onChange={textRotation => change({ textRotation })} />
      <button disabled={!hasPreview || !p.text.trim()} type="button" style={button(selected === 'text' && placing)} onClick={() => { select('text'); setPlacing(!(selected === 'text' && placing)) }}>Umístit popisek na stěnu</button>
      <hr style={{ width: '100%', border: 0, borderTop: '1px solid #444' }} />
      <strong style={{ fontSize: 13 }}>Odtokové otvory</strong>
      <p style={{ margin: 0, fontSize: 11, color: '#aaa', lineHeight: 1.5 }}>Modré válce jsou pouze náhled. Táhněte je podél spodního obvodu a nastavte průměr i hloubku. Model se vyřízne až po potvrzení.</p>
      <NumberField label="Odklon otvorů od stěny (°)" value={p.holeYaw ?? 0} min={-75} max={75} step={1} onChange={holeYaw => change({ holeYaw })} />
      {hasPreview && <button type="button" style={button()} onClick={() => { change({ holes: [] }); select(null) }}>Obnovit návrh otvorů</button>}
      {!p.holes.length && <span style={{ fontSize: 12 }}>První náhled navrhne dva otvory Ø 4,5 mm. Jejich polohu zkontrolujte.</span>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>{p.holes.map((h, i) => <button key={i} type="button" style={button(hole === i)} onClick={() => { select(`hole:${i}`); setPlacing(false) }}>Otvor {i + 1}{h.enabled ? '' : ' (vyp.)'}</button>)}</div>
      {hole >= 0 && p.holes[hole] && <>
        <label style={{ fontSize: 12 }}><input type="checkbox" checked={p.holes[hole].enabled} onChange={e => editHole({ enabled: e.target.checked })} /> Aktivní otvor</label>
        <NumberField label="Průměr otvoru (mm)" value={p.holes[hole].diameter} min={1} max={15} onChange={diameter => editHole({ diameter })} />
        <NumberField label="Zapuštění od spodní hrany (mm)" value={p.holes[hole].heightOffset ?? 0.5} min={0} max={15} onChange={heightOffset => editHole({ heightOffset, position:seatHoleOnContour(p.bottomContour,{...p.holes[hole],heightOffset}) })} />
        <NumberField label="Natočení vybraného válce (°)" value={p.holes[hole].yaw ?? 0} min={-180} max={180} step={1} onChange={yaw => editHole({ yaw })} />
        {p.bottomContour?.length > 0 && <label style={{ display: 'grid', gap: 5, fontSize: 12 }}>Poloha po spodním obvodu
          <input aria-label="Poloha otvoru po spodním obvodu" type="range" min={0} max={100} step={0.1} value={nearestContourPosition(p.bottomContour, p.holes[hole].position).fraction * 100} onChange={e => editHole({ position: seatHoleOnContour(p.bottomContour,p.holes[hole],contourPosition(p.bottomContour, Number(e.target.value) / 100)) })} />
        </label>}
        <NumberField label="Hloubka řezu otvoru (mm)" value={p.holes[hole].length} min={0.5} max={50} onChange={length => editHole({ length, autoDepth: false })} />
        <NumberField label="Vnější délka válce (mm)" value={p.holes[hole].outerLength ?? p.holes[hole].length} min={0.5} max={50} onChange={outerLength => editHole({ outerLength })} />
        {p.hollow && p.holes[hole].enabled && p.holes[hole].through === false && p.cutHoles && !dirty && <p role="status" style={{ color: '#f4d28b', fontSize: 12, margin: 0 }}>Otvor není průchozí po celém průřezu. Prodlužte hloubku nebo posuňte válec a znovu potvrďte řez.</p>}
      </>}
      {hasPreview && <button type="button" style={button(true)} disabled={!p.holes.some(h => h.enabled) || p.cutHoles} onClick={cutHoles}>{p.cutHoles ? 'Otvory jsou vyříznuté' : 'Potvrdit a vyříznout otvory'}</button>}

      {selected === "text" && hasPreview && <p style={{ fontSize: 12, color: '#bfe5c8', margin: 0 }}>Polohu vybraného prvku můžete posunout tažením barevných os v modelu. Kliknutím na stěnu prvek přemístíte; směr otvorů nastavíte společně.</p>}
    </fieldset>
    <p role="status" style={{ color: dirty ? '#f4d28b' : '#bfe5c8', fontSize: 12, lineHeight: 1.5 }}>{dirty && hasPreview ? 'Změny otvorů potvrďte tlačítkem „Potvrdit a vyříznout otvory“. Změny samotné základny přepočítejte v horní liště.' : hasPreview ? p.cutHoles ? 'Otvory jsou součástí modelu.' : 'Základna je bez otvorů. Modré válce čekají na potvrzení.' : 'Nastavte výšku a vytvořte první náhled.'}</p>
  </aside>
}

export function BuilderHandle({ selected, options, change, dragging }) {
  const target = useMemo(() => new THREE.Group(), [])
  const { scene } = useThree()
  const index = selected?.startsWith('hole:') ? Number(selected.split(':')[1]) : -1
  const position = index >= 0 ? options.holes[index]?.position : selected === 'text' ? options.textPosition : null
  if (!position || index >= 0) return null
  const commit = () => {
    const next = target.position.toArray()
    if (index >= 0) change({ holes: options.holes.map((h, i) => i === index ? { ...h, position: next, enabled: true, autoPosition: false, warning: null } : h) })
    else change({ textPosition: next })
  }
  return <>
    <primitive object={target} position={position}>
      <mesh raycast={()=>null}><sphereGeometry args={[0.65, 12, 12]} /><meshBasicMaterial color="#8eeeb1" depthTest transparent opacity={0.9} /></mesh>
      <Html occlude position={[0, 1.5, 0]} center style={{ pointerEvents: 'none', fontSize: 11, whiteSpace: 'nowrap', background: '#222', color: '#cfeeda', padding: 4, borderRadius: 4 }}>{index >= 0 ? `Otvor ${index + 1}` : 'Popisek'}</Html>
    </primitive>
    {createPortal(<TransformControls onUpdate={control=>control.traverse?.(child=>{for(const material of Array.isArray(child.material)?child.material:[child.material])if(material)material.depthTest=true})} object={target} mode="translate" showX showY showZ size={0.65} onMouseDown={() => dragging(true)} onMouseUp={() => { commit(); dragging(false) }} />, scene)}
  </>
}
