/** A pinned folder, drawn as one tab and kept as one sidebar section. */
export type Pin = {
  /** The folder, absolute, as the session that pinned it reported it. */
  folder: string
  /** The text on the tab, and the name of its sidebar section. */
  label: string
  /** The sidebar section the folder's sessions are filed under; null until it has one. */
  sectionId: string | null
}

/** One Code session as the desktop app lists it. */
export type SessionRow = {
  id: string
  title: string
  /** The session's working folder. */
  folder: string
  /** A claude:// link that opens the session in the app; null where the app gives none. */
  link: string | null
  isRunning: boolean
  /** ISO time of the session's last activity. */
  lastActivityAt: string
  /** True only when the app says the session is in no sidebar section of the person's. */
  isUngrouped: boolean
  /** True when the person pinned the session in the sidebar. */
  isPinned: boolean
}

/** How the last read of the session list went. */
export type Probe = {
  ok: boolean
  error: string | null
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'env-tabs': {
      pins: Pin[]
      sessions: SessionRow[]
      here: string
      probe: Probe | null
    }
  }
}
