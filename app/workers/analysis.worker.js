import * as THREE from "three"
import { computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh"

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree

const IDENTITY_MATRIX_ARRAY = new THREE.Matrix4().identity().toArray()

// Ve Workeru nemusíme uvolňovat hlavní UI thread. Async body ale zachováváme,
// aby matematika zůstala co nejblíže ověřené legacy implementaci.
async function alignmentYield() {
  await Promise.resolve()
}

function faceNormalLocal(geometry, faceIndex, target, a, b, c) {
  if (!Number.isFinite(faceIndex) || faceIndex < 0) return target.set(0, 0, 1)
  const pos = geometry.attributes.position
  const index = geometry.index
  const offset = faceIndex * 3
  const ia = index ? index.getX(offset) : offset
  const ib = index ? index.getX(offset + 1) : offset + 1
  const ic = index ? index.getX(offset + 2) : offset + 2
  a.fromBufferAttribute(pos, ia)
  b.fromBufferAttribute(pos, ib)
  c.fromBufferAttribute(pos, ic)
  return target.subVectors(b, a).cross(c.sub(a)).normalize()
}

function matrixArrayOrIdentity(value) {
  return Array.isArray(value) && value.length === 16 ? value : IDENTITY_MATRIX_ARRAY
}

function largestEigenvectorSymmetric4(values) {
  // Jacobiho diagonalizace 4x4 symetrické matice. Hornova registration potřebuje
  // vlastní vektor NEJVĚTŠÍ ALGEBRAICKÉ vlastní hodnoty. Obyčejná power iteration
  // zde není bezpečná: Hornova N matice často obsahuje ±lambda se stejnou absolutní
  // velikostí a power iteration pak může skončit u nesprávného quaternionu.
  const a = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => Number(values[r * 4 + c]) || 0)
  )
  const v = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => (r === c ? 1 : 0))
  )

  for (let sweep = 0; sweep < 64; sweep++) {
    let p = 0, q = 1, largest = 0
    for (let r = 0; r < 4; r++) {
      for (let c = r + 1; c < 4; c++) {
        const magnitude = Math.abs(a[r][c])
        if (magnitude > largest) { largest = magnitude; p = r; q = c }
      }
    }
    if (largest < 1e-12) break

    const app = a[p][p]
    const aqq = a[q][q]
    const apq = a[p][q]
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    for (let k = 0; k < 4; k++) {
      if (k === p || k === q) continue
      const akp = a[k][p]
      const akq = a[k][q]
      a[k][p] = a[p][k] = cos * akp - sin * akq
      a[k][q] = a[q][k] = sin * akp + cos * akq
    }

    a[p][p] = cos * cos * app - 2 * sin * cos * apq + sin * sin * aqq
    a[q][q] = sin * sin * app + 2 * sin * cos * apq + cos * cos * aqq
    a[p][q] = a[q][p] = 0

    for (let k = 0; k < 4; k++) {
      const vkp = v[k][p]
      const vkq = v[k][q]
      v[k][p] = cos * vkp - sin * vkq
      v[k][q] = sin * vkp + cos * vkq
    }
  }

  let best = 0
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i
  const result = [v[0][best], v[1][best], v[2][best], v[3][best]]
  const length = Math.hypot(result[0], result[1], result[2], result[3])
  if (!Number.isFinite(length) || length < 1e-12) return null
  return result.map((value) => value / length)
}

function landmarkConfigurationIsDegenerate(points) {
  if (!points || points.length < 3) return true
  let maxBaselineSq = 0
  let maxArea2 = 0
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const cross = new THREE.Vector3()
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      maxBaselineSq = Math.max(maxBaselineSq, points[i].distanceToSquared(points[j]))
      for (let k = j + 1; k < points.length; k++) {
        ab.subVectors(points[j], points[i])
        ac.subVectors(points[k], points[i])
        maxArea2 = Math.max(maxArea2, cross.crossVectors(ab, ac).length())
      }
    }
  }
  if (maxBaselineSq < 1e-10) return true
  // 2*plocha trojúhelníku je |AB x AC|. Povolujeme i poměrně ploché landmarky,
  // ale odmítneme prakticky kolineární konfiguraci, u níž rotace není jednoznačná.
  return maxArea2 < maxBaselineSq * 1e-4
}

function rigidTransformHorn(sourcePoints, targetPoints) {
  const count = Math.min(sourcePoints?.length || 0, targetPoints?.length || 0)
  if (count < 3) return null

  const source = sourcePoints.slice(0, count)
  const target = targetPoints.slice(0, count)
  if (landmarkConfigurationIsDegenerate(source) || landmarkConfigurationIsDegenerate(target)) return null

  const sourceCenter = new THREE.Vector3()
  const targetCenter = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    sourceCenter.add(source[i])
    targetCenter.add(target[i])
  }
  sourceCenter.multiplyScalar(1 / count)
  targetCenter.multiplyScalar(1 / count)

  let sxx = 0, sxy = 0, sxz = 0
  let syx = 0, syy = 0, syz = 0
  let szx = 0, szy = 0, szz = 0
  for (let i = 0; i < count; i++) {
    const a = source[i].clone().sub(sourceCenter)
    const b = target[i].clone().sub(targetCenter)
    sxx += a.x * b.x; sxy += a.x * b.y; sxz += a.x * b.z
    syx += a.y * b.x; syy += a.y * b.y; syz += a.y * b.z
    szx += a.z * b.x; szy += a.z * b.y; szz += a.z * b.z
  }

  const trace = sxx + syy + szz
  const N = [
    trace,        syz - szy,    szx - sxz,     sxy - syx,
    syz - szy,    sxx-syy-szz,  sxy+syx,       szx+sxz,
    szx - sxz,    sxy+syx,     -sxx+syy-szz,   syz+szy,
    sxy - syx,    szx+sxz,      syz+szy,       -sxx-syy+szz,
  ]

  const q = largestEigenvectorSymmetric4(N)
  if (!q) return null

  // Hornův vektor je [w, x, y, z].
  const rotation = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize()
  const rotatedSourceCenter = sourceCenter.clone().applyQuaternion(rotation)
  const translation = targetCenter.clone().sub(rotatedSourceCenter)
  return new THREE.Matrix4().compose(translation, rotation, new THREE.Vector3(1, 1, 1))
}

function solveLinearSystem6(matrix, rhs) {
  const n = 6
  const a = Array.from({ length: n }, (_, r) => {
    const row = new Array(n + 1)
    for (let c = 0; c < n; c++) row[c] = matrix[r * n + c]
    row[n] = rhs[r]
    return row
  })

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]]
    const div = a[col][col]
    for (let c = col; c <= n; c++) a[col][c] /= div
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (Math.abs(factor) < 1e-18) continue
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c]
    }
  }
  return a.map((row) => row[n])
}

function makeClosestSurfaceQuery(targetMesh) {
  targetMesh.updateMatrixWorld(true)
  if (!targetMesh.geometry.boundsTree) targetMesh.geometry.computeBoundsTree()
  const inverseTarget = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert()
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(targetMesh.matrixWorld)
  const localPoint = new THREE.Vector3()
  const closestWorld = new THREE.Vector3()
  const deltaWorld = new THREE.Vector3()
  const normalWorld = new THREE.Vector3()
  const triangleA = new THREE.Vector3(), triangleB = new THREE.Vector3(), triangleC = new THREE.Vector3()
  const result = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }
  const output = { pointWorld: new THREE.Vector3(), normalWorld: new THREE.Vector3(), distance: Infinity, faceIndex: -1 }

  return (worldPoint) => {
    localPoint.copy(worldPoint).applyMatrix4(inverseTarget)
    result.distance = Infinity
    result.faceIndex = -1
    targetMesh.geometry.boundsTree.closestPointToPoint(localPoint, result)
    closestWorld.copy(result.point).applyMatrix4(targetMesh.matrixWorld)
    faceNormalLocal(targetMesh.geometry, result.faceIndex, normalWorld, triangleA, triangleB, triangleC)
      .applyMatrix3(normalMatrix)
      .normalize()
    output.pointWorld.copy(closestWorld)
    output.normalWorld.copy(normalWorld)
    output.distance = deltaWorld.subVectors(worldPoint, closestWorld).length()
    output.faceIndex = result.faceIndex
    return output
  }
}

function sampledVertexIndices(positionCount, desiredCount) {
  if (!positionCount) return []
  const count = Math.min(positionCount, Math.max(100, desiredCount || positionCount))
  const step = positionCount / count
  const result = new Array(count)
  for (let i = 0; i < count; i++) result[i] = Math.min(positionCount - 1, Math.floor((i + 0.37) * step))
  return result
}

async function robustPointToPlaneICP({
  sourceMesh,
  sourceRoot,
  targetMesh,
  targetRoot,
  initialMatrix,
  targetDiagonalOverride = null,
  landmarkSeeded = false,
  onProgress,
}) {
  if (!sourceMesh || !sourceRoot || !targetMesh || !targetRoot) throw new Error("Chybí model pro Best Fit.")

  sourceRoot.updateMatrixWorld(true)
  targetRoot.updateMatrixWorld(true)
  sourceMesh.updateMatrixWorld(true)
  targetMesh.updateMatrixWorld(true)

  const sourcePosition = sourceMesh.geometry.getAttribute("position")
  if (!sourcePosition?.count) throw new Error("Moving model nemá použitelnou geometrii.")

  // Geometrii Moving B držíme v lokálním prostoru jeho kořenového objektu.
  // ICP transformaci řešíme v prostoru společného parentu modelů.
  const sourceRootInverse = new THREE.Matrix4().copy(sourceRoot.matrixWorld).invert()
  const meshToRoot = new THREE.Matrix4().multiplyMatrices(sourceRootInverse, sourceMesh.matrixWorld)
  const parentWorld = sourceRoot.parent?.matrixWorld?.clone?.() || new THREE.Matrix4().identity()
  const parentWorldInverse = new THREE.Matrix4().copy(parentWorld).invert()
  const worldNormalToParent = new THREE.Matrix3().setFromMatrix4(parentWorldInverse)

  const query = makeClosestSurfaceQuery(targetMesh)
  const targetBox = new THREE.Box3().setFromObject(targetRoot)
  const targetSize = targetBox.getSize(new THREE.Vector3())
  const diagonal = Number.isFinite(targetDiagonalOverride) ? Math.max(1, targetDiagonalOverride) : Math.max(1, targetSize.length())

  // Skutečná aktuální matice objektu — chrání před závodem React state.
  const current = new THREE.Matrix4()
  if (sourceRoot.matrix && sourceRoot.matrix.elements?.length === 16) current.copy(sourceRoot.matrix)
  else current.fromArray(matrixArrayOrIdentity(initialMatrix))
  const initialCurrent = current.clone()

  // Best Fit po landmark seedu je pouze refinement. Hlídáme drift od seedu.
  const centroidIndices = sampledVertexIndices(sourcePosition.count, 1200)
  const sourceCentroidRoot = new THREE.Vector3()
  const centroidPoint = new THREE.Vector3()
  for (let i = 0; i < centroidIndices.length; i++) {
    centroidPoint.fromBufferAttribute(sourcePosition, centroidIndices[i]).applyMatrix4(meshToRoot)
    sourceCentroidRoot.add(centroidPoint)
  }
  sourceCentroidRoot.multiplyScalar(1 / Math.max(1, centroidIndices.length))
  const initialCentroidParent = sourceCentroidRoot.clone().applyMatrix4(initialCurrent)
  const initialPosition = new THREE.Vector3(), initialQuaternion = new THREE.Quaternion(), initialScale = new THREE.Vector3()
  initialCurrent.decompose(initialPosition, initialQuaternion, initialScale)
  const maxSeedDrift = Math.max(2.5, diagonal * 0.035)
  const maxSeedRotation = THREE.MathUtils.degToRad(7)

  const pParent = new THREE.Vector3()
  const pWorld = new THREE.Vector3()
  const qParent = new THREE.Vector3()
  const nParent = new THREE.Vector3()
  const delta = new THREE.Vector3()
  const cross = new THREE.Vector3()

  // Source sample se z BufferGeometry + meshToRoot převádí pouze JEDNOU pro každý scale,
  // ne při každé ICP iteraci. Tím odpadne velké množství opakované práce a alokací.
  const buildSourceSamples = (desiredCount) => {
    const indices = sampledVertexIndices(sourcePosition.count, desiredCount)
    const samples = []
    const point = new THREE.Vector3()
    for (let i = 0; i < indices.length; i++) {
      point.fromBufferAttribute(sourcePosition, indices[i]).applyMatrix4(meshToRoot)
      samples.push(point.clone())
    }
    return samples
  }

  const metricsFromCorrespondences = (correspondences) => {
    if (!correspondences || correspondences.length < 30) {
      return { rms: Infinity, mean: Infinity, count: correspondences?.length || 0 }
    }
    let sum = 0, sumSq = 0
    for (let i = 0; i < correspondences.length; i++) {
      const d = correspondences[i].distance
      sum += d
      sumSq += d * d
    }
    return {
      rms: Math.sqrt(sumSq / correspondences.length),
      mean: sum / correspondences.length,
      count: correspondences.length,
    }
  }

  // Nejdražší část Best Fitu. Místo pevného počtu BVH dotazů používáme
  // časové řezy. Na hustém scanu může být 420 dotazů několik sekund práce,
  // zatímco na lehkém modelu jen pár ms. Po ~8 ms CPU proto vždy uvolníme
  // hlavní vlákno a zároveň pošleme skutečný průběh do UI.
  const makeCorrespondences = async (matrix, sourceSamples, maxDistance, trim, progressTick = null) => {
    const result = []
    let sliceStarted = performance.now()
    let lastProgress = -1
    for (let k = 0; k < sourceSamples.length; k++) {
      const pRoot = sourceSamples[k]
      pParent.copy(pRoot).applyMatrix4(matrix)
      pWorld.copy(pParent).applyMatrix4(parentWorld)
      const hit = query(pWorld)
      if (Number.isFinite(hit.distance) && hit.distance <= maxDistance) {
        qParent.copy(hit.pointWorld).applyMatrix4(parentWorldInverse)
        nParent.copy(hit.normalWorld).applyMatrix3(worldNormalToParent).normalize()
        result.push({
          p: pParent.clone(),
          q: qParent.clone(),
          n: nParent.clone(),
          distance: pParent.distanceTo(qParent),
        })
      }

      const now = performance.now()
      if (now - sliceStarted >= ALIGNMENT_CPU_SLICE_MS) {
        const fraction = Math.min(1, (k + 1) / Math.max(1, sourceSamples.length))
        // Nezahlcujeme React tisíci prakticky totožnými aktualizacemi.
        if (fraction - lastProgress >= 0.004 || lastProgress < 0) {
          progressTick?.(fraction)
          lastProgress = fraction
        }
        await alignmentYield()
        sliceStarted = performance.now()
      }
    }
    progressTick?.(1)

    result.sort((a, b) => a.distance - b.distance)
    const keepCount = Math.min(result.length, Math.max(30, Math.floor(result.length * trim)))
    if (result.length > keepCount) result.length = keepCount
    return result
  }

  const evaluateMatrix = async (matrix, sourceSamples, maxDistance, trim, progressTick = null) => {
    return metricsFromCorrespondences(await makeCorrespondences(matrix, sourceSamples, maxDistance, trim, progressTick))
  }

  const scaleRigidIncrement = (matrix, factor, maxTranslation, maxRotation) => {
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)
    quaternion.normalize()
    if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w)

    let angle = 2 * Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1))
    if (!Number.isFinite(angle)) angle = 0
    const rotationFactor = angle > maxRotation && angle > 1e-12 ? maxRotation / angle : 1
    const applied = Math.min(1, factor, rotationFactor)

    const q = new THREE.Quaternion().slerp(quaternion, applied)
    const t = position.multiplyScalar(applied)
    return new THREE.Matrix4().compose(t, q, new THREE.Vector3(1, 1, 1))
  }

  const pointToPlaneIncrement = (correspondences) => {
    const pivot = new THREE.Vector3()
    for (let i = 0; i < correspondences.length; i++) pivot.add(correspondences[i].p)
    pivot.multiplyScalar(1 / Math.max(1, correspondences.length))

    const residualAbs = correspondences
      .map((c) => Math.abs(c.n.dot(delta.subVectors(c.p, c.q))))
      .sort((a, b) => a - b)
    const medianResidual = residualAbs[Math.floor(residualAbs.length / 2)] || 0.01
    const robustScale = Math.max(0.02, medianResidual * 1.4826 * 4.685)

    const normalMatrix = new Float64Array(36)
    const rhs = new Float64Array(6)
    const centered = new THREE.Vector3()
    let used = 0

    for (let i = 0; i < correspondences.length; i++) {
      const c = correspondences[i]
      delta.subVectors(c.p, c.q)
      const residual = c.n.dot(delta)
      const u = Math.abs(residual) / robustScale
      if (u >= 1) continue
      const robustWeight = Math.pow(1 - u * u, 2)
      centered.subVectors(c.p, pivot)
      cross.crossVectors(centered, c.n)
      const J = [cross.x, cross.y, cross.z, c.n.x, c.n.y, c.n.z]
      for (let r = 0; r < 6; r++) {
        rhs[r] += -robustWeight * J[r] * residual
        for (let col = 0; col < 6; col++) normalMatrix[r * 6 + col] += robustWeight * J[r] * J[col]
      }
      used++
    }

    if (used < 20) return null
    for (let d = 0; d < 6; d++) normalMatrix[d * 6 + d] += 1e-7
    const solution = solveLinearSystem6(normalMatrix, rhs)
    if (!solution) return null

    const rotationVector = new THREE.Vector3(solution[0], solution[1], solution[2])
    const rotationAngle = rotationVector.length()
    const quaternion = rotationAngle > 1e-12
      ? new THREE.Quaternion().setFromAxisAngle(rotationVector.clone().normalize(), rotationAngle)
      : new THREE.Quaternion()
    const localTranslation = new THREE.Vector3(solution[3], solution[4], solution[5])

    const rotatedPivot = pivot.clone().applyQuaternion(quaternion)
    const matrixTranslation = pivot.clone().add(localTranslation).sub(rotatedPivot)
    return new THREE.Matrix4().compose(matrixTranslation, quaternion, new THREE.Vector3(1, 1, 1))
  }

  // Rychlé ohodnocení line-search faktoru nad JIŽ nalezenými correspondence.
  // Nevolá BVH. Slouží jen k výběru nejperspektivnějších 1–2 faktorů, které pak
  // jako jediné ověříme plným nearest-surface dotazem.
  const fixedCorrespondenceRms = (increment, correspondences) => {
    if (!correspondences.length) return Infinity
    const point = new THREE.Vector3()
    let sumSq = 0
    for (let i = 0; i < correspondences.length; i++) {
      point.copy(correspondences[i].p).applyMatrix4(increment)
      const d = point.distanceTo(correspondences[i].q)
      sumSq += d * d
    }
    return Math.sqrt(sumSq / correspondences.length)
  }

  // Po kvalitním 3bodovém seedu není potřeba brutálně hustý ICP. Menší počty
  // vzorků + více scale úrovní dávají velmi podobnou přesnost a podstatně nižší čas.
  const stages = [
    { mode: "point", samples: 1600, iterations: 5, maxDistance: Math.max(3.0, diagonal * 0.055), trim: 0.70, maxTranslation: 1.2, maxRotation: THREE.MathUtils.degToRad(5) },
    { mode: "point", samples: 3200, iterations: 6, maxDistance: Math.max(1.5, diagonal * 0.030), trim: 0.80, maxTranslation: 0.65, maxRotation: THREE.MathUtils.degToRad(2.5) },
    { mode: "plane", samples: 6000, iterations: 4, maxDistance: Math.max(0.65, diagonal * 0.014), trim: 0.86, maxTranslation: 0.22, maxRotation: THREE.MathUtils.degToRad(0.8) },
  ]

  const stageSamples = stages.map((stage) => buildSourceSamples(stage.samples))
  const validationSamples = buildSourceSamples(5000)
  const validationMaxDistance = Math.max(4.0, diagonal * 0.065)
  const validationTrim = 0.82

  onProgress?.({ stage: 0, stages: stages.length, iteration: 0, iterations: 1, rms: null, correspondences: 0, mode: "prepare" })
  await alignmentYield()

  const initialValidation = await evaluateMatrix(
    current, validationSamples, validationMaxDistance, validationTrim,
    (fraction) => onProgress?.({ stage: 0, stages: stages.length, iteration: 0, iterations: 1, rms: null, correspondences: 0, mode: "prepare", percent: 3 + fraction * 7 })
  )
  let bestMatrix = current.clone()
  let bestValidationRms = initialValidation.rms
  let finalRms = initialValidation.rms
  let finalCount = initialValidation.count

  const stageRanges = [[10, 34], [34, 62], [62, 88]]

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
    const stage = stages[stageIndex]
    const samples = stageSamples[stageIndex]
    if (samples.length < 30) continue
    const [stageStartPercent, stageEndPercent] = stageRanges[stageIndex]
    const iterationPercentSpan = (stageEndPercent - stageStartPercent) / Math.max(1, stage.iterations)

    for (let iteration = 0; iteration < stage.iterations; iteration++) {
      const iterationStartPercent = stageStartPercent + iteration * iterationPercentSpan
      const emitStageProgress = (localFraction, extra = {}) => onProgress?.({
        stage: stageIndex + 1,
        stages: stages.length,
        iteration: iteration + Math.min(0.99, Math.max(0, localFraction)),
        iterations: stage.iterations,
        rms: finalRms,
        correspondences: finalCount,
        mode: stage.mode,
        percent: iterationStartPercent + iterationPercentSpan * Math.min(0.98, Math.max(0, localFraction)),
        ...extra,
      })
      // Correspondence hledáme pro current pouze jednou. Jeho RMS spočítáme rovnou
      // ze stejného výsledku — v2.2 zde dělala druhý kompletní BVH průchod.
      const correspondences = await makeCorrespondences(
        current, samples, stage.maxDistance, stage.trim,
        (fraction) => emitStageProgress(fraction * 0.55, { phase: "correspondences" })
      )
      if (correspondences.length < 30) {
        if (stageIndex === 0 && iteration === 0) throw new Error("Příliš málo překrývající se geometrie pro Best Fit.")
        break
      }
      const currentEval = metricsFromCorrespondences(correspondences)

      let rawIncrement = null
      if (stage.mode === "point") {
        const source = correspondences.map((c) => c.p)
        const target = correspondences.map((c) => c.q)
        rawIncrement = rigidTransformHorn(source, target)
      } else {
        rawIncrement = pointToPlaneIncrement(correspondences)
      }
      if (!rawIncrement) break

      // Nejprve velmi levně seřadíme line-search faktory podle fixed correspondences.
      // Teprve nejlepší kandidáty podrobíme drahému nearest-surface přepočtu.
      const factorCandidates = [1, 0.5, 0.25, 0.125]
        .map((factor) => {
          const increment = scaleRigidIncrement(rawIncrement, factor, stage.maxTranslation, stage.maxRotation)
          return { factor, increment, approxRms: fixedCorrespondenceRms(increment, correspondences) }
        })
        .filter((candidate) => candidate.approxRms + 1e-7 < currentEval.rms)
        .sort((a, b) => a.approxRms - b.approxRms)
        .slice(0, 2)

      if (!factorCandidates.length) break

      let accepted = null
      for (let f = 0; f < factorCandidates.length; f++) {
        const { increment } = factorCandidates[f]
        const candidate = current.clone().premultiply(increment)

        if (landmarkSeeded) {
          const candidateCentroid = sourceCentroidRoot.clone().applyMatrix4(candidate)
          const candidatePosition = new THREE.Vector3(), candidateQuaternion = new THREE.Quaternion(), candidateScale = new THREE.Vector3()
          candidate.decompose(candidatePosition, candidateQuaternion, candidateScale)
          const centroidDrift = candidateCentroid.distanceTo(initialCentroidParent)
          const rotationDrift = initialQuaternion.angleTo(candidateQuaternion)
          if (centroidDrift > maxSeedDrift || rotationDrift > maxSeedRotation) continue
        }

        const candidateCorrespondences = await makeCorrespondences(
          candidate, samples, stage.maxDistance, stage.trim,
          (fraction) => emitStageProgress(0.58 + ((f + fraction) / Math.max(1, factorCandidates.length)) * 0.32, { phase: "verify" })
        )
        const candidateEval = metricsFromCorrespondences(candidateCorrespondences)
        const enoughPairs = candidateEval.count >= Math.max(30, Math.floor(currentEval.count * 0.65))
        if (enoughPairs && candidateEval.rms + 1e-6 < currentEval.rms) {
          accepted = { matrix: candidate, eval: candidateEval, increment }
          break
        }
      }

      if (!accepted) break
      current.copy(accepted.matrix)
      finalRms = accepted.eval.rms
      finalCount = accepted.eval.count

      const incPosition = new THREE.Vector3()
      const incQuaternion = new THREE.Quaternion()
      const incScale = new THREE.Vector3()
      accepted.increment.decompose(incPosition, incQuaternion, incScale)
      const incAngle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(incQuaternion.w), -1, 1))

      onProgress?.({
        stage: stageIndex + 1,
        stages: stages.length,
        iteration: iteration + 1,
        iterations: stage.iterations,
        rms: finalRms,
        correspondences: finalCount,
        mode: stage.mode,
        percent: Math.min(stageEndPercent - 0.5, iterationStartPercent + iterationPercentSpan * 0.96),
      })
      await alignmentYield()

      if (incPosition.length() < 0.0005 && incAngle < 0.00004) break
    }

    // Drahá 5k validační sada se v2.2 počítala po KAŽDÉ iteraci.
    // Pro safety rollback ji stačí provést jednou na konci každého scale passu.
    const validation = await evaluateMatrix(
      current, validationSamples, validationMaxDistance, validationTrim,
      (fraction) => onProgress?.({
        stage: stageIndex + 1, stages: stages.length, iteration: stage.iterations, iterations: stage.iterations,
        rms: finalRms, correspondences: finalCount, mode: stage.mode, phase: "validation",
        percent: (stageEndPercent - 1.6) + fraction * 1.6,
      })
    )
    if (validation.count >= 30 && validation.rms < bestValidationRms) {
      bestValidationRms = validation.rms
      bestMatrix.copy(current)
    }
    await alignmentYield()
  }

  // Finální safety check. Best Fit nikdy nesmí být horší než landmark seed.
  const finalValidation = await evaluateMatrix(
    bestMatrix, validationSamples, validationMaxDistance, validationTrim,
    (fraction) => onProgress?.({ stage: 4, stages: 4, iteration: 1, iterations: 1, rms: finalRms, correspondences: finalCount, mode: "validation", percent: 88 + fraction * 6 })
  )
  if (finalValidation.count >= 30 && finalValidation.rms < bestValidationRms) bestValidationRms = finalValidation.rms

  const improved = Number.isFinite(bestValidationRms) && (
    !Number.isFinite(initialValidation.rms) || bestValidationRms + 1e-5 < initialValidation.rms
  )
  return {
    matrix: (improved ? bestMatrix : initialCurrent).toArray(),
    rms: improved ? bestValidationRms : initialValidation.rms,
    correspondences: finalCount,
    improved,
  }
}

function makePositionGeometry(positions, index = null, ensureIndex = false) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  if (index && index.length) {
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
  } else if (ensureIndex) {
    const count = Math.floor(positions.length / 3)
    const generated = new Uint32Array(count)
    for (let i = 0; i < count; i++) generated[i] = i
    geometry.setIndex(new THREE.BufferAttribute(generated, 1))
  }
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function setObjectMatrix(object, array) {
  object.matrixAutoUpdate = false
  object.matrix.fromArray(matrixArrayOrIdentity(array))
  object.matrixWorldNeedsUpdate = true
}

function reconstructPair(payload) {
  const sourceGeometry = makePositionGeometry(payload.source.positions)
  const targetGeometry = makePositionGeometry(payload.target.positions, payload.target.index, true)

  const sourceParent = new THREE.Group()
  setObjectMatrix(sourceParent, payload.source.parentWorld)

  const sourceRoot = new THREE.Group()
  setObjectMatrix(sourceRoot, payload.source.rootLocal)
  sourceParent.add(sourceRoot)

  const sourceMesh = new THREE.Mesh(sourceGeometry)
  setObjectMatrix(sourceMesh, payload.source.meshLocal)
  sourceRoot.add(sourceMesh)

  const targetParent = new THREE.Group()
  setObjectMatrix(targetParent, payload.target.parentWorld)

  const targetRoot = new THREE.Group()
  setObjectMatrix(targetRoot, payload.target.rootLocal)
  targetParent.add(targetRoot)

  const targetMesh = new THREE.Mesh(targetGeometry)
  setObjectMatrix(targetMesh, payload.target.meshLocal)
  targetRoot.add(targetMesh)

  sourceParent.updateMatrixWorld(true)
  targetParent.updateMatrixWorld(true)

  return {
    sourceGeometry,
    targetGeometry,
    sourceRoot,
    sourceMesh,
    targetRoot,
    targetMesh,
  }
}

function cleanupPair(pair) {
  try { pair?.targetGeometry?.disposeBoundsTree?.() } catch {}
  try { pair?.sourceGeometry?.dispose?.() } catch {}
  try { pair?.targetGeometry?.dispose?.() } catch {}
}

self.postMessage({ type: "READY" })

self.onmessage = async (event) => {
  const message = event.data || {}
  if (message.type !== "BEST_FIT") return

  const { requestId, payload } = message
  let pair = null
  const startedAt = performance.now()

  try {
    pair = reconstructPair(payload)
    const reconstructedAt = performance.now()

    // BVH stavíme explicitně před ICP, abychom mohli změřit jeho cenu.
    if (!pair.targetGeometry.boundsTree) pair.targetGeometry.computeBoundsTree()
    const bvhReadyAt = performance.now()

    let lastProgressAt = -Infinity
    let lastPercent = -Infinity
    const result = await robustPointToPlaneICP({
      sourceMesh: pair.sourceMesh,
      sourceRoot: pair.sourceRoot,
      targetMesh: pair.targetMesh,
      targetRoot: pair.targetRoot,
      initialMatrix: payload.initialMatrix,
      targetDiagonalOverride: payload.targetDiagonal,
      landmarkSeeded: !!payload.landmarkSeeded,
      onProgress: (progress) => {
        const now = performance.now()
        const percent = Number.isFinite(progress?.percent) ? progress.percent : null
        const important =
          progress?.mode === "prepare" ||
          progress?.mode === "validation" ||
          (percent != null && (percent >= 99 || percent - lastPercent >= 0.5))

        if (important || now - lastProgressAt >= 16) {
          lastProgressAt = now
          if (percent != null) lastPercent = percent
          self.postMessage({ type: "PROGRESS", requestId, progress })
        }
      },
    })

    const finishedAt = performance.now()
    self.postMessage({
      type: "RESULT",
      requestId,
      result,
      timings: {
        reconstructMs: reconstructedAt - startedAt,
        bvhMs: bvhReadyAt - reconstructedAt,
        icpMs: finishedAt - bvhReadyAt,
        totalMs: finishedAt - startedAt,
      },
    })
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId,
      kind: "algorithm",
      message: error?.message || "Best Fit Worker selhal.",
      stack: error?.stack || "",
    })
  } finally {
    cleanupPair(pair)
  }
}
