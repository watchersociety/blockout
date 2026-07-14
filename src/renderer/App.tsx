/**
 * App shell: welcome screen, titlebar with the three-mode switch, the
 * Stage/Shoot/Deliver layouts, global keyboard map, and autosave.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, currentProjectJson } from './store'
import { Viewport } from './viewport/Viewport'
import { Library } from './panels/Library'
import { Inspector } from './panels/Inspector'
import { ProjectRail } from './panels/ProjectRail'
import { Timeline } from './panels/Timeline'
import { DeliverPanel } from './panels/DeliverPanel'
import { Toasts } from './panels/Toasts'
import { HelpOverlay } from './panels/Help'
import logoUrl from './assets/logo.png'

function CreditLink({ url, children }: { url: string; children: string }): JSX.Element {
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault()
        void window.blockout.openExternal(url)
      }}
      style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
    >
      {children}
    </a>
  )
}

export function Credits({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <div
      style={{
        color: 'var(--text-faint)',
        fontSize: compact ? 10 : 12,
        textAlign: 'center',
        lineHeight: 1.6,
        padding: compact ? '10px 12px' : 0
      }}
    >
      Created by Sam Wasserman
      {compact ? <br /> : ' · '}
      <CreditLink url="https://wassermanproductions.com">wassermanproductions.com</CreditLink>
      {' · '}
      <CreditLink url="https://wasserman.ai">wasserman.ai</CreditLink>
      {!compact && (
        <>
          <br />
          Open source under Apache-2.0 — keep this credit when using or forking.
        </>
      )}
    </div>
  )
}

function Welcome(): JSX.Element {
  const newProject = useStore((s) => s.newProject)
  const loadFromJson = useStore((s) => s.loadFromJson)
  const toast = useStore((s) => s.toast)
  const startupAttempted = useRef(false)
  const [reopening, setReopening] = useState(true)

  const rememberFolder = useCallback(async (folder: string): Promise<void> => {
    try {
      await window.blockout.rememberLastProject(folder)
    } catch {
      toast('Project opened, but Blockout could not remember it for next launch.', 'error')
    }
  }, [toast])

  const loadFolder = useCallback(async (folder: string): Promise<boolean> => {
    try {
      const { json, backupJson, backupNewer } = await window.blockout.loadProject(folder)
      if (!json && !backupJson) {
        toast('No project.json found in that folder.', 'error')
        return false
      }
      // A meaningfully-newer autosave means the app died with unsaved work —
      // restore it (undo history is fresh either way; ⌘S makes it permanent).
      if (backupNewer && backupJson && loadFromJson(folder, backupJson)) {
        await rememberFolder(folder)
        toast('Restored unsaved work from the autosave backup — Save to keep it.', 'success')
        return true
      }
      if (json && loadFromJson(folder, json)) {
        await rememberFolder(folder)
        return true
      }
      if (backupJson && loadFromJson(folder, backupJson)) {
        await rememberFolder(folder)
        toast('Recovered from autosave backup.', 'success')
        return true
      }
      return false
    } catch {
      toast('Could not open that project.', 'error')
      return false
    }
  }, [loadFromJson, rememberFolder, toast])

  useEffect(() => {
    if (startupAttempted.current) return
    startupAttempted.current = true
    void (async () => {
      try {
        const folder = await window.blockout.getLastProject()
        if (folder && !(await loadFolder(folder))) await window.blockout.clearLastProject()
      } catch {
        toast('Could not restore the last project; choose a project to continue.', 'error')
      } finally {
        setReopening(false)
      }
    })()
  }, [loadFolder, toast])

  const onNew = useCallback(async () => {
    const folder = await window.blockout.newProjectDialog()
    if (!folder) return
    const name = folder.split('/').pop()?.replace(/\.blockout$/, '') ?? 'Untitled'
    newProject(folder, name)
    const json = currentProjectJson()
    if (json) {
      await window.blockout.saveProject(folder, json)
      await rememberFolder(folder)
    }
  }, [newProject, rememberFolder])

  const onOpen = useCallback(async () => {
    const folder = await window.blockout.openProjectDialog()
    if (!folder) return
    await loadFolder(folder)
  }, [loadFolder])

  return (
    <div className="welcome">
      <img
        src={logoUrl}
        alt="Blockout"
        style={{ width: 260, height: 260, objectFit: 'contain', borderRadius: 16, marginBottom: -8 }}
      />
      <p>
        Stage a scene, choreograph camera and character blocking with marks, and export
        motion-reference packages for AI video generators.
      </p>
      <div className="actions">
        {reopening && <span style={{ color: 'var(--text-faint)' }}>Opening last project…</span>}
        <button className="btn primary" onClick={onNew} disabled={reopening}>
          New Project
        </button>
        <button className="btn" onClick={onOpen} disabled={reopening}>
          Open Project…
        </button>
        <button className="btn" onClick={() => useStore.getState().setHelpOpen(true)}>
          ? Tutorial
        </button>
      </div>
      <Credits />
    </div>
  )
}

function useAutosave(): void {
  // Depend on WHETHER a doc is open, not on the doc object — every mutation
  // replaces the doc, and re-arming a 60s timer on each edit means autosave
  // never fires for anyone actively working (the exact crash window it
  // exists to cover). The tick reads the latest doc from the store.
  const hasDoc = useStore((s) => s.doc !== null)
  const folder = useStore((s) => s.projectFolder)

  useEffect(() => {
    if (!hasDoc || !folder) return
    const interval = setInterval(() => {
      const json = currentProjectJson()
      if (json) void window.blockout.saveBackup(folder, json)
    }, 60_000)
    return () => clearInterval(interval)
  }, [hasDoc, folder])
}

function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (!s.doc) return
      const inField =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLSelectElement
      if (inField) return

      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        s.undo()
      } else if (meta && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        s.redo()
      } else if (meta && e.key === 's') {
        e.preventDefault()
        const json = currentProjectJson()
        if (json && s.projectFolder) {
          void window.blockout.saveProject(s.projectFolder, json).then(() => s.markSaved())
        }
      } else if (e.key === ' ') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (e.key === 'm' || e.key === 'M') {
        if (s.mode === 'shoot' && s.selection) s.setDroppingMarks(!s.droppingMarks)
      } else if (e.key === 'c' || e.key === 'C') {
        // Toggle everywhere except Deliver (which is always the shot view) —
        // being stuck in look-through with no exit was a real trap.
        if (s.mode !== 'deliver') s.setLookThrough(!s.lookThrough)
      } else if (e.key === '?') {
        s.setHelpOpen(!s.helpOpen)
      } else if (e.key === 'Escape') {
        if (s.helpOpen) {
          s.setHelpOpen(false)
          return
        }
        s.setPlacingAsset(null)
        s.setPlacingSequence(null)
        s.setDroppingMarks(false)
        s.setSelection(null)
      } else if (e.key >= '1' && e.key <= '9') {
        // Jump to camera mark N.
        const shot = s.shot()
        const idx = Number(e.key) - 1
        const mark = shot ? [...shot.camera.marks].sort((a, b) => a.time - b.time)[idx] : undefined
        if (mark) s.setTime(mark.time)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function App(): JSX.Element {
  const doc = useStore((s) => s.doc)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const dirty = useStore((s) => s.dirty)
  const markSaved = useStore((s) => s.markSaved)
  const folder = useStore((s) => s.projectFolder)

  useAutosave()
  useKeyboard()

  const onSave = useCallback(async () => {
    const json = currentProjectJson()
    if (json && folder) {
      await window.blockout.saveProject(folder, json)
      markSaved()
    }
  }, [folder, markSaved])

  if (!doc) {
    return (
      <div className="app">
        <div className="titlebar">
          <span className="app-name">BLOCKOUT</span>
        </div>
        <Welcome />
        <Toasts />
        <HelpOverlay />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="titlebar">
        <span className="app-name">BLOCKOUT</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {doc.name}
          {dirty ? ' •' : ''}
        </span>
        <div className="mode-switch">
          <button className={mode === 'stage' ? 'active' : ''} onClick={() => setMode('stage')}>
            STAGE
          </button>
          <button className={mode === 'shoot' ? 'active' : ''} onClick={() => setMode('shoot')}>
            SHOOT
          </button>
          <button className={mode === 'deliver' ? 'active' : ''} onClick={() => setMode('deliver')}>
            DELIVER
          </button>
        </div>
        <button className="btn small" onClick={onSave}>
          Save
        </button>
        <button
          className="btn small"
          title="Help: quick start, how-do-I answers, shortcuts (?)"
          onClick={() => useStore.getState().setHelpOpen(true)}
        >
          ? Help
        </button>
      </div>

      {mode === 'deliver' ? (
        <div className="deliver-layout">
          <div className="deliver-preview">
            <Viewport />
          </div>
          <DeliverPanel />
        </div>
      ) : (
        <div className="main">
          <div className="panel">
            <ProjectRail />
            {mode === 'stage' && <Library />}
            <Credits compact />
          </div>
          <div className="center-column">
            <div className="viewport-wrap">
              <Viewport />
            </div>
            {mode === 'shoot' && <Timeline />}
          </div>
          <div className="panel right">
            <Inspector />
          </div>
        </div>
      )}
      <Toasts />
      <HelpOverlay />
    </div>
  )
}
