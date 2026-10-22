"use client"

import { useEffect } from "react"
import { bakePlyTexture } from "./bake.mjs"
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
                const baking = message.task === "bake"
                const rendered = baking ? null : await renderAttachmentThumbnail(message.buffer, message.fileName, message.turntable === true, message.thumbnailVersion)
                const blob = rendered?.thumbnail || rendered
                const previewBuffer = rendered?.preview ? await rendered.preview.arrayBuffer() : undefined
                const buffer = baking ? await bakePlyTexture(message.buffer, message.imageBuffer, message.imageMime) : await blob.arrayBuffer()
                if (buffer.byteLength > (baking ? 160 : 2) * 1024 * 1024) throw new Error("Result too large")
                if (!cancelled) window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_RESULT", id: message.id, buffer, previewBuffer, thumbnailVersion: [3, 4].includes(message.thumbnailVersion) ? message.thumbnailVersion : 2, frames: !baking && message.turntable === true ? 24 : 1, mime: baking ? "application/octet-stream" : "image/jpeg" }, parentOrigin, previewBuffer ? [buffer, previewBuffer] : [buffer])
            } catch (error) {
                console.error("Thumbnail processing failed", error)
                if (!cancelled) window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_ERROR", id: message.id }, parentOrigin)
            } finally { busy = false }
        }
        window.addEventListener("message", onMessage)
        window.parent.postMessage({ type: "CASE_CLOUD_THUMBNAIL_READY" }, parentOrigin)
        return () => { cancelled = true; window.removeEventListener("message", onMessage) }
    }, [])
    return null
}
