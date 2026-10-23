"use client"

import React, { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import ViewerToolIcon from "./ViewerToolIcon"
import styles from "./ViewerToolsPanel.module.css"

export default function ViewerToolsPanel({ tools, onExpandedChange }) {
  const [expanded, setExpanded] = useState(false)
  const [tooltip, setTooltip] = useState(null)
  const toggleRef = useRef(null)

  useEffect(() => { onExpandedChange?.(expanded) }, [expanded, onExpandedChange])

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape") return
      setTooltip(null)
      if (expanded) {
        setExpanded(false)
        toggleRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [expanded])

  function reveal(event, label) {
    if (expanded) return
    const bounds = event.currentTarget.getBoundingClientRect()
    setTooltip({ label, top: bounds.top + bounds.height / 2, right: window.innerWidth - bounds.left + 12 })
  }

  return (
    <aside className={`${styles.panel} ${expanded ? styles.expanded : ""}`} aria-label="Nástroje prohlížeče">
      <header className={styles.header}>
        <span className={styles.heading} aria-hidden={!expanded}>Nástroje</span>
        <button ref={toggleRef} type="button" className={styles.expandButton}
          aria-label={expanded ? "Sbalit panel nástrojů" : "Rozbalit panel nástrojů"}
          aria-expanded={expanded} aria-controls="viewer-tools-list"
          onClick={() => { setExpanded(value => !value); setTooltip(null) }}
          onMouseEnter={event => reveal(event, "Rozbalit panel")}
          onMouseLeave={() => setTooltip(null)}
          onFocus={event => reveal(event, "Rozbalit panel")}
          onBlur={() => setTooltip(null)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M15 4v16" />
            <path d={expanded ? "m8 9 3 3-3 3" : "m11 9-3 3 3 3"} />
          </svg>
        </button>
      </header>
      <div id="viewer-tools-list" className={styles.list} onScroll={() => setTooltip(null)}>
        {tools.map(tool => (
          <button key={tool.id} type="button"
            className={`${styles.tool} ${tool.active ? styles.active : ""}`}
            aria-label={tool.label} aria-disabled={!!tool.disabled}
            aria-pressed={tool.toggle ? !!tool.active : undefined}
            onClick={() => {
              if (tool.disabled) return
              setTooltip(null)
              // Collapse before opening tool settings so the model keeps its space.
              setExpanded(false)
              tool.onClick()
            }}
            onMouseEnter={event => reveal(event, tool.label)}
            onMouseLeave={() => setTooltip(null)}
            onFocus={event => reveal(event, tool.label)}
            onBlur={() => setTooltip(null)}>
            <span className={styles.icon}><ViewerToolIcon name={tool.id} /></span>
            <span className={styles.copy} aria-hidden={!expanded}>
              <span className={styles.name}>{tool.label}</span>
              <span className={styles.description}>{tool.description}</span>
            </span>
            {tool.active && <span className={styles.activeDot} aria-hidden="true" />}
          </button>
        ))}
      </div>
      {!expanded && tooltip && createPortal(
        <span className={styles.tooltip} style={{ top: tooltip.top, right: tooltip.right }} aria-hidden="true">{tooltip.label}</span>, document.body
      )}
    </aside>
  )
}
