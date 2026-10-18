import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, SessionRow } from '../types'

const pins = atom({ plugin: 'env-tabs', key: 'pins' } as const, [])
const sessions = atom({ plugin: 'env-tabs', key: 'sessions' } as const, [])
const thisSession = atom({ plugin: 'env-tabs', key: 'thisSession' } as const, null)
const here = atom({ plugin: 'env-tabs', key: 'here' } as const, '')
const flipped = atom({ plugin: 'env-tabs', key: 'flipped' } as const, [])
const probe = atom({ plugin: 'env-tabs', key: 'probe' } as const, null)

const STORE_KEY = 'pins'
const FLIPPED_KEY = 'flipped'
const CLOSED_KEY = 'paneClosed'
const REFRESH_MS = 60_000
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
    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))
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
    const rows = await read($, sessions)
    const current = pinOf(folder, list)
    const { Box, Button, Text } = $.ui.resolve(e)
    const keep = keeperOf(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {list.map(pin => {
          const key = `tab:${normalize(pin.folder)}`
          const variant = current?.folder === pin.folder ? 'primary' : 'secondary'
          const isBusy = rows.some(
            row => row.isRunning && pinOf(row.folder, list)?.folder === pin.folder,
          )

          return keep(key, [pin, variant, isBusy], () =>
            isBusy ? (
              <Button key={key} variant={variant} onPress={() => goTo($, pin)}>
                {pin.label}
                <Text dimColor> ●</Text>
              </Button>
            ) : (
              <Button key={key} variant={variant} label={pin.label} onPress={() => goTo($, pin)} />
            ),
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, pins)
    const mine = await read($, thisSession)
    const others = await read($, sessions)
    const folder = await read($, here)
    const flips = await read($, flipped)
    const last = await read($, probe)
    const now = last?.at ?? 0
    const room = Math.max(8, e.props.bodyColumns - 10)
    // A project's row also holds its + New and Pin or Unpin buttons.
    const labelRoom = Math.max(8, e.props.bodyColumns - 18)
    const rows = mine === null ? others : [mine, ...others.filter(row => row.id !== mine.id)]
    const { pinned, rest } = projectsOf(list, rows)
    const current = folder === '' ? '' : keyOf(folder)
    const keep = keeperOf(e)

    const sessionRow = (row: SessionRow) => {
      const key = `session:${row.id}`
      const title = clip(row.title || 'Untitled session', room)
      const when = row.id === mine?.id ? 'here' : ago(row.lastActivityAt, now)

      return keep(key, [row.title, row.link, row.isRunning, title, when], () => (
        <Button key={key} plain onPress={() => openSession($, row)}>
          {title}
          <Text dimColor> {when}</Text>
          {row.isRunning && <Text dimColor> ●</Text>}
        </Button>
      ))
    }

    const projectRow = (project: Project) => {
      const isOpen = project.isPinned !== flips.includes(project.key)
      const isBusy = project.rows.some(row => row.isRunning)
      const isCurrent = project.key === current
      const label = clip(project.label, labelRoom)
      const hidden = project.rows.length - SHOWN
      const foldKey = `fold:${project.key}`
      const newKey = `new:${project.key}`
      const unpinKey = `unpin:${project.key}`
      const pinKey = `pin:${project.key}`

      // This computer has no folder to start a session in, or to pin.
      const actions = (path: string) => (
        <Box flexDirection="row" columnGap={1}>
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
          <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
            {keep(foldKey, [isOpen, isCurrent, label, isBusy], () => (
              <Button key={foldKey} plain onPress={() => setFlip($, project.key)}>
                {isOpen ? '▾ ' : '▸ '}
                <Text weight={isCurrent ? 'bold' : 'medium'}>{label}</Text>
                {isBusy && <Text dimColor> ●</Text>}
              </Button>
            ))}
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
          <Text dimColor weight="semibold">
            Pinned
          </Text>
          {pinned.length === 0 && <Text dimColor>Pin a project to keep it here.</Text>}
          {pinned.map(projectRow)}
        </Box>
        {rest.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor weight="semibold">
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
