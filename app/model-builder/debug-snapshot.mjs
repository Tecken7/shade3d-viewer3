import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { zipSync, strToU8 } from 'fflate'

export function createDebugSnapshot(scans, previewGeometry, context) {
  const files = {}, inventory = []
  const exporter = new STLExporter()
  const serialize = geometry => {
    const material = new THREE.MeshBasicMaterial()
    try {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.updateMatrixWorld(true)
      const buffer = exporter.parse(mesh, { binary: true })
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } finally { material.dispose() }
  }
  for (const scan of scans) {
    const geometry = new THREE.BufferGeometry()
    try {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(scan.positions, 3))
      const filename = `${scan.arch}_rozpracovany_scan.stl`
      files[filename] = serialize(geometry)
      inventory.push({ arch:scan.arch, sourceName:scan.name, file:filename, triangles:scan.positions.length / 9 })
    } finally { geometry.dispose() }
  }
  if (previewGeometry) files['posledni_nahled_zakladny.stl'] = serialize(previewGeometry)
  if (!inventory.length && !previewGeometry) throw new Error('Scan ještě není načtený. Zkuste stažení za okamžik.')
  files['stav_model_builderu.json'] = strToU8(JSON.stringify({
    format:'arthetic-model-builder-debug-v1', ...context, scans:inventory,
    previewIncluded:!!previewGeometry,
  }, null, 2))
  files['CTETE_ME.txt'] = strToU8('Rozpracovaný Model Builder\n\nSTL soubory obsahují skutečně provedené úpravy scanů v aktuální orientaci. Neprovedené náhledy doplnění a ořezové křivky jsou pouze v záznamu stavu.\nPoslední náhled základny může být starší než nastavené parametry; zkontrolujte previewDirty v záznamu stavu. Modré návrhové válce nejsou součástí STL.\nZIP slouží k předání problému, nikoli k obnovení celé relace editoru.\n')
  return zipSync(files, { level:1 })
}
