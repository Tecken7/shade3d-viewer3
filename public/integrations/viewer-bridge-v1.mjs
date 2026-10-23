// Shared by LabCaseForm and LabCaseDetail. No React or application dependencies.
export function createViewerBridge({ frame, host = window, onError = console.warn, delay = 50, retryMs = 900 }) {
  const origin = new URL(frame.src, host.location.href).origin
  const session = host.crypto?.randomUUID?.() || `viewer-${Date.now()}-${Math.random()}`
  let disposed = false, ready = false, legacy = false, seq = 0, attempts = 0
  let latest = null, pending = null, acknowledged = null, flushTimer = null, retryTimer = null, helloTimer = null
  const send = message => frame.contentWindow?.postMessage(message, origin)
  const clearRetry = () => { host.clearTimeout(retryTimer); retryTimer = null }
  function transmit() {
    if (disposed || !pending) return
    if (attempts++ >= 5) { clearRetry(); onError(new Error("Prohlížeč nepotvrdil přijetí změn. Zkuste náhled znovu otevřít.")); return }
    send({ type: "SHADE3D_LIVE", protocolVersion: 1, session, sequence: pending.sequence, payload: pending.payload })
    clearRetry()
    retryTimer = host.setTimeout(transmit, retryMs * Math.min(attempts, 3))
  }
  function flush() {
    flushTimer = null
    if (disposed || !latest || (!ready && !legacy)) return
    if (legacy) { send({ type: "SHADE3D_LIVE", payload: latest }); latest = null; return }
    const desired = latest
    latest = null
    // A later material edit must not discard an unacknowledged initial restore.
    const restore = pending?.full.viewer_state
    const full = restore && !desired.viewer_state ? { ...desired, viewer_state: restore } : desired
    if (pending && pending.full.keepCamera === false) full.keepCamera = false
    if (acknowledged && JSON.stringify(full) === JSON.stringify(acknowledged)) return
    let payload = full
    if (!pending && acknowledged?.files && full.files && full.files.length === acknowledged.files.length && full.files.every((file,i) => file.u === acknowledged.files[i].u)) {
      const updates = full.files.filter((file,i) => JSON.stringify(file) !== JSON.stringify(acknowledged.files[i]))
      payload = { ...full, files: undefined, fileUpdates: updates }
    }
    pending = { sequence: ++seq, payload, full }
    attempts = 0
    transmit()
  }
  function hello(attempt = 0) {
    if (disposed || ready) return
    send({ type: "ARTHETIC_VIEWER_HELLO", protocolVersion: 1, session })
    helloTimer = host.setTimeout(() => {
      if (attempt < 2) hello(attempt + 1)
      else { legacy = true; flush() }
    }, retryMs)
  }
  function onMessage(event) {
    if (disposed || event.source !== frame.contentWindow || event.origin !== origin) return
    const message = event.data
    if (message?.type === "ARTHETIC_VIEWER_READY" && message.protocolVersion === 1 && message.session === session) {
      ready = true; legacy = false; host.clearTimeout(helloTimer); flush()
    }
    if (message?.type === "ARTHETIC_VIEWER_ACK" && message.session === session && message.sequence === pending?.sequence) {
      clearRetry(); acknowledged = pending.full; pending = null
    }
    if (message?.type === "ARTHETIC_VIEWER_REJECTED" && message.session === session && message.sequence === pending?.sequence) {
      clearRetry(); onError(new Error("Prohlížeč odmítl neplatnou aktualizaci scény."))
    }
  }
  host.addEventListener("message", onMessage)
  hello()
  return {
    update(payload) {
      if (disposed) return
      const restore = latest?.viewer_state || pending?.full.viewer_state
      const keepInitialCamera = latest?.keepCamera === false || pending?.full.keepCamera === false
      latest = { ...payload }
      if (restore && !latest.viewer_state) latest.viewer_state = restore
      if (keepInitialCamera) latest.keepCamera = false
      host.clearTimeout(flushTimer); flushTimer = host.setTimeout(flush, delay)
    },
    dispose() { disposed = true; host.clearTimeout(flushTimer); host.clearTimeout(helloTimer); clearRetry(); host.removeEventListener("message", onMessage); latest = pending = null },
  }
}

export function isViewerEvent(event, frame) {
  if (!frame?.contentWindow || event.source !== frame.contentWindow) return false
  try { return event.origin === new URL(frame.src).origin } catch { return false }
}

// Listener lifecycle is independent of React rerenders. ACK means state accepted,
// not that geometry, analysis or an asynchronous save has finished.
export function createViewerReceiver({ host = window, apply, getFiles }) {
  const sessions = new Map()
  const send = (event, message) => event.source?.postMessage(message, event.origin)
  function onMessage(event) {
    if (event.source !== host.parent || event.origin === "null") return
    const message = event.data
    if (message?.type === "ARTHETIC_VIEWER_HELLO" && message.protocolVersion === 1 && typeof message.session === "string") {
      if (sessions.size > 8) sessions.delete(sessions.keys().next().value)
      if (!sessions.has(message.session)) sessions.set(message.session, { sequence: 0, origin: event.origin })
      send(event, { type: "ARTHETIC_VIEWER_READY", protocolVersion: 1, session: message.session })
      return
    }
    if (message?.type !== "SHADE3D_LIVE" || message.protocolVersion !== 1) return
    const state = sessions.get(message.session)
    if (!state || state.origin !== event.origin || !Number.isSafeInteger(message.sequence) || message.sequence < 1) return
    const reply = type => send(event, { type, protocolVersion: 1, session: message.session, sequence: message.sequence })
    if (message.sequence <= state.sequence) { reply("ARTHETIC_VIEWER_ACK"); return }
    try {
      let payload = message.payload
      if (!payload || typeof payload !== "object") throw new Error("Invalid payload")
      if (Array.isArray(payload.fileUpdates)) {
        const updates = new Map(payload.fileUpdates.map(file => [file.u, file]))
        payload = { ...payload, files: getFiles().map(file => ({ ...file, ...updates.get(file.u) })) }
      }
      apply(payload)
      state.sequence = message.sequence
      reply("ARTHETIC_VIEWER_ACK")
    } catch { reply("ARTHETIC_VIEWER_REJECTED") }
  }
  host.addEventListener("message", onMessage)
  return () => host.removeEventListener("message", onMessage)
}
