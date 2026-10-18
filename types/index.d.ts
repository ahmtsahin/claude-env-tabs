/** A pinned folder: one tab above the prompt, and a place at the top of the Projects pane. */
export type Pin = {
  /** The folder, absolute, as the session that pinned it reported it. */
  folder: string
  /** The text on the tab, and the project's name in the pane. */
  label: string
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
      /** The other sessions, as list_sessions answers: it leaves this one out. */
      sessions: SessionRow[]
      /** This session, or null while the app has not said. */
      thisSession: SessionRow | null
      here: string
      /** Projects the person opened or closed in the pane, by their normalized folder. */
      flipped: string[]
      probe: Probe | null
    }
  }
}
