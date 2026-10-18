import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Pin, SessionRow, SessionState } from '../types'

const pins = atom({ plugin: 'env-tabs', key: 'pins' } as const, [])
const sessions = atom({ plugin: 'env-tabs', key: 'sessions' } as const, [])
const thisSession = atom({ plugin: 'env-tabs', key: 'thisSession' } as const, null)
const here = atom({ plugin: 'env-tabs', key: 'here' } as const, '')
const flipped = atom({ plugin: 'env-tabs', key: 'flipped' } as const, [])
const states = atom({ plugin: 'env-tabs', key: 'states' } as const, {})
const probe = atom({ plugin: 'env-tabs', key: 'probe' } as const, null)

const STORE_KEY = 'pins'
const FLIPPED_KEY = 'flipped'
const CLOSED_KEY = 'paneClosed'
const REFRESH_MS = 60_000
// How often the sessions' states are read again: a session waiting on the
// person should show soon.
const STATES_MS = 4_000
// The engine caps an MCP answer's size, so a long session list is asked for
// in a smaller size when the larger one is refused.
const LIST_LIMITS = [60, 30, 15]
const TOO_LARGE = /exceeds maximum allowed tokens/i
const TOOL = 'mcp__env-tabs__tabs'
const PANE = 'projects'
const PANE_TITLE = 'Projects'
// The most sessions an open project lists in the pane.
const SHOWN = 5

const HELP = [
  'Usage: /env-tabs [list | pin [folder] | unpin <n> | move <n> <to> | rename <n> <label> | panel | status]',
  "  pin     pins this session's project (or the folder given): a tab, and a place at the top of the Projects pane",
  '  unpin   removes tab <n> (or the tab with that label)',
  '  move    moves tab <n> to position <to>',
  '  rename  sets the label of tab <n>',
  '  panel   opens the Projects pane: the pinned projects first, then the rest, each with its sessions',
  '  status  shows what the tabs see',
].join('\n')

// Paths: Windows paths compare without case and with either slash.

const isWindowsPath = (path: string) =>
  /^[A-Za-z]:([\\/]|$)/.test(path) || path.startsWith('\\\\')

const normalize = (path: string) => {
  const trimmed = path.trim()

  return isWindowsPath(trimmed)
    ? trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : trimmed.replace(/\/+$/, '')
}

const baseName = (path: string) =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

// Projects as the sidebar groups sessions: a session belongs to the folder it
// runs in, so a folder inside a pinned one is a project of its own. A session
// in one of a repository's worktrees belongs to the repository.
const WORKTREE = /[\\/]\.claude[\\/]worktrees([\\/].*)?$/i

// The app runs a session started without a folder in a scratch folder it makes
// for that session; all of them are one project, This computer.
const SCRATCH = /[\\/]Claude[\\/]scratch-workspaces[\\/]/i
const SCRATCH_KEY = 'scratch'
const SCRATCH_LABEL = 'This computer'

const isScratch = (folder: string) => SCRATCH.test(folder)

const projectFolder = (folder: string) => folder.replace(WORKTREE, '')

/** The project a folder belongs to, by key. */
const keyOf = (folder: string) =>
  isScratch(folder) ? SCRATCH_KEY : normalize(projectFolder(folder))

/** The pin of a folder's project; a scratch folder has none. */
const pinOf = (folder: string, list: readonly Pin[]) =>
  isScratch(folder) ? undefined : list.find(pin => keyOf(pin.folder) === keyOf(folder))

// State and store. Each write skips a value that has not changed, so the band
// and the pane redraw only on news.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const setPins = async ($: EngineInterface, list: Pin[]) => {
  if (!same(await read($, pins), list)) {
    await update($, pins, () => list)
  }
}

const setSessions = async ($: EngineInterface, rows: SessionRow[]) => {
  if (!same(await read($, sessions), rows)) {
    await update($, sessions, () => rows)
  }
}

const setThisSession = async ($: EngineInterface, row: SessionRow | null) => {
  if (!same(await read($, thisSession), row)) {
    await update($, thisSession, () => row)
  }
}

const setHere = async ($: EngineInterface, folder: string) => {
  if ((await read($, here)) !== folder) {
    await update($, here, () => folder)
  }
}

const setFlipped = async ($: EngineInterface, keys: string[]) => {
  if (!same(await read($, flipped), keys)) {
    await update($, flipped, () => keys)
  }
}

const setStates = async ($: EngineInterface, value: Record<string, SessionState>) => {
  if (!same(await read($, states), value)) {
    await update($, states, () => value)
  }
}

const toPins = (value: unknown): Pin[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    const pin = item as Partial<Pin> | null

    return typeof pin?.folder === 'string' && typeof pin.label === 'string'
      ? [{ folder: pin.folder, label: pin.label }]
      : []
  })
}

const toKeys = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const loadPins = async ($: EngineInterface) => toPins(await $.store.get(STORE_KEY))

const savePins = async ($: EngineInterface, list: Pin[]) => {
  await $.store.set(STORE_KEY, list)
  await setPins($, list)
}

/**
 * Flips a project in the pane: open where it starts closed, closed where it
 * starts open. A pinned project starts open, any other closed.
 */
const setFlip = async ($: EngineInterface, key: string, isFlipped?: boolean) => {
  const keys = toKeys(await $.store.get(FLIPPED_KEY))
  const wanted = isFlipped ?? !keys.includes(key)
  const changed = keys.filter(one => one !== key).concat(wanted ? [key] : [])
  await $.store.set(FLIPPED_KEY, changed)
  await setFlipped($, changed)
}

// The desktop app's own tools, reached through its MCP servers.

const textOf = (blocks: readonly { text?: string }[]) =>
  blocks.map(block => block.text ?? '').join('')

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Calls one of the app's tools: its text answer, or a throw with the app's reason. */
const callApp = async (
  $: EngineInterface,
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => {
  const answer = await $.mcp.call(server, tool, args)
  const text = textOf(answer.content)
  if (answer.isError) {
    throw new Error(text)
  }

  return text
}

type ListedSession = {
  sessionId?: string
  title?: string
  cwd?: string
  link?: string
  isRunning?: boolean
  lastActivityAt?: string
}

const toRow = (item: unknown): SessionRow | undefined => {
  const row = item as ListedSession | null

  return typeof row?.sessionId === 'string' && typeof row.cwd === 'string'
    ? {
        id: row.sessionId,
        title: row.title ?? '',
        folder: row.cwd,
        link: row.link ?? null,
        isRunning: row.isRunning === true,
        lastActivityAt: row.lastActivityAt ?? '',
      }
    : undefined
}

const toRows = (text: string): SessionRow[] => {
  const parsed = parseJson(text)
  if (!Array.isArray(parsed)) {
    throw new Error(`list_sessions answered: ${text.slice(0, 200)}`)
  }

  return parsed.flatMap(item => toRow(item) ?? [])
}

const listSessions = async ($: EngineInterface) => {
  let text = ''
  for (const limit of LIST_LIMITS) {
    try {
      text = await callApp($, 'ccd_session_mgmt', 'list_sessions', { limit })
    } catch (error) {
      text = String(error)
      if (!TOO_LARGE.test(text)) {
        throw error
      }
      continue
    }
    if (!TOO_LARGE.test(text)) {
      return toRows(text)
    }
  }

  throw new Error(text.slice(0, 200))
}

/** This session, which list_sessions leaves out; null when the app does not say. */
const readThisSession = async ($: EngineInterface) => {
  try {
    const text = await callApp($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' })
    return toRow(parseJson(text)) ?? null
  } catch {
    return null
  }
}

// The sessions' states, as the desktop's sidebar dots show them. Each running
// session writes a file of its own under the Claude configuration folder:
// busy, idle, or waiting on the person. The desktop keeps a record of every
// session with when the person last looked at it and when it last did
// something: one that did something since is unread, running or not.

/** Focus written a moment before a turn's end still counts as seen. */
const UNREAD_SLACK_MS = 2_000

type Live = { host: string; status: string; at: number; updatedAt: number }
type Seen = { focusedAt: number; activityAt: number }
type Cached = { stamp: string; value: unknown }

const join = (...parts: string[]) => parts.join(isWindowsPath(parts[0] ?? '') ? '\\' : '/')

const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const fieldsOf = (text: string) => {
  const value = parseJson(text)
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

const toLive = (text: string): Live | undefined => {
  const file = fieldsOf(text)
  return typeof file?.hostSessionId === 'string' && typeof file.status === 'string'
    ? {
        host: file.hostSessionId,
        status: file.status,
        at: numberOf(file.statusUpdatedAt),
        updatedAt: numberOf(file.updatedAt),
      }
    : undefined
}

const toSeen = (text: string): Seen | undefined => {
  const file = fieldsOf(text)
  return file === undefined
    ? undefined
    : { focusedAt: numberOf(file.lastFocusedAt), activityAt: numberOf(file.lastActivityAt) }
}

const homeOf = async ($: EngineInterface) =>
  (await $.env.get('OS')) === 'Windows_NT' ? $.env.get('USERPROFILE') : $.env.get('HOME')

/** The folder each running session writes its own file into. */
const liveDirOf = async ($: EngineInterface) => {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await homeOf($)

  return config ? join(config, 'sessions') : home ? join(home, '.claude', 'sessions') : null
}

const isDir = async ($: EngineInterface, path: string) => $.fs.exists(path).catch(() => false)

/**
 * The folder of the desktop's session records: in its own folder of the
 * user's application data, or, for the Microsoft Store build, in its package.
 */
const recordsDirOf = async ($: EngineInterface) => {
  const tail = ['Claude', 'claude-code-sessions']
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const appData = await $.env.get('APPDATA')
    if (appData && (await isDir($, join(appData, ...tail)))) {
      return join(appData, ...tail)
    }
    const localAppData = await $.env.get('LOCALAPPDATA')
    const packages = localAppData ? join(localAppData, 'Packages') : null
    for (const entry of packages === null ? [] : await $.fs.list(packages).catch(() => [])) {
      const dir = join(packages ?? '', entry.name, 'LocalCache', 'Roaming', ...tail)
      if (entry.kind === 'dir' && entry.name.startsWith('Claude_') && (await isDir($, dir))) {
        return dir
      }
    }
    return null
  }
  const home = await homeOf($)
  const config = (await $.env.get('XDG_CONFIG_HOME')) || (home ? join(home, '.config') : '')
  const candidates = [home ? join(home, 'Library', 'Application Support', ...tail) : '', config ? join(config, ...tail) : '']
  for (const dir of candidates) {
    if (dir !== '' && (await isDir($, dir))) {
      return dir
    }
  }

  return null
}

// Where the states are read from, looked for again at every refresh so that a
// folder made later is found; and the files read before, by path, each read
// again only once its size or time moved.
let sources: { records: string | null; live: string | null } | undefined
let readCache = new Map<string, Cached>()

const readParsed = async <T,>(
  $: EngineInterface,
  path: string,
  stamp: string,
  parse: (text: string) => T | undefined,
  kept: Map<string, Cached>,
) => {
  const held = readCache.get(path)
  const value =
    held?.stamp === stamp
      ? (held.value as T | undefined)
      : parse(await $.fs.read(path).then(String, () => ''))
  kept.set(path, { stamp, value })

  return value
}

/** The running sessions' own files, the latest by session where one left another behind. */
const readLive = async ($: EngineInterface, dir: string, kept: Map<string, Cached>) => {
  const byHost = new Map<string, Live>()
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) {
      continue
    }
    const file = await readParsed($, join(dir, entry.name), `${entry.size}:${entry.mtimeMs}`, toLive, kept)
    const held = file === undefined ? undefined : byHost.get(file.host)
    if (file !== undefined && (held === undefined || file.updatedAt >= held.updatedAt)) {
      byHost.set(file.host, file)
    }
  }

  return byHost
}

/** The desktop's records of the sessions wanted, by session id: each file is named for its session. */
const readSeen = async (
  $: EngineInterface,
  dir: string,
  wanted: ReadonlySet<string>,
  kept: Map<string, Cached>,
  depth = 0,
): Promise<Map<string, Seen>> => {
  const seen = new Map<string, Seen>()
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const path = join(dir, entry.name)
    const id = entry.name.replace(/\.json$/, '')
    if (entry.kind === 'dir' && depth < 3) {
      for (const [one, record] of await readSeen($, path, wanted, kept, depth + 1)) {
        seen.set(one, record)
      }
    } else if (entry.kind === 'file' && id !== entry.name && wanted.has(id)) {
      const record = await readParsed($, path, `${entry.size}:${entry.mtimeMs}`, toSeen, kept)
      if (record !== undefined) {
        seen.set(id, record)
      }
    }
  }

  return seen
}

/** A session's state from its own file and its record; this session is never unread, it is in view. */
const stateOf = (row: SessionRow, own: Live | undefined, seen: Seen | undefined, isMine: boolean) => {
  if (own?.status === 'waiting') {
    return 'waiting'
  }
  if (own?.status === 'busy' || (own === undefined && row.isRunning)) {
    return 'running'
  }
  const doneAt = Math.max(seen?.activityAt ?? 0, own?.at ?? 0)

  return seen !== undefined && !isMine && doneAt > seen.focusedAt + UNREAD_SLACK_MS ? 'unread' : undefined
}

/** Reads the listed sessions' states again; the pane and the tabs redraw where one changed. */
const pollStates = async ($: EngineInterface) => {
  try {
    sources ??= { records: await recordsDirOf($), live: await liveDirOf($) }
    const mine = await read($, thisSession)
    const others = await read($, sessions)
    const rows = mine === null ? others : [mine, ...others.filter(row => row.id !== mine.id)]
    const kept = new Map<string, Cached>()
    const live = sources.live === null ? new Map<string, Live>() : await readLive($, sources.live, kept)
    const wanted = new Set(rows.map(row => row.id))
    const seen = sources.records === null ? new Map<string, Seen>() : await readSeen($, sources.records, wanted, kept)
    readCache = kept

    const value: Record<string, SessionState> = {}
    for (const row of rows) {
      const state = stateOf(row, live.get(row.id), seen.get(row.id), row.id === mine?.id)
      if (state !== undefined) {
        value[row.id] = state
      }
    }
    await setStates($, value)
  } catch {
    // The states are a hint: the next read tries again.
  }
}

/** What status says of the states: where they are read from. */
const statesLine = () => {
  if (sources === undefined) {
    return 'Session states: not read yet.'
  }
  if (sources.records === null && sources.live === null) {
    return 'Session states: unavailable (no session records or session files found).'
  }

  return `Session states: read from ${sources.records ?? '(no session records)'} and ${sources.live ?? '(no session files)'}.`
}

const refresh = async ($: EngineInterface) => {
  await setPins($, await loadPins($))
  await setFlipped($, toKeys(await $.store.get(FLIPPED_KEY)))
  await setHere($, await $.session.root())
  await setThisSession($, await readThisSession($))
  const at = await $.clock.now()

  try {
    await setSessions($, await listSessions($))
    await update($, probe, () => ({ ok: true, error: null, at }))
  } catch (error) {
    await update($, probe, () => ({ ok: false, error: String(error), at }))
  }
  sources = { records: await recordsDirOf($), live: await liveDirOf($) }
  await pollStates($)
}

// Opening a session: its claude:// link, handed to the operating system.

const openLink = async ($: EngineInterface, url: string) => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const commands = isWindows
    ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
    : [
        ['open', url],
        ['xdg-open', url],
      ]

  for (const argv of commands) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 })
      if (ran.exitCode === 0) {
        return true
      }
    } catch {
      // Not on this system: try the next opener.
    }
  }

  return false
}

/**
 * The app's documented link for a new Code session in a folder. The app asks
 * the person to confirm the folder each time: a link's folder is not trusted.
 */
const newSessionLink = (folder: string) =>
  `claude://code/new?folder=${encodeURIComponent(folder)}`

const startSession = async ($: EngineInterface, folder: string, label: string) => {
  if (!(await openLink($, newSessionLink(folder)))) {
    $.ui.toast(`Could not start a session in ${label}.`)
  }
}

const openSession = async ($: EngineInterface, row: SessionRow) => {
  if (row.id === (await read($, thisSession))?.id) {
    $.ui.toast('You are in this session.')
    return
  }
  if (row.link === null || !(await openLink($, row.link))) {
    $.ui.toast(`Could not open "${row.title}".`)
  }
}

const goTo = async ($: EngineInterface, target: Pin) => {
  await refresh($)
  const list = await read($, pins)
  if (pinOf(await read($, here), list)?.folder === target.folder) {
    $.ui.toast(`You are in ${target.label} already.`)
    return
  }

  const latest = (await read($, sessions))
    .filter(row => row.link !== null && pinOf(row.folder, list)?.folder === target.folder)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
  if (latest === undefined) {
    await startSession($, target.folder, target.label)
    return
  }
  await openSession($, latest)
}

// The Projects pane: the pinned projects in the order of their tabs, then the
// other projects with a session among the recent ones, the latest first, and
// This computer last.

type Project = {
  key: string
  /** Its folder; null for This computer, whose sessions each have their own. */
  folder: string | null
  label: string
  isPinned: boolean
  /** Its sessions, the latest first. */
  rows: SessionRow[]
}

const projectsOf = (list: readonly Pin[], rows: readonly SessionRow[]) => {
  const latestFirst = [...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const pinned: Project[] = list.map(pin => ({
    key: keyOf(pin.folder),
    folder: pin.folder,
    label: pin.label,
    isPinned: true,
    rows: latestFirst.filter(row => pinOf(row.folder, list)?.folder === pin.folder),
  }))

  const rest = new Map<string, Project>()
  for (const row of latestFirst) {
    if (pinOf(row.folder, list) !== undefined) {
      continue
    }
    const key = keyOf(row.folder)
    const folder = key === SCRATCH_KEY ? null : projectFolder(row.folder)
    const project: Project = rest.get(key) ?? {
      key,
      folder,
      label: folder === null ? SCRATCH_LABEL : baseName(folder),
      isPinned: false,
      rows: [],
    }
    project.rows.push(row)
    rest.set(key, project)
  }
  const others = [...rest.values()]

  return {
    pinned,
    rest: [
      ...others.filter(project => project.key !== SCRATCH_KEY),
      ...others.filter(project => project.key === SCRATCH_KEY),
    ],
  }
}

/** How long ago an ISO time was, in the unit that reads best: 5m, 3h, 2d, 6w. */
const ago = (iso: string, now: number) => {
  const then = Date.parse(iso)
  if (Number.isNaN(then) || now === 0) {
    return ''
  }

  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`
}

/** Cuts a text to a number of characters, an ellipsis last where it was cut. */
const clip = (text: string, room: number) => {
  const chars = Array.from(text)

  return chars.length <= room ? text : `${chars.slice(0, Math.max(1, room - 1)).join('')}…`
}

// Buttons kept across redraws. A Button built again gets a new handle and the
// engine lets the old one go, so a click the surface sends from the drawing it
// still shows runs nothing, and the surface only draws again. Redraws land
// between a drawing and a click often enough to lose first clicks: the pane
// taking the keyboard, the desktop asking for every drawing again, the session
// list read again. A Button whose look and action have not changed is
// therefore handed back as it was, its handle with it.

type Kept = { inputs: string; element: unknown }

/** Each site's Buttons by key, as its latest drawing handed them out. */
const keptBySite = new Map<string, Map<string, Kept>>()

/**
 * What one drawing builds its Buttons with. Taken once the drawing's reads are
 * done, so drawings of one site do not interleave; the Buttons a drawing leaves
 * out are let go.
 */
const keeperOf = (e: { surface: string; component: string; requestId: string }) => {
  const site = [e.surface, e.component, e.requestId].join('\u0000')
  const before = keptBySite.get(site) ?? new Map<string, Kept>()
  const after = new Map<string, Kept>()
  keptBySite.set(site, after)

  /** The Button under `key`, built again only when `inputs`, what it shows and does, change. */
  return <T,>(key: string, inputs: unknown[], build: () => T): T => {
    const said = JSON.stringify(inputs)
    const held = before.get(key)
    const element = held?.inputs === said ? (held.element as T) : build()
    after.set(key, { inputs: said, element })

    return element
  }
}

// The look: each project's icon, the fill that marks the current row, and the
// wash that lights a row under the pointer.

/** Each pair is a light square and its dark letter; a dark theme swaps the two. */
const SWATCHES = [
  ['#F5C4B3', '#712B13'],
  ['#9FE1CB', '#085041'],
  ['#CECBF6', '#3C3489'],
  ['#C0DD97', '#27500A'],
  ['#B5D4F4', '#0C447C'],
  ['#FAC775', '#633806'],
  ['#F4C0D1', '#72243E'],
] as const

const ICON_SIZE = 20

/** A project's colors, picked from its key so that a renamed tab keeps them. */
const swatchOf = (key: string) => {
  let hash = 0
  for (const char of key) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }

  return SWATCHES[hash % SWATCHES.length] ?? SWATCHES[0]
}

/** The first letter or digit of a name: what its icon shows. */
const letterOf = (name: string) => (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()

const escapeXml = (text: string) => text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)

const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 20 20">`

/** A project's letter on its square, in the theme's light or dark. */
const letterSvg = (key: string, label: string) => {
  const [fill, ink] = swatchOf(key)

  return (
    SVG_OPEN +
    `<style>.s{fill:${fill}}.l{fill:${ink}}` +
    `@media (prefers-color-scheme: dark){.s{fill:${ink}}.l{fill:${fill}}}</style>` +
    '<rect class="s" x="2" y="2" width="16" height="16" rx="4"/>' +
    '<text class="l" x="10" y="10.5" font-size="10" font-weight="600" ' +
    'font-family="system-ui, -apple-system, Segoe UI, sans-serif" text-anchor="middle" ' +
    `dominant-baseline="central">${escapeXml(letterOf(label))}</text></svg>`
  )
}

/** This computer's icon: a screen on its stand. */
const COMPUTER_SVG =
  SVG_OPEN +
  '<style>.m{stroke:#73726c}@media (prefers-color-scheme: dark){.m{stroke:#a3a29c}}</style>' +
  '<g class="m" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="4" width="14" height="9.5" rx="1.5"/><path d="M7.5 16.5h5M10 13.5v3"/></g></svg>'

/**
 * A project's icon: an SVG where the surface draws one, else its letter in a
 * colored cell. The terminal's table answers Svg too, with an empty stand-in.
 */
const iconOf = (els: ElementTable, surface: string, key: string, label: string) => {
  const { Text } = els
  if (surface !== 'terminal' && 'Svg' in els) {
    const { Svg } = els
    const source = key === SCRATCH_KEY ? COMPUTER_SVG : letterSvg(key, label)

    return <Svg source={source} alt={label} width={ICON_SIZE} height={ICON_SIZE} />
  }
  if (key === SCRATCH_KEY) {
    return <Text dimColor>{' ▪ '}</Text>
  }
  const [fill, ink] = swatchOf(key)

  return (
    <Text backgroundColor={fill} color={ink}>
      {` ${letterOf(label)} `}
    </Text>
  )
}

// The desktop's own fill for what is selected, and a wash for what the pointer is over.
const ACTIVE = 'userMessageBackground'
const LIT = 'rgba(128, 128, 128, 0.14)'

/** Whether a surface has a pointer to hover with: the terminal and the phone have none. */
const canHover = (surface: string) => surface === 'desktop' || surface === 'vscode'

/** A row's fill: the selected row filled, any other lit while the pointer is over it. */
const fillOf = (surface: string, isSelected: boolean) =>
  isSelected
    ? { backgroundColor: ACTIVE }
    : canHover(surface)
      ? { backgroundColor: 'transparent', hover: { backgroundColor: LIT } }
      : {}

/** A Button in a lit row: its own highlight under the pointer off, the row's is enough. */
const quietOf = (surface: string) =>
  canHover(surface) ? { hover: { backgroundColor: 'transparent' } } : {}

// A session's state as the sidebar's dot draws it, and the count of a
// project's sessions that need the person, in the color of the most urgent.

type Shown = SessionState | 'idle'

/** Each state's dot: [light theme, dark theme]. */
const DOT_COLORS: Record<Shown, readonly [string, string]> = {
  waiting: ['#BA7517', '#EF9F27'],
  unread: ['#378ADD', '#85B7EB'],
  running: ['#888780', '#B4B2A9'],
  idle: ['#B4B2A9', '#5F5E5A'],
}

/** A count's pill: [fill, number] in a light theme, then in a dark one. */
const BADGE_COLORS = {
  waiting: ['#FAEEDA', '#633806', '#633806', '#FAC775'],
  unread: ['#E6F1FB', '#0C447C', '#0C447C', '#B5D4F4'],
} as const

const STATE_LABELS: Record<Shown, string> = {
  waiting: 'Waiting for you',
  unread: 'Unread',
  running: 'Running',
  idle: 'Idle',
}

/** The terminal's theme colors for the states. */
const STATE_THEME: Record<SessionState, string> = {
  waiting: 'warning',
  unread: 'suggestion',
  running: 'inactive',
}

const DOT_WIDTH = 12

/** A state's dot: filled, pulsing while the session runs, a ring when it is idle. */
const dotSvg = (state: Shown) => {
  const [light, dark] = DOT_COLORS[state]
  const paint = state === 'idle' ? 'fill:none;stroke:' : 'fill:'
  const pulse =
    state === 'running'
      ? '<animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite"/>'
      : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_WIDTH}" height="${ICON_SIZE}" viewBox="0 0 ${DOT_WIDTH} ${ICON_SIZE}">` +
    `<style>.d{${paint}${light}}@media (prefers-color-scheme: dark){.d{${paint}${dark}}}</style>` +
    `<circle class="d" cx="6" cy="10" r="${state === 'idle' ? 3.25 : 4}" stroke-width="1.5">${pulse}</circle></svg>`
  )
}

/** A count as a pill, and how wide it is drawn. */
const badgeSvg = (count: number, state: keyof typeof BADGE_COLORS) => {
  const text = count > 99 ? '99+' : String(count)
  const width = Math.max(18, 10 + text.length * 6)
  const [fill, ink, darkFill, darkInk] = BADGE_COLORS[state]
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ICON_SIZE}" viewBox="0 0 ${width} ${ICON_SIZE}">` +
    `<style>.p{fill:${fill}}.n{fill:${ink}}` +
    `@media (prefers-color-scheme: dark){.p{fill:${darkFill}}.n{fill:${darkInk}}}</style>` +
    `<rect class="p" x="0" y="2" width="${width}" height="16" rx="8"/>` +
    `<text class="n" x="${width / 2}" y="10.5" font-size="10.5" font-weight="600" ` +
    'font-family="system-ui, -apple-system, Segoe UI, sans-serif" text-anchor="middle" ' +
    `dominant-baseline="central">${text}</text></svg>`

  return { source, width }
}

/** A session's dot: an SVG where the surface draws one, else a glyph in the theme's color. */
const dotOf = (els: ElementTable, surface: string, state: SessionState | undefined) => {
  const { Text } = els
  if (surface !== 'terminal' && 'Svg' in els) {
    const { Svg } = els
    const shown = state ?? 'idle'

    return <Svg source={dotSvg(shown)} alt={STATE_LABELS[shown]} width={DOT_WIDTH} height={ICON_SIZE} />
  }

  return state === undefined ? <Text>{' '}</Text> : <Text color={STATE_THEME[state]}>●</Text>
}

/**
 * What a project's row and tab show of its sessions: how many wait for the
 * person or are unread, else a running dot while one runs, else nothing.
 */
const markOf = (
  els: ElementTable,
  surface: string,
  ids: readonly string[],
  value: Readonly<Record<string, SessionState>>,
) => {
  const list = ids.map(id => value[id])
  const waiting = list.filter(state => state === 'waiting').length
  const need = waiting + list.filter(state => state === 'unread').length
  if (need === 0) {
    return list.includes('running') ? dotOf(els, surface, 'running') : null
  }
  const state = waiting > 0 ? 'waiting' : 'unread'
  const { Text } = els
  if (surface !== 'terminal' && 'Svg' in els) {
    const { Svg } = els
    const { source, width } = badgeSvg(need, state)

    return <Svg source={source} alt={`${need} need you`} width={width} height={ICON_SIZE} />
  }

  return (
    <Text color={STATE_THEME[state]} bold>
      {String(need)}
    </Text>
  )
}

/** Opens the pane at the person's ask: what to tell them when it is not drawn, or nothing. */
const showPane = async ($: EngineInterface) => {
  await $.store.set(CLOSED_KEY, false)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })

  return opened.isPlaced ? '' : `The Projects pane is not drawn yet: ${opened.reason}`
}

// Changing the pins: the command, the model's tool, the band and the pane share these.

const indexOf = (list: readonly Pin[], key: string) => {
  const wanted = key.trim()
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted) - 1
    return index >= 0 && index < list.length ? index : -1
  }

  return list.findIndex(
    pin =>
      pin.label.toLowerCase() === wanted.toLowerCase() ||
      normalize(pin.folder) === normalize(wanted),
  )
}

const pinFolder = async ($: EngineInterface, folder: string, label?: string) => {
  if (isScratch(folder)) {
    return `${folder} is a scratch folder the app made for a session started without one: there is no project to pin.`
  }
  const list = await loadPins($)
  const existing = list.find(pin => keyOf(pin.folder) === keyOf(folder))
  if (existing !== undefined) {
    return `${existing.label} is pinned already.`
  }

  const added = { folder, label: label?.trim() || baseName(folder) }
  await savePins($, [...list, added])
  await setFlip($, keyOf(folder), false)
  await refresh($)

  return `Pinned ${added.label} (${folder}): it has a tab, and stays at the top of the Projects pane.`
}

const unpinTab = async ($: EngineInterface, key: string) => {
  const list = await loadPins($)
  const removed = list[indexOf(list, key)]
  if (removed === undefined) {
    return `No tab matches "${key}".`
  }

  await savePins($, list.filter(pin => pin !== removed))
  await setFlip($, keyOf(removed.folder), false)

  return `Unpinned ${removed.label}.`
}

const moveTab = async ($: EngineInterface, key: string, to: number) => {
  const list = await loadPins($)
  const moved = list[indexOf(list, key)]
  if (moved === undefined) {
    return `No tab matches "${key}".`
  }

  const others = list.filter(pin => pin !== moved)
  const target = Math.min(Math.max(to, 1), others.length + 1) - 1
  others.splice(target, 0, moved)
  await savePins($, others)

  return `Moved ${moved.label} to position ${target + 1}.`
}

const renameTab = async ($: EngineInterface, key: string, label: string) => {
  const list = await loadPins($)
  const old = list[indexOf(list, key)]
  if (old === undefined) {
    return `No tab matches "${key}".`
  }

  const name = label.trim()
  await savePins($, list.map(pin => (pin === old ? { ...old, label: name } : pin)))

  return `Renamed ${old.label} to ${name}.`
}

const describe = (list: readonly Pin[], rows: readonly SessionRow[]) => {
  if (list.length === 0) {
    return 'No pinned folders yet. Run /env-tabs pin in a session to pin its project.'
  }

  return list
    .map((pin, index) => {
      const count = rows.filter(row => pinOf(row.folder, list)?.folder === pin.folder).length
      return `${index + 1}. ${pin.label}  (${pin.folder}; ${count} other session${count === 1 ? '' : 's'})`
    })
    .join('\n')
}

const status = async ($: EngineInterface) => {
  await refresh($)
  const last = await read($, probe)
  const rows = await read($, sessions)

  return [
    `This session's folder: ${await read($, here)}`,
    last?.ok
      ? `Session list: ${rows.length} other sessions read.`
      : `Session list: unavailable (${last?.error ?? 'not read yet'}).`,
    statesLine(),
    '',
    describe(await read($, pins), rows),
  ].join('\n')
}

const runCommand = async ($: EngineInterface, args: string) => {
  const trimmed = args.trim()
  const [verb = 'list'] = trimmed.split(/\s+/, 1).filter(Boolean)
  const tail = trimmed.slice(verb.length).trim()

  switch (verb.toLowerCase()) {
    case 'list': {
      await refresh($)
      return describe(await read($, pins), await read($, sessions))
    }
    case 'pin':
      return pinFolder($, tail || projectFolder(await $.session.root()))
    case 'unpin':
      return tail ? unpinTab($, tail) : HELP
    case 'move': {
      const match = /^(.*\S)\s+(\d+)$/.exec(tail)
      return match?.[1] && match[2] ? moveTab($, match[1], Number(match[2])) : HELP
    }
    case 'rename': {
      const match = /^(\d+)\s+(.*\S)$/.exec(tail)
      return match?.[1] && match[2] ? renameTab($, match[1], match[2]) : HELP
    }
    case 'panel':
      return (await showPane($)) || 'The Projects pane is open.'
    case 'status':
      return status($)
    default:
      return HELP
  }
}

type ToolInput = {
  action?: string
  folder?: string
  tab?: string
  label?: string
  position?: number
}

const runTool = async ($: EngineInterface, input: ToolInput) => {
  switch (input.action) {
    case 'pin':
      return pinFolder(
        $,
        input.folder?.trim() || projectFolder(await $.session.root()),
        input.label,
      )
    case 'unpin':
      return input.tab ? unpinTab($, input.tab) : 'Name the tab to unpin.'
    case 'move':
      return input.tab && input.position
        ? moveTab($, input.tab, input.position)
        : 'Name the tab and its new position.'
    case 'rename':
      return input.tab && input.label?.trim()
        ? renameTab($, input.tab, input.label)
        : 'Name the tab and its new label.'
    case 'panel':
      return (await showPane($)) || 'The Projects pane is open.'
    default:
      return status($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'env-tabs',
      description: 'Pinned projects as tabs above the prompt and at the top of a Projects pane',
      argumentHint: '[list|pin|unpin|move|rename|panel|status]',
    })
    await $.tool.register({
      name: 'tabs',
      description:
        "Reads and changes env-tabs: pinned projects (folders), each drawn as a tab above the prompt in Claude Desktop's Code tab " +
        'and kept at the top of its Projects pane, which lists every recent project with its sessions. ' +
        'action "status" lists the pins and what they see; "pin" pins a folder (this session\'s project when none is given); ' +
        '"unpin", "move" and "rename" take a tab by its 1-based number or its label; "panel" opens the Projects pane.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'pin', 'unpin', 'move', 'rename', 'panel'],
          },
          folder: { type: 'string', description: 'The absolute folder to pin (pin only).' },
          tab: { type: 'string', description: 'The tab: its 1-based number or its label.' },
          label: { type: 'string', description: 'The text on the tab (pin, rename).' },
          position: {
            type: 'integer',
            minimum: 1,
            description: 'The new 1-based position (move).',
          },
        },
        required: ['action'],
      },
      isDeferred: true,
    })
    const started = await next(e)
    sources = undefined
    readCache = new Map()
    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
    $.clock.every(STATES_MS, () => pollStates($))
    // The pane opens by itself where the surface has room for it beside the
    // transcript, unless the person closed it.
    if ((await $.store.get(CLOSED_KEY)) !== true) {
      void $.ui.open({ id: PANE, title: PANE_TITLE })
    }

    return started
  })

  // A pane the person closed stays closed in later sessions, until they open it again.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await $.store.set(CLOSED_KEY, true)
    }

    return next(e)
  })

  on('command.run', { command: 'env-tabs' }, async ($, e) => ({
    text: await runCommand($, e.args),
  }))

  on('tool.call', { tool: TOOL }, async ($, e) => ({
    result: await runTool($, e as unknown as ToolInput),
  })).catch(() => ({ result: 'env-tabs could not answer; run /env-tabs status to see why.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const folder = await read($, here)
    if (e.props.hasSurvey || folder === '') {
      return next(e)
    }

    const list = await read($, pins)
    const mine = await read($, thisSession)
    const others = await read($, sessions)
    const value = await read($, states)
    const rows = mine === null ? others : [mine, ...others.filter(row => row.id !== mine.id)]
    const current = pinOf(folder, list)
    const els = $.ui.resolve(e)
    const { Box, Button } = els
    const keep = keeperOf(e)
    const quiet = quietOf(e.surface)

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
        {list.map(pin => {
          const key = `tab:${normalize(pin.folder)}`
          const isCurrent = current?.folder === pin.folder
          const ids = rows.filter(row => pinOf(row.folder, list)?.folder === pin.folder).map(row => row.id)

          return (
            <Box
              key={`tabrow:${normalize(pin.folder)}`}
              flexDirection="row"
              alignItems="center"
              columnGap={1}
              paddingRight={1}
              {...fillOf(e.surface, isCurrent)}
            >
              {iconOf(els, e.surface, keyOf(pin.folder), pin.label)}
              {keep(key, [pin, isCurrent], () => (
                <Button
                  key={key}
                  plain
                  dimColor={!isCurrent}
                  {...quiet}
                  label={pin.label}
                  onPress={() => goTo($, pin)}
                />
              ))}
              {markOf(els, e.surface, ids, value)}
            </Box>
          )
        })}
        {current === undefined &&
          !isScratch(folder) &&
          keep('pin-here', [folder], () => (
            <Button
              key="pin-here"
              plain
              label="+ Pin this folder"
              onPress={async () => $.ui.toast(await pinFolder($, projectFolder(folder)))}
            />
          ))}
        {keep('projects', [], () => (
          <Button
            key="projects"
            plain
            dimColor
            label="Projects"
            onPress={async () => {
              const said = await showPane($)
              if (said !== '') {
                $.ui.toast(said)
              }
            }}
          />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const list = await read($, pins)
    const mine = await read($, thisSession)
    const others = await read($, sessions)
    const folder = await read($, here)
    const flips = await read($, flipped)
    const value = await read($, states)
    const last = await read($, probe)
    const now = last?.at ?? 0
    const room = Math.max(8, e.props.bodyColumns - 10)
    // A project's row also holds its + New and Pin or Unpin buttons.
    const labelRoom = Math.max(8, e.props.bodyColumns - 18)
    const rows = mine === null ? others : [mine, ...others.filter(row => row.id !== mine.id)]
    const { pinned, rest } = projectsOf(list, rows)
    const current = folder === '' ? '' : keyOf(folder)
    const keep = keeperOf(e)
    const quiet = quietOf(e.surface)
    // + New and Pin or Unpin show while the pointer is over their project's row.
    const onHover = canHover(e.surface) ? ({ display: 'none', hover: { display: 'flex' } } as const) : {}

    // A session's age stands at the end of its row, outside its button: the
    // button stays as it was while the age moves on.
    const sessionRow = (row: SessionRow) => {
      const key = `session:${row.id}`
      const title = clip(row.title || 'Untitled session', room)
      const when = row.id === mine?.id ? 'here' : ago(row.lastActivityAt, now)

      return (
        <Box
          key={`srow:${row.id}`}
          flexDirection="row"
          alignItems="center"
          columnGap={1}
          {...fillOf(e.surface, false)}
        >
          {dotOf(els, e.surface, value[row.id])}
          <Box flexGrow={1} flexShrink={1}>
            {keep(key, [row.title, row.link, title], () => (
              <Button key={key} plain {...quiet} onPress={() => openSession($, row)}>
                {title}
              </Button>
            ))}
          </Box>
          <Text dimColor tabular>
            {when}
          </Text>
        </Box>
      )
    }

    const projectRow = (project: Project) => {
      const isOpen = project.isPinned !== flips.includes(project.key)
      const isCurrent = project.key === current
      const label = clip(project.label, labelRoom)
      const hidden = project.rows.length - SHOWN
      const foldKey = `fold:${project.key}`
      const newKey = `new:${project.key}`
      const unpinKey = `unpin:${project.key}`
      const pinKey = `pin:${project.key}`

      // This computer has no folder to start a session in, or to pin.
      const actions = (path: string) => (
        <Box flexDirection="row" columnGap={1} {...onHover}>
          {keep(newKey, [path, project.label], () => (
            <Button
              key={newKey}
              plain
              dimColor
              label="+ New"
              onPress={() => startSession($, path, project.label)}
            />
          ))}
          {project.isPinned
            ? keep(unpinKey, [path], () => (
                <Button
                  key={unpinKey}
                  plain
                  dimColor
                  label="Unpin"
                  onPress={async () => $.ui.toast(await unpinTab($, path))}
                />
              ))
            : keep(pinKey, [path], () => (
                <Button
                  key={pinKey}
                  plain
                  dimColor
                  label="Pin"
                  onPress={async () => $.ui.toast(await pinFolder($, path))}
                />
              ))}
        </Box>
      )

      return (
        <Box key={`project:${project.key}`} flexDirection="column">
          <Box
            key={`row:${project.key}`}
            flexDirection="row"
            alignItems="center"
            columnGap={1}
            {...fillOf(e.surface, isCurrent)}
          >
            {iconOf(els, e.surface, project.key, project.label)}
            <Box flexGrow={1} flexShrink={1}>
              {keep(foldKey, [isOpen, isCurrent, label], () => (
                <Button key={foldKey} plain {...quiet} onPress={() => setFlip($, project.key)}>
                  <Text weight={isCurrent ? 'bold' : 'medium'}>{label}</Text>
                  <Text dimColor>{isOpen ? ' ▾' : ' ▸'}</Text>
                </Button>
              ))}
            </Box>
            {markOf(
              els,
              e.surface,
              project.rows.map(row => row.id),
              value,
            )}
            {project.folder !== null && actions(project.folder)}
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {project.rows.length === 0 && <Text dimColor>No recent sessions</Text>}
              {project.rows.slice(0, SHOWN).map(sessionRow)}
              {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text dimColor size="caption" weight="medium">
            Pinned
          </Text>
          {pinned.length === 0 && <Text dimColor>Pin a project to keep it here.</Text>}
          {pinned.map(projectRow)}
        </Box>
        {rest.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor size="caption" weight="medium">
              Projects
            </Text>
            {rest.map(projectRow)}
          </Box>
        )}
        {last?.ok === false && (
          <Text color="error">Sessions could not be read: {(last.error ?? '').slice(0, 200)}</Text>
        )}
      </Box>
    )
  })
}
