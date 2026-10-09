"use client"

import { useEffect } from "react"
import { renderAttachmentThumbnail } from "./renderer"

export default function ThumbnailPage() {
    useEffect(() => {
        let cancelled = false, busy = false
        let parentOrigin
        try { parentOrigin = new URL(document.referrer).origin } catch { return }
        if (window.parent === window || parentOrigin === "null") return
        const onMessage = async event => {
            if (event.source !== window.parent || event.origin !== parentOrigin) return
            const message = event.data
            if (message?.type !== "CASE_CLOUD_THUMBNAIL_REQUEST" || typeof message.id !== "string" || busy) return
            busy = true
            try {
                const blob = await renderAttachmentThumbnail(message.buffer, message.fileName)
                const buffer = await blob.arrayBuffer()
                if (!cancelled) window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_RESULT", id: message.id, buffer, mime: "image/jpeg" }, parentOrigin, [buffer])
            } catch {
                if (!cancelled) window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_ERROR", id: message.id }, parentOrigin)
            } finally { busy = false }
        }
        window.addEventListener("message", onMessage)
        window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_READY" }, parentOrigin)
        return () => { cancelled = true; window.removeEventListener("message", onMessage) }
    }, [])
    return null
}
