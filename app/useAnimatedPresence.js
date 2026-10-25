"use client"
import { useEffect, useState } from "react"
export default function useAnimatedPresence(open, duration = 220) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timer = setTimeout(() => setMounted(false), reduced ? 0 : duration)
    return () => clearTimeout(timer)
  }, [open, duration])
  return { present: open || mounted, exiting: !open && mounted }
}
