/* ARTHETIC CGAL Mesh Repair Worker
 * Classic Worker + Emscripten MODULARIZE wrapper.
 * Runtime assets:
 *   /wasm/mesh-repair.js
 *   /wasm/mesh-repair.wasm
 */

let modulePromise = null

function nowMs() {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now()
}

function initCGALModule() {
  if (modulePromise) return modulePromise

  modulePromise = (async () => {
    importScripts("/wasm/mesh-repair.js")

    if (typeof ArtheticMeshRepairModule !== "function") {
      throw new Error("ArtheticMeshRepairModule nebyl nalezen v /wasm/mesh-repair.js.")
    }

    const Module = await ArtheticMeshRepairModule({
      locateFile(file) {
        if (String(file).endsWith(".wasm")) return "/wasm/mesh-repair.wasm"
        return `/wasm/${file}`
      },
      noInitialRun: true,
    })

    return Module
  })()

  return modulePromise
}

function postProgress(requestId, percent, phase, detail = "") {
  self.postMessage({
    type: "PROGRESS",
    requestId,
    progress: {
      percent,
      phase,
      detail,
    },
  })
}

function copyBufferAsTypedArray(buffer, Type, expectedLength, label) {
  if (!(buffer instanceof ArrayBuffer)) throw new Error(`${label}: chybí ArrayBuffer.`)
  const view = new Type(buffer)
  if (Number.isInteger(expectedLength) && expectedLength >= 0 && view.length !== expectedLength) {
    throw new Error(`${label}: neočekávaná délka ${view.length}, očekávám ${expectedLength}.`)
  }
  return view
}

async function repairHole(requestId, payload) {
  const startedAt = nowMs()
  const Module = await initCGALModule()

  const vertexCount = Number(payload?.vertexCount) || 0
  const faceCount = Number(payload?.faceCount) || 0
  const boundaryCount = Number(payload?.boundaryCount) || 0
  const density = Number.isFinite(Number(payload?.density)) ? Number(payload.density) : 2.25
  const continuity = Number.isInteger(Number(payload?.continuity)) ? Number(payload.continuity) : 1

  if (vertexCount < 3 || faceCount < 1 || boundaryCount < 3) {
    throw new Error("CGAL: neplatná velikost vstupní geometrie.")
  }

  const positions = copyBufferAsTypedArray(
    payload.positions,
    Float64Array,
    vertexCount * 3,
    "positions"
  )
  const faces = copyBufferAsTypedArray(
    payload.faces,
    Uint32Array,
    faceCount * 3,
    "faces"
  )
  const boundary = copyBufferAsTypedArray(
    payload.boundary,
    Uint32Array,
    boundaryCount,
    "boundary"
  )

  postProgress(requestId, 5, "prepare", "Připravuji CGAL Surface_mesh")

  let positionsPtr = 0
  let facesPtr = 0
  let boundaryPtr = 0

  try {
    positionsPtr = Module._malloc(positions.byteLength)
    facesPtr = Module._malloc(faces.byteLength)
    boundaryPtr = Module._malloc(boundary.byteLength)

    if (!positionsPtr || !facesPtr || !boundaryPtr) {
      throw new Error("CGAL WASM: nepodařilo se alokovat paměť.")
    }

    Module.HEAPF64.set(positions, positionsPtr >> 3)
    Module.HEAPU32.set(faces, facesPtr >> 2)
    Module.HEAPU32.set(boundary, boundaryPtr >> 2)

    postProgress(requestId, 18, "triangulate", "Trianguluji otvor v 3D")

    const computeStartedAt = nowMs()
    const ok = Module._arthetic_repair_hole(
      positionsPtr,
      vertexCount,
      facesPtr,
      faceCount,
      boundaryPtr,
      boundaryCount,
      density,
      continuity
    )
    const computeFinishedAt = nowMs()

    const errorCode = Number(Module._arthetic_result_error_code()) || 0
    if (!ok) {
      const error = new Error(`CGAL repair selhal (errorCode=${errorCode}).`)
      error.repairErrorCode = errorCode
      throw error
    }

    postProgress(requestId, 88, "extract", "Přebírám výsledný patch z WASM")

    const outputVertexCount = Number(Module._arthetic_result_vertex_count()) || 0
    const outputTriangleCount = Number(Module._arthetic_result_triangle_count()) || 0
    const fairSuccess = !!Module._arthetic_result_fair_success()

    if (!outputVertexCount || !outputTriangleCount) {
      const error = new Error("CGAL vrátil prázdný patch.")
      error.repairErrorCode = errorCode || 5
      throw error
    }

    const outputPositionsPtr = Number(Module._arthetic_result_positions_ptr()) || 0
    const outputTrianglesPtr = Number(Module._arthetic_result_triangles_ptr()) || 0
    const outputOriginsPtr = Number(Module._arthetic_result_origin_indices_ptr()) || 0

    if (!outputPositionsPtr || !outputTrianglesPtr || !outputOriginsPtr) {
      throw new Error("CGAL vrátil neplatné pointery výsledku.")
    }

    // .slice() je zásadní: C++ používá statické vectors, další repair call jejich
    // paměť změní. Do main threadu proto vždy posíláme samostatnou kopii.
    const outputPositions = Module.HEAPF64
      .subarray(outputPositionsPtr >> 3, (outputPositionsPtr >> 3) + outputVertexCount * 3)
      .slice()

    const outputTriangles = Module.HEAPU32
      .subarray(outputTrianglesPtr >> 2, (outputTrianglesPtr >> 2) + outputTriangleCount * 3)
      .slice()

    const outputOrigins = Module.HEAP32
      .subarray(outputOriginsPtr >> 2, (outputOriginsPtr >> 2) + outputVertexCount)
      .slice()

    postProgress(requestId, 100, "done", "CGAL C1 + Dense225 hotovo")

    const finishedAt = nowMs()
    self.postMessage({
      type: "RESULT",
      requestId,
      result: {
        positions: outputPositions.buffer,
        triangles: outputTriangles.buffer,
        origins: outputOrigins.buffer,
        fairSuccess,
        errorCode,
      },
      timings: {
        totalMs: finishedAt - startedAt,
        computeMs: computeFinishedAt - computeStartedAt,
      },
    }, [
      outputPositions.buffer,
      outputTriangles.buffer,
      outputOrigins.buffer,
    ])
  } finally {
    if (positionsPtr) Module._free(positionsPtr)
    if (facesPtr) Module._free(facesPtr)
    if (boundaryPtr) Module._free(boundaryPtr)
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data || {}
  if (message.type !== "REPAIR_HOLE") return

  const requestId = message.requestId
  try {
    await repairHole(requestId, message.payload || {})
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      requestId,
      kind: error?.repairErrorCode ? "algorithm" : "infrastructure",
      errorCode: error?.repairErrorCode ?? null,
      message: error?.message || "CGAL Mesh Repair Worker selhal.",
      stack: error?.stack || null,
    })
  }
})

// Nahrajeme WASM dopředu, aby první kliknutí neplatilo init latency.
initCGALModule()
  .then(() => self.postMessage({ type: "READY" }))
  .catch((error) => {
    self.postMessage({
      type: "INIT_ERROR",
      message: error?.message || "CGAL WASM inicializace selhala.",
      stack: error?.stack || null,
    })
  })
