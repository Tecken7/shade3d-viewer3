"use client"
import { useEffect } from "react"
import { useThree } from "@react-three/fiber"
import { planeFromScreenStroke } from "./viewer/slice-drawing.mjs"

// Capture only the drawing gesture, before the orbit/trackball handlers see it.
export default function SliceDrawController({ enabled, getAnchor, onComplete, onDrawingChange }) {
  const { camera, gl } = useThree()
  useEffect(() => {
    if (!enabled) return
    const canvas = gl.domElement
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("aria-hidden", "true")
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:visible"
    const line = document.createElementNS(svg.namespaceURI, "line")
    for (const [key, value] of Object.entries({ stroke: "#c5dccb", "stroke-width": "3", "stroke-dasharray": "8 6", "stroke-linecap": "round", visibility: "hidden" })) line.setAttribute(key, value)
    svg.appendChild(line); canvas.parentElement.appendChild(svg)
    const previousCursor = canvas.style.cursor
    const previousTabIndex = canvas.getAttribute("tabindex"), previousLabel = canvas.getAttribute("aria-label")
    canvas.tabIndex = 0
    canvas.setAttribute("aria-label", "3D scéna. Průřez klávesnicí: Enter označí začátek, šipky určí směr, Enter dokončí, Escape zruší.")
    canvas.style.cursor = "crosshair"
    let gesture = null
    const point = event => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top } }
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation() }
    const finish = () => {
      if (gesture && Number.isInteger(gesture.id) && canvas.hasPointerCapture?.(gesture.id)) canvas.releasePointerCapture(gesture.id)
      gesture = null; line.setAttribute("visibility", "hidden"); onDrawingChange(false)
    }
    const down = event => {
      if (event.button !== 0 || gesture || event.altKey || event.ctrlKey || event.metaKey) return
      const anchor = getAnchor()
      if (!anchor) return
      stop(event)
      const start = point(event)
      gesture = { start, anchor, id: event.pointerId }
      canvas.setPointerCapture(event.pointerId)
      line.setAttribute("x1", start.x); line.setAttribute("y1", start.y)
      line.setAttribute("x2", start.x); line.setAttribute("y2", start.y); line.setAttribute("visibility", "visible")
      onDrawingChange(true)
    }
    const move = event => {
      if (!gesture || gesture.id !== event.pointerId) return
      stop(event); const end = point(event)
      line.setAttribute("x2", end.x); line.setAttribute("y2", end.y)
    }
    const up = event => {
      if (!gesture || gesture.id !== event.pointerId) return
      stop(event)
      const rect = canvas.getBoundingClientRect()
      const result = planeFromScreenStroke({ start: gesture.start, end: point(event), viewport: rect, camera, anchor: gesture.anchor })
      finish()
      if (result) onComplete(result)
    }
    const keyboard = event => {
      if (gesture && gesture.id !== "keyboard") return
      const rect = canvas.getBoundingClientRect()
      if (event.key === "Enter") {
        stop(event)
        if (!gesture) {
          const anchor = getAnchor()
          if (!anchor) return
          const start = { x: rect.width / 2, y: rect.height / 2 }
          gesture = { id: "keyboard", start, end: { ...start }, anchor }
          line.setAttribute("x1", start.x); line.setAttribute("y1", start.y)
          line.setAttribute("x2", start.x); line.setAttribute("y2", start.y); line.setAttribute("visibility", "visible")
          onDrawingChange(true)
        } else {
          const result = planeFromScreenStroke({ start: gesture.start, end: gesture.end, viewport: rect, camera, anchor: gesture.anchor })
          finish(); if (result) onComplete(result)
        }
      } else if (gesture?.id === "keyboard" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        stop(event)
        const distance = event.shiftKey ? 30 : 10
        gesture.end.x = Math.max(0, Math.min(rect.width, gesture.end.x + (event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0)))
        gesture.end.y = Math.max(0, Math.min(rect.height, gesture.end.y + (event.key === "ArrowDown" ? distance : event.key === "ArrowUp" ? -distance : 0)))
        line.setAttribute("x2", gesture.end.x); line.setAttribute("y2", gesture.end.y)
      }
    }
    const cancel = event => { if (gesture) { if (event.type === "keydown" && event.key !== "Escape") return; finish() } }
    canvas.addEventListener("pointerdown", down, true)
    canvas.addEventListener("pointermove", move, true)
    canvas.addEventListener("pointerup", up, true)
    canvas.addEventListener("pointercancel", cancel, true)
    canvas.addEventListener("keydown", keyboard, true)
    window.addEventListener("keydown", cancel)
    return () => {
      finish(); svg.remove(); canvas.style.cursor = previousCursor
      if (previousTabIndex == null) canvas.removeAttribute("tabindex"); else canvas.setAttribute("tabindex", previousTabIndex)
      if (previousLabel == null) canvas.removeAttribute("aria-label"); else canvas.setAttribute("aria-label", previousLabel)
      canvas.removeEventListener("keydown", keyboard, true)
      canvas.removeEventListener("pointerdown", down, true); canvas.removeEventListener("pointermove", move, true)
      canvas.removeEventListener("pointerup", up, true); canvas.removeEventListener("pointercancel", cancel, true)
      window.removeEventListener("keydown", cancel)
    }
  }, [enabled, camera, gl, getAnchor, onComplete, onDrawingChange])
  return null
}
