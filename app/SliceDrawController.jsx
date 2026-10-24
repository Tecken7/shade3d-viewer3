"use client"
import { useEffect, useRef } from "react"
import { useThree } from "@react-three/fiber"
import { bindSliceDrawing } from "./viewer/slice-input.mjs"

export default function SliceDrawController({ enabled, getAnchor, onComplete, onDrawingChange }) {
  const { camera, gl } = useThree()
  const callbacks = useRef({ getAnchor, onComplete, onDrawingChange })
  callbacks.current = { getAnchor, onComplete, onDrawingChange }
  useEffect(() => {
    if (!enabled) return
    return bindSliceDrawing({
      canvas: gl.domElement, camera,
      getAnchor: () => callbacks.current.getAnchor(),
      onComplete: result => callbacks.current.onComplete(result),
      onDrawingChange: active => callbacks.current.onDrawingChange(active),
    })
  }, [enabled, camera, gl])
  return null
}
