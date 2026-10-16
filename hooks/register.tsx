import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pin, SessionRow } from '../types'

const pins = atom({ plugin: 'env-tabs', key: 'pins' } as const, [])
const sessions = atom({ plugin: 'env-tabs', key: 'sessions' } as const, [])
const here = atom({ plugin: 'env-tabs', key: 'here' } as const, '')
const probe = atom({ plugin: 'env-tabs', key: 'probe' } as const, null)

const STORE_KEY = 'pins'
const REFRESH_MS = 60_000
// The engine caps an MCP answer's size, so a long session list is asked for
// in a smaller size when the larger one is refused.
const LIST_LIMITS = [60, 30, 15]
const TOO_LARGE = /exceeds maximum allowed tokens/i
// The most sessions the app's move_sessions takes in one call.
const MOVE_LIMIT = 100
const TOOL = 'mcp__env-tabs__tabs'

const HELP = [
  'Usage: /env-tabs [list | pin [folder] | unpin <n> | move <n> <to> | rename <n> <label> | sync | status]',
  "  pin     pins this session's folder (or the folder given): a tab, and a sidebar section",
  '  unpin   removes tab <n> (or the tab with that label) and its sidebar section',
  '  move    moves tab <n> to position <to>',
  '  rename  sets the label of tab <n> and the name of its section',
  "  sync    files each pinned folder's sessions under its sidebar section again",
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

const isWithin = (folder: string, parent: string) => {
  const child = normalize(folder)
  const root = normalize(parent)
  const separator = isWindowsPath(parent) ? '\\' : '/'

  return child === root || child.startsWith(root + separator)
}

const baseName = (path: string) =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** The pin a folder belongs to: the deepest pinned folder that holds it. */
const pinOf = (folder: string, list: readonly Pin[]) =>
  list
    .filter(pin => isWithin(folder, pin.folder))
    .sort((a, b) => normalize(b.folder).length - normalize(a.folder).length)[0]

// State and store. Each write skips a value that has not changed, so the band
// redraws only on news.

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

const setHere = async ($: EngineInterface, folder: string) => {
  if ((await read($, here)) !== folder) {
    await update($, here, () => folder)
  }
}

const toPins = (value: unknown): Pin[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(item => {
    const pin = item as Partial<Pin> | null

    return typeof pin?.folder === 'string' && typeof pin.label === 'string'
      ? [
          {
            folder: pin.folder,
            label: pin.label,
            sectionId: typeof pin.sectionId === 'string' ? pin.sectionId : null,
          },
        ]
      : []
  })
}

const loadPins = async ($: EngineInterface) => toPins(await $.store.get(STORE_KEY))

const savePins = async ($: EngineInterface, list: Pin[]) => {
  await $.store.set(STORE_KEY, list)
  await setPins($, list)
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
  group?: unknown
  pinned?: boolean
}

const toRows = (text: string): SessionRow[] => {
  const parsed = parseJson(text)
  if (!Array.isArray(parsed)) {
    throw new Error(`list_sessions answered: ${text.slice(0, 200)}`)
  }

  return parsed.flatMap(item => {
    const row = item as ListedSession

    return typeof row.sessionId === 'string' && typeof row.cwd === 'string'
      ? [
          {
            id: row.sessionId,
            title: row.title ?? '',
            folder: row.cwd,
            link: row.link ?? null,
            isRunning: row.isRunning === true,
            lastActivityAt: row.lastActivityAt ?? '',
            // An absent key means the app has not said yet: not ungrouped.
            isUngrouped: row.group === null,
            isPinned: row.pinned === true,
          },
        ]
      : []
  })
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

const refresh = async ($: EngineInterface) => {
  await setPins($, await loadPins($))
  await setHere($, await $.session.root())
  const at = await $.clock.now()

  try {
    await setSessions($, await listSessions($))
    await update($, probe, () => ({ ok: true, error: null, at }))
  } catch (error) {
    await update($, probe, () => ({ ok: false, error: String(error), at }))
  }
}

// The sidebar: one section per pin, above the app's own list of folders.

type ListedSection = { id?: string; kind?: string; name?: string }

/** The person's section with this name, made when there is none. */
const sectionFor = async ($: EngineInterface, name: string) => {
  const listed = parseJson(await callApp($, 'ccd_sidebar', 'list_sections', {}))
  const existing = (Array.isArray(listed) ? (listed as ListedSection[]) : []).find(
    section => section.kind === 'manual' && section.name === name,
  )
  if (typeof existing?.id === 'string') {
    return existing.id
  }

  const created = parseJson(
    await callApp($, 'ccd_sidebar', 'create_section', { name }),
  ) as ListedSection | undefined
  if (typeof created?.id !== 'string') {
    throw new Error('the app made no section')
  }

  return created.id
}

/**
 * Files sessions under a section. Under auto mode the app's classifier may
 * give no verdict on a mod's call; the app asks for one more try then.
 */
const moveSessions = async ($: EngineInterface, ids: string[], sectionId: string) => {
  const args = { session_ids: ids, section_id: sectionId }
  try {
    await callApp($, 'ccd_sidebar', 'move_sessions', args)
  } catch (error) {
    if (!/gave no verdict/i.test(String(error))) {
      throw error
    }
    await callApp($, 'ccd_sidebar', 'move_sessions', args)
  }
}

type SelfInfo = { group?: unknown; pinned?: boolean }

/** Files this session under its folder's section, unless the person filed or pinned it already. */
const fileSelf = async ($: EngineInterface) => {
  const pin = pinOf(await read($, here), await read($, pins))
  if (pin?.sectionId == null) {
    return false
  }

  const info = parseJson(
    await callApp($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' }),
  ) as SelfInfo | undefined
  if (info === undefined || info.group !== null || info.pinned === true) {
    return false
  }

  await moveSessions($, ['self'], pin.sectionId)

  return true
}

/** Gives a pin its sidebar section and files its folder's loose sessions there. */
const syncSection = async ($: EngineInterface, folder: string) => {
  try {
    await refresh($)
    const list = await loadPins($)
    const pin = list.find(one => normalize(one.folder) === normalize(folder))
    if (pin === undefined) {
      return ''
    }

    const sectionId = await sectionFor($, pin.label)
    const withSection = list.map(one => (one === pin ? { ...one, sectionId } : one))
    await savePins($, withSection)

    // Sessions the person filed elsewhere or pinned stay where they are.
    const ids = (await read($, sessions))
      .filter(
        row =>
          row.isUngrouped &&
          !row.isPinned &&
          pinOf(row.folder, withSection)?.folder === pin.folder,
      )
      .map(row => row.id)
      .slice(0, MOVE_LIMIT)
    let filed = 0
    let unfiled = ''
    if (ids.length > 0) {
      try {
        await moveSessions($, ids, sectionId)
        filed += ids.length
      } catch (error) {
        // Moving other sessions needs the person's approval, which the app
        // cannot always get for a mod: say how to finish it instead.
        unfiled =
          ` ${ids.length} session${ids.length === 1 ? ' was' : 's were'} not filed, as the app did not approve the move` +
          ` (${String(error).slice(0, 120)}). Drag them into the section, or have Claude call` +
          ` mcp__ccd_sidebar__move_sessions with section_id "${sectionId}" and session_ids ${JSON.stringify(ids)}.`
      }
    }
    try {
      filed += (await fileSelf($)) ? 1 : 0
    } catch {
      // This session stays where it is; the next one in the folder files itself.
    }

    return ` Sidebar section "${pin.label}" is ready${filed > 0 ? `, ${filed} session${filed === 1 ? '' : 's'} filed` : ''}.${unfiled}`
  } catch (error) {
    return ` The sidebar was not changed: ${String(error).slice(0, 300)}`
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
  if (latest?.link == null) {
    $.ui.toast(`No session in ${target.label} yet: start one there with New session.`)
    return
  }
  if (!(await openLink($, latest.link))) {
    $.ui.toast(`Could not open "${latest.title}".`)
  }
}

// Changing the pins: the command, the model's tool and the band share these.

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
  const list = await loadPins($)
  const existing = list.find(pin => normalize(pin.folder) === normalize(folder))
  if (existing !== undefined) {
    return `${existing.label} is pinned already.`
  }

  const added = { folder, label: label?.trim() || baseName(folder), sectionId: null }
  await savePins($, [...list, added])

  return `Pinned ${added.label} (${folder}).${await syncSection($, folder)}`
}

const unpinTab = async ($: EngineInterface, key: string) => {
  const list = await loadPins($)
  const index = indexOf(list, key)
  if (index < 0) {
    return `No tab matches "${key}".`
  }

  const [removed] = list.splice(index, 1)
  await savePins($, list)
  if (removed.sectionId === null) {
    return `Unpinned ${removed.label}.`
  }

  try {
    await callApp($, 'ccd_sidebar', 'delete_section', { section_id: removed.sectionId })
    return `Unpinned ${removed.label}; its sessions are back in the sidebar's list.`
  } catch (error) {
    return `Unpinned ${removed.label}; its sidebar section stays: ${String(error).slice(0, 200)}`
  }
}

const moveTab = async ($: EngineInterface, key: string, to: number) => {
  const list = await loadPins($)
  const index = indexOf(list, key)
  if (index < 0) {
    return `No tab matches "${key}".`
  }

  const [moved] = list.splice(index, 1)
  const target = Math.min(Math.max(to, 1), list.length + 1) - 1
  list.splice(target, 0, moved)
  await savePins($, list)

  return `Moved ${moved.label} to position ${target + 1}.`
}

const renameTab = async ($: EngineInterface, key: string, label: string) => {
  const list = await loadPins($)
  const index = indexOf(list, key)
  if (index < 0) {
    return `No tab matches "${key}".`
  }

  const old = list[index]
  const name = label.trim()
  list[index] = { ...old, label: name }
  await savePins($, list)
  if (old.sectionId === null) {
    return `Renamed ${old.label} to ${name}.`
  }

  try {
    await callApp($, 'ccd_sidebar', 'rename_section', { section_id: old.sectionId, name })
    return `Renamed ${old.label} to ${name}, its sidebar section too.`
  } catch (error) {
    return `Renamed the tab ${old.label} to ${name}; its section kept its name: ${String(error).slice(0, 200)}`
  }
}

const syncAll = async ($: EngineInterface) => {
  const list = await loadPins($)
  if (list.length === 0) {
    return 'No pinned folders yet.'
  }

  const lines: string[] = []
  for (const pin of list) {
    lines.push(`${pin.label}:${await syncSection($, pin.folder)}`)
  }

  return lines.join('\n')
}

const describe = (list: readonly Pin[], rows: readonly SessionRow[]) => {
  if (list.length === 0) {
    return 'No pinned folders yet. Run /env-tabs pin in a session to pin its folder.'
  }

  return list
    .map((pin, index) => {
      const count = rows.filter(row => pinOf(row.folder, list)?.folder === pin.folder).length
      const section = pin.sectionId === null ? 'no sidebar section' : 'sidebar section'
      return `${index + 1}. ${pin.label}  (${pin.folder}; ${count} other session${count === 1 ? '' : 's'}; ${section})`
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
      return pinFolder($, tail || (await $.session.root()))
    case 'unpin':
      return tail ? unpinTab($, tail) : HELP
    case 'move': {
      const match = /^(.*\S)\s+(\d+)$/.exec(tail)
      return match ? moveTab($, match[1], Number(match[2])) : HELP
    }
    case 'rename': {
      const match = /^(\d+)\s+(.*\S)$/.exec(tail)
      return match ? renameTab($, match[1], match[2]) : HELP
    }
    case 'sync':
      return syncAll($)
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
      return pinFolder($, input.folder?.trim() || (await $.session.root()), input.label)
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
    case 'sync':
      return syncAll($)
    default:
      return status($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'env-tabs',
      description: 'Pinned folders as tabs above the prompt and sections in the sidebar',
      argumentHint: '[list|pin|unpin|move|rename|sync|status]',
    })
    await $.tool.register({
      name: 'tabs',
      description:
        "Reads and changes env-tabs: pinned folders, each drawn as a tab above the prompt in Claude Desktop's Code tab " +
        'and kept as a section at the top of its sidebar. action "status" lists the pins and what they see; ' +
        '"pin" pins a folder (this session\'s when none is given) and files its sessions under its section; ' +
        '"unpin", "move" and "rename" take a tab by its 1-based number or its label; ' +
        '"sync" files each pinned folder\'s loose sessions under its section again.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'pin', 'unpin', 'move', 'rename', 'sync'],
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
    // A new session in a pinned folder files itself under that folder's section.
    void refresh($)
      .then(() => fileSelf($))
      .catch(() => false)
    $.clock.every(REFRESH_MS, () => refresh($))

    return started
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

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {list.map(pin => {
          const key = `tab:${normalize(pin.folder)}`
          const variant = current?.folder === pin.folder ? 'primary' : 'secondary'
          const isBusy = rows.some(
            row => row.isRunning && pinOf(row.folder, list)?.folder === pin.folder,
          )

          return isBusy ? (
            <Button key={key} variant={variant} onPress={() => goTo($, pin)}>
              {pin.label}
              <Text dimColor> ●</Text>
            </Button>
          ) : (
            <Button key={key} variant={variant} label={pin.label} onPress={() => goTo($, pin)} />
          )
        })}
        {current === undefined && (
          <Button
            key="pin-here"
            plain
            label="+ Pin this folder"
            onPress={async () => $.ui.toast(await pinFolder($, folder))}
          />
        )}
      </Box>
    )
  })
}
