import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'env-tabs'
const TOOL = 'mcp__env-tabs__tabs'
const PANE = 'projects'
const HERE = 'C:\\work\\scratch'
const NOW = Date.parse('2026-10-16T12:00:00Z')
// Where the app makes a folder of its own for a session started without one.
const SCRATCH_ROOT = 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\account\\org'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}
const PANE_PROPS = {
  title: 'Projects',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

/** A session as the desktop app's list_sessions answers it. */
const session = (id: string, cwd: string, lastActivityAt: string, extra: object = {}) => ({
  sessionId: id,
  title: id,
  cwd,
  lastActivityAt,
  isRunning: false,
  group: null,
  link: `claude://claude.ai/epitaxy/${id}`,
  ...extra,
})

const answer = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError,
})

type AppCall = { server: string; tool: string; args: Record<string, unknown> }

type World = {
  rows?: object[]
  self?: object
  root?: string
  os?: string
  opens?: boolean
  files?: Record<string, object>
}

const USER = 'C:\\Users\\me'
// Each running session's own file, and the desktop's record of each session.
const LIVE = `${USER}\\.claude\\sessions`
const RECORDS = `${USER}\\AppData\\Roaming\\Claude\\claude-code-sessions`

/**
 * JSON files by absolute path, as `$.fs` finds them: `put` writes one, and a
 * file written again reads as changed.
 */
const fileSystem = (on: On, files: Record<string, object>) => {
  const norm = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const held = new Map<string, { path: string; text: string; version: number }>()
  let version = 1
  const put = (path: string, value: object) => {
    version += 1
    held.set(norm(path), { path, text: JSON.stringify(value), version })
  }
  for (const [path, value] of Object.entries(files)) {
    put(path, value)
  }
  const isDir = (path: string) => [...held.keys()].some(key => key.startsWith(`${norm(path)}\\`))

  // A missing file reads empty and a missing folder lists nothing: a hook that
  // threw would let the call through to this computer's own disk.
  on('fs.exists', ($, e) => ({ value: held.has(norm(e.path)) || isDir(e.path) }))
  on('fs.read', ($, e) => ({ value: held.get(norm(e.path))?.text ?? '' }))
  on('fs.list', ($, e) => {
    const dir = `${norm(e.path)}\\`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [key, file] of held) {
      if (!key.startsWith(dir)) {
        continue
      }
      const depth = key.slice(dir.length).split('\\').length
      const name = file.path.replace(/\//g, '\\').split('\\').slice(-depth)[0] ?? ''
      entries.set(name.toLowerCase(), {
        name,
        kind: depth > 1 ? 'dir' : 'file',
        size: depth > 1 ? 0 : file.text.length,
        mtimeMs: depth > 1 ? 0 : file.version,
        isLink: false,
      })
    }
    return { value: [...entries.values()] }
  })

  return put
}

/** Everything beneath the plugin: the app's tools, the store, the clock, the OS, the files. */
const world = (
  on: On,
  { rows = [], self, root = HERE, os = 'Windows_NT', opens = true, files = {} }: World = {},
) => {
  const calls: AppCall[] = []
  const opened: string[][] = []
  const panes: string[] = []
  const toasts: string[] = []

  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  mock.env(
    on,
    os === '' ? { HOME: '/Users/me' } : { OS: os, USERPROFILE: USER, APPDATA: `${USER}\\AppData\\Roaming` },
  )
  const put = fileSystem(on, files)
  // What a session's start meets beneath the plugin, for a test that raises one.
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('session.root', () => ({ value: root }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('process.run', ($, e) => {
    opened.push([...e.argv])
    return {
      value: {
        exitCode: opens ? 0 : 1,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  const app = (call: AppCall) => {
    switch (`${call.server}.${call.tool}`) {
      case 'ccd_session_mgmt.list_sessions':
        return answer(rows)
      case 'ccd_session_mgmt.get_session':
        return answer(self ?? { group: null, pinned: false })
      default:
        return answer('ok')
    }
  }
  on('mcp.call', ($, e) => {
    const call = { server: e.server, tool: e.tool, args: e.args }
    calls.push(call)
    return { value: app(call) }
  })

  return {
    calls,
    opened,
    panes,
    toasts,
    clock,
    put,
    sidebar: () => calls.filter(call => call.server === 'ccd_sidebar'),
  }
}

/** A running session's own file: what it is doing, since when. */
const live = (pid: number, host: string, status: string, at: number) => ({
  [`${LIVE}\\${pid}.json`]: { pid, hostSessionId: host, status, statusUpdatedAt: at, updatedAt: at },
})

/** The desktop's record of a session: when the person last looked at it, when it last did something. */
const record = (id: string, focusedAt: number, activityAt: number) => ({
  [`${RECORDS}\\account\\org\\${id}.json`]: {
    sessionId: id,
    lastFocusedAt: focusedAt,
    lastActivityAt: activityAt,
    isArchived: false,
  },
})

type Drawn = { type?: string; props?: { key?: string }; press?: { handle?: number }; children?: unknown[] }

/**
 * The handle each Button of a drawing carries, by its key: what a click on it
 * names. A click the surface sends from a drawing it still shows lands only
 * while the engine holds that handle.
 */
const handlesOf = (node: unknown, into: Record<string, number> = {}) => {
  if (typeof node !== 'object' || node === null) {
    return into
  }
  const { type, props, press, children } = node as Drawn
  if (type === 'Button' && props?.key !== undefined && press?.handle !== undefined) {
    into[props.key] = press.handle
  }
  for (const child of children ?? []) {
    handlesOf(child, into)
  }

  return into
}

/** A node of a drawn tree: its hover styles ride beside its props. */
type Node = {
  type?: string
  props?: Record<string, unknown>
  hover?: Record<string, unknown>
  children?: unknown[]
}

/** The first node of a drawing, the node itself included, that `is` picks. */
const nodeIn = (node: unknown, is: (one: Node) => boolean): Node | undefined => {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  const one = node as Node
  if (is(one)) {
    return one
  }
  for (const child of one.children ?? []) {
    const found = nodeIn(child, is)
    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

const keyed = (key: string) => (one: Node) => one.props?.key === key

const pin = ($: Engine, folder?: string) =>
  $.tool.call({ tool: TOOL, action: 'pin', ...(folder === undefined ? {} : { folder }) })

const statusOf = async ($: Engine) =>
  String((await $.tool.call({ tool: TOOL, action: 'status' })).result)

const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })

/** A drawing's box that is shown only while the pointer is over its row. */
const hidden = (one: Node) => one.props?.display === 'none'

describe('pinning', () => {
  test('pins a folder and leaves the sidebar alone', async ($, on) => {
    const { sidebar } = world(on, {
      rows: [
        session('a', 'D:\\Projects\\shop', '2026-10-16T10:00:00Z'),
        session('b', 'd:/projects/shop/', '2026-10-16T09:00:00Z'),
      ],
    })

    const pinned = await pin($, 'D:\\Projects\\shop')

    expect(String(pinned.result)).toContain('Pinned shop')
    expect(await statusOf($)).toContain('1. shop  (D:\\Projects\\shop; 2 other sessions)')
    expect(sidebar()).toEqual([])
  })

  test('a project inside a pinned folder keeps its own sessions, as in the sidebar', async ($, on) => {
    world(on, {
      rows: [
        session('a', 'D:\\Beelink\\VsCodes', '2026-10-16T10:00:00Z'),
        session('b', 'D:\\Beelink\\VsCodes\\claude-env-tabs', '2026-10-16T09:00:00Z'),
      ],
    })

    await pin($, 'D:\\Beelink\\VsCodes')

    expect(await statusOf($)).toContain('1. VsCodes  (D:\\Beelink\\VsCodes; 1 other session)')
  })

  test("pins this session's repository when the session runs in one of its worktrees", async ($, on) => {
    world(on, { root: 'D:\\Projects\\shop\\.claude\\worktrees\\brave-fox' })

    await pin($)

    expect(await statusOf($)).toContain('1. shop  (D:\\Projects\\shop;')
  })

  test('does not pin the folder of a scratch session', async ($, on) => {
    world(on, { root: `${SCRATCH_ROOT}\\scratch-2026-10-16-1a2b3c` })

    const pinned = await pin($)

    expect(String(pinned.result)).toContain('scratch')
    expect(await statusOf($)).toContain('No pinned folders yet')
  })
})

describe('changing the tabs', () => {
  test('unpinning removes the tab and leaves the sidebar alone', async ($, on) => {
    const { sidebar } = world(on)
    await pin($, 'D:\\Projects\\shop')

    const unpinned = await $.tool.call({ tool: TOOL, action: 'unpin', tab: '1' })

    expect(String(unpinned.result)).toContain('Unpinned shop')
    expect(await statusOf($)).toContain('No pinned folders yet')
    expect(sidebar()).toEqual([])
  })

  test('move and rename change the order and the labels', async ($, on) => {
    world(on)
    await pin($, 'D:\\A')
    await pin($, 'D:\\B')

    await $.tool.call({ tool: TOOL, action: 'move', tab: 'B', position: 1 })
    await $.tool.call({ tool: TOOL, action: 'rename', tab: '1', label: 'Bee' })

    expect(await statusOf($)).toMatch(/1\. Bee[\s\S]*2\. A/)
  })
})

describe('the band', () => {
  for (const surface of SURFACES) {
    test(`draws a tab per pin and offers to pin this folder (${surface})`, async ($, on) => {
      world(on)
      await pin($, 'D:\\Projects\\shop')

      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

      expect(await band.find({ type: 'Button', text: 'shop' })).toBeDefined()
      expect(await band.find({ key: 'pin-here' })).toBeDefined()
    })

    test(`opens the Projects pane (${surface})`, async ($, on) => {
      const { panes } = world(on)
      await pin($, 'D:\\Projects\\shop')
      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      const before = panes.length

      await band.press({ key: 'projects' })

      expect(panes.slice(before)).toEqual([PANE])
    })

    test(`a redraw keeps the handles of its buttons (${surface})`, async ($, on) => {
      world(on)
      await pin($, 'D:\\Projects\\shop')
      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })
      const before = handlesOf(await band.drawn())

      await band.redraw({ ...BAND, isWorking: true })

      expect(Object.keys(before)).toEqual(['tab:d:\\projects\\shop', 'pin-here', 'projects'])
      expect(handlesOf(await band.drawn())).toEqual(before)
    })
  }

  for (const [os, opener] of [
    ['Windows_NT', ['rundll32', 'url.dll,FileProtocolHandler']],
    ['', ['open']],
  ] as const) {
    test(`a tab opens the latest session of its folder (${os || 'macOS'})`, async ($, on) => {
      const { opened } = world(on, {
        os,
        rows: [
          session('old', 'D:\\Projects\\shop', '2026-10-15T10:00:00Z'),
          session('new', 'D:\\Projects\\shop', '2026-10-16T10:00:00Z'),
        ],
      })
      await pin($, 'D:\\Projects\\shop')
      const band = await $.ui.mount({
        plugin: PLUGIN,
        surface: 'desktop',
        component: 'AbovePrompt',
        props: BAND,
      })

      await band.press({ key: 'tab:d:\\projects\\shop' })

      expect(opened).toEqual([[...opener, 'claude://claude.ai/epitaxy/new']])
    })
  }

  test('a tab of a project with no session yet starts one in its folder', async ($, on) => {
    const { opened } = world(on)
    await pin($, 'D:\\Projects\\shop')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })

    await band.press({ key: 'tab:d:\\projects\\shop' })

    expect(opened).toEqual([
      ['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/new?folder=D%3A%5CProjects%5Cshop'],
    ])
  })

  test('a tab opens the latest session of its own folder, not of a project inside it', async ($, on) => {
    const { opened } = world(on, {
      rows: [
        session('inside', 'D:\\Projects\\shop\\addons', '2026-10-16T11:00:00Z'),
        session('own', 'D:\\Projects\\shop', '2026-10-16T10:00:00Z'),
      ],
    })
    await pin($, 'D:\\Projects\\shop')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })

    await band.press({ key: 'tab:d:\\projects\\shop' })

    expect(opened).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'claude://claude.ai/epitaxy/own']])
  })

  test('in a project inside a pinned folder, offers to pin that project', async ($, on) => {
    world(on, { root: 'D:\\Projects\\shop\\addons' })
    await pin($, 'D:\\Projects\\shop')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })

    expect((await band.find({ key: 'tabrow:d:\\projects\\shop' }))?.props.backgroundColor).toBe('transparent')
    await band.press({ key: 'pin-here' })

    expect(await statusOf($)).toContain('2. addons  (D:\\Projects\\shop\\addons;')
  })

  test('marks each tab with its icon and fills the tab of this project', async ($, on) => {
    world(on, { root: 'D:\\Projects\\shop' })
    await pin($, 'D:\\Projects\\shop')
    await pin($, 'D:\\Other')
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })

    expect((await band.findAll({ type: 'Svg' })).map(svg => svg.props.alt)).toEqual(['shop', 'Other'])
    expect((await band.find({ key: 'tabrow:d:\\projects\\shop' }))?.props.backgroundColor).toBe(
      'userMessageBackground',
    )
    expect((await band.find({ key: 'tabrow:d:\\other' }))?.props.backgroundColor).toBe('transparent')
  })

  test('offers no pin in a scratch session', async ($, on) => {
    world(on, { root: `${SCRATCH_ROOT}\\scratch-2026-10-16-1a2b3c` })
    await pin($, 'D:\\Projects\\shop')

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })

    expect(await band.find({ key: 'tab:d:\\projects\\shop' })).toBeDefined()
    expect(await band.find({ key: 'pin-here' })).toBeUndefined()
  })
})

describe('the Projects pane', () => {
  const ROWS = [
    session('a', 'D:\\Projects\\shop', '2026-10-16T11:30:00Z', { isRunning: true }),
    session('s', `${SCRATCH_ROOT}\\scratch-2026-10-16-1a2b3c`, '2026-10-16T11:20:00Z'),
    session('e', 'D:\\Other', '2026-10-16T11:00:00Z'),
    session('b', 'd:/projects/shop', '2026-10-16T10:00:00Z'),
    session('c', 'D:\\Projects\\shop\\addons', '2026-10-16T09:00:00Z'),
    session('t', `${SCRATCH_ROOT}\\scratch-2026-10-15-4d5e6f`, '2026-10-15T09:00:00Z'),
    session('f', 'D:\\Other\\.claude\\worktrees\\calm-owl', '2026-10-14T11:00:00Z'),
  ]
  const SELF = session('me', 'D:\\Projects\\shop', '2026-10-16T12:00:00Z')

  for (const surface of SURFACES) {
    test(`lists the pinned projects first, then the rest (${surface})`, async ($, on) => {
      world(on, { rows: ROWS, self: SELF })
      await pin($, 'D:\\Projects\\shop')

      const pane = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        requestId: PANE,
        props: PANE_PROPS,
      })

      const folds = (await pane.findAll({ type: 'Button' }))
        .map(button => button.key ?? '')
        .filter(key => key.startsWith('fold:'))
      // A project inside a pinned one is listed apart, as the sidebar lists it,
      // and the scratch sessions come last.
      expect(folds).toEqual([
        'fold:d:\\projects\\shop',
        'fold:d:\\other',
        'fold:d:\\projects\\shop\\addons',
        'fold:scratch',
      ])
      expect(await pane.find({ key: 'unpin:d:\\projects\\shop' })).toBeDefined()
      expect(await pane.find({ key: 'pin:d:\\other' })).toBeDefined()
      expect(await pane.find({ key: 'new:d:\\projects\\shop' })).toBeDefined()
      expect(await pane.find({ key: 'new:d:\\other' })).toBeDefined()
      // A pinned project starts open, this session in it; any other starts closed.
      expect((await pane.find({ key: 'srow:me' }))?.text).toContain('here')
      // The age sits at the end of the row, outside the session's button.
      expect((await pane.find({ key: 'srow:b' }))?.text).toContain('2h')
      expect((await pane.find({ key: 'session:b' }))?.text).toBe('b')
      expect(await pane.find({ key: 'session:c' })).toBeUndefined()
      expect(await pane.find({ key: 'session:e' })).toBeUndefined()
    })

    test(`opens a project, and pins it (${surface})`, async ($, on) => {
      world(on, { rows: ROWS })
      await pin($, 'D:\\Projects\\shop')
      const pane = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        requestId: PANE,
        props: PANE_PROPS,
      })

      await pane.press({ key: 'fold:d:\\other' })
      // A worktree's session is listed under its repository.
      expect(await pane.find({ key: 'session:e' })).toBeDefined()
      expect(await pane.find({ key: 'session:f' })).toBeDefined()

      await pane.press({ key: 'pin:d:\\other' })
      expect(await pane.find({ key: 'unpin:d:\\other' })).toBeDefined()
      expect(await statusOf($)).toMatch(/1\. shop[\s\S]*2\. Other  \(D:\\Other;/)
    })

    // A click on a pane that does not hold the keyboard gives it the keyboard,
    // and the surface draws it again: the click must still land.
    test(`a redraw keeps the handles of the buttons it did not change (${surface})`, async ($, on) => {
      const { opened } = world(on, { rows: ROWS, self: SELF })
      await pin($, 'D:\\Projects\\shop')
      const pane = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'Pane',
        requestId: PANE,
        props: PANE_PROPS,
      })
      const before = handlesOf(await pane.drawn())

      await pane.redraw({ ...PANE_PROPS, isFocused: true })
      expect(handlesOf(await pane.drawn())).toEqual(before)

      // The session list read again, every minute, draws the pane again too.
      await statusOf($)
      expect(handlesOf(await pane.drawn())).toEqual(before)
      expect(before['new:d:\\projects\\shop']).toBeDefined()
      expect(before['session:b']).toBeDefined()

      await pane.press({ key: 'new:d:\\projects\\shop' })
      expect(opened).toEqual([
        ['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/new?folder=D%3A%5CProjects%5Cshop'],
      ])
    })
  }

  test('gathers the scratch sessions into one This computer row, with no + New or Pin', async ($, on) => {
    world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
    })

    expect((await pane.find({ key: 'fold:scratch' }))?.text).toContain('This computer')
    expect(await pane.find({ key: 'new:scratch' })).toBeUndefined()
    expect(await pane.find({ key: 'pin:scratch' })).toBeUndefined()

    await pane.press({ key: 'fold:scratch' })

    expect((await pane.find({ key: 'srow:s' }))?.text).toContain('40m')
    expect(await pane.find({ key: 'session:t' })).toBeDefined()
  })

  test('marks each project with its icon, and This computer with a computer', async ($, on) => {
    world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const drawn = await (await mountPane($, 'desktop')).drawn()

    const icons = ['d:\\projects\\shop', 'd:\\other', 'd:\\projects\\shop\\addons', 'scratch'].map(
      key => nodeIn(nodeIn(drawn, keyed(`row:${key}`)), one => one.type === 'Svg')?.props?.alt,
    )

    expect(icons).toEqual(['shop', 'Other', 'addons', 'This computer'])
  })

  test('draws each icon as a letter in a colored cell on the terminal', async ($, on) => {
    world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'terminal')

    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    expect((await pane.find({ type: 'Text', text: /^ S $/ }))?.props.backgroundColor).toBeDefined()
  })

  test("shows + New and Pin while the pointer is over a project's row", async ($, on) => {
    world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'desktop')

    const actions = nodeIn(nodeIn(await pane.drawn(), keyed('row:d:\\other')), hidden)

    expect(actions?.hover).toEqual({ display: 'flex' })
    expect(nodeIn(actions, keyed('new:d:\\other'))).toBeDefined()
    expect(nodeIn(actions, keyed('pin:d:\\other'))).toBeDefined()
  })

  test('keeps + New and Pin in view on the terminal, where nothing hovers', async ($, on) => {
    world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'terminal')

    expect(nodeIn(await pane.find({ key: 'row:d:\\other' }), hidden)).toBeUndefined()
    expect(await pane.find({ key: 'new:d:\\other' })).toBeDefined()
  })

  test("fills the row of this session's project, and lights another under the pointer", async ($, on) => {
    world(on, { rows: ROWS, root: 'D:\\Projects\\shop' })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'desktop')

    const drawn = await pane.drawn()
    const here = nodeIn(drawn, keyed('row:d:\\projects\\shop'))
    const other = nodeIn(drawn, keyed('row:d:\\other'))

    expect(here?.props?.backgroundColor).toBe('userMessageBackground')
    expect(other?.props?.backgroundColor).toBe('transparent')
    expect(other?.hover?.backgroundColor).toBeDefined()
  })

  test("+ New names the project's current label once it is renamed", async ($, on) => {
    const { toasts } = world(on, { rows: ROWS, opens: false })
    await pin($, 'D:\\Projects\\shop')
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
    })

    await $.tool.call({ tool: TOOL, action: 'rename', tab: '1', label: 'Shop' })
    await pane.press({ key: 'new:d:\\projects\\shop' })

    expect(toasts).toEqual(['Could not start a session in Shop.'])
  })

  test('a session row opens its session', async ($, on) => {
    const { opened } = world(on, { rows: ROWS })
    await pin($, 'D:\\Projects\\shop')
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
    })

    await pane.press({ key: 'session:b' })

    expect(opened).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'claude://claude.ai/epitaxy/b']])
  })

  test("+ New starts a session in the project's folder", async ($, on) => {
    const { opened } = world(on, { rows: ROWS })
    await $.tool.call({ tool: TOOL, action: 'status' })
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
    })

    await pane.press({ key: 'new:d:\\other' })

    expect(opened).toEqual([
      ['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/new?folder=D%3A%5COther'],
    ])
  })

  test('says so when there is nothing pinned yet', async ($, on) => {
    world(on, { rows: ROWS })
    await $.tool.call({ tool: TOOL, action: 'status' })

    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'desktop',
      component: 'Pane',
      requestId: PANE,
      props: PANE_PROPS,
    })

    expect(await pane.find({ type: 'Text', text: /Pin a project/ })).toBeDefined()
    expect(await pane.find({ key: 'pin:d:\\projects\\shop' })).toBeDefined()
  })
})

describe('session states', () => {
  const AT = NOW - 3_600_000
  const ROWS = [
    session('local_w', 'D:\\Projects\\shop', '2026-10-16T11:50:00Z'),
    session('local_u', 'D:\\Projects\\shop', '2026-10-16T11:40:00Z'),
    session('local_r', 'D:\\Projects\\shop', '2026-10-16T11:30:00Z'),
    session('local_i', 'D:\\Projects\\shop', '2026-10-16T11:20:00Z'),
    session('local_o', 'D:\\Other', '2026-10-16T11:10:00Z'),
  ]
  const FILES = {
    ...live(1, 'local_w', 'waiting', AT),
    ...live(2, 'local_r', 'busy', AT),
    ...live(3, 'local_o', 'busy', AT),
    ...record('local_w', AT - 10_000, AT),
    // It finished after the person last looked at it; its process has ended.
    ...record('local_u', AT - 60_000, AT),
    ...record('local_i', AT, AT - 60_000),
  }

  /** The alt of the first Svg under the node keyed `key` whose alt `pick` takes. */
  const altIn = (drawn: unknown, key: string, pick: (alt: string) => boolean = () => true) =>
    nodeIn(nodeIn(drawn, keyed(key)), one => one.type === 'Svg' && pick(String(one.props?.alt)))?.props
      ?.alt

  test('marks each session with its state, as the sidebar dots do', async ($, on) => {
    world(on, { rows: ROWS, files: FILES })
    await pin($, 'D:\\Projects\\shop')
    const drawn = await (await mountPane($, 'desktop')).drawn()

    expect(['local_w', 'local_u', 'local_r', 'local_i'].map(id => altIn(drawn, `srow:${id}`))).toEqual([
      'Waiting for you',
      'Unread',
      'Running',
      'Idle',
    ])
  })

  test('counts the sessions that need you on the project row and its tab', async ($, on) => {
    world(on, { rows: ROWS, files: FILES })
    await pin($, 'D:\\Projects\\shop')
    const pane = await (await mountPane($, 'desktop')).drawn()
    const band = await (
      await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: BAND })
    ).drawn()
    const needs = (alt: string) => /need/.test(alt)

    expect(altIn(pane, 'row:d:\\projects\\shop', needs)).toBe('2 need you')
    expect(altIn(band, 'tabrow:d:\\projects\\shop', needs)).toBe('2 need you')
    // A project with a session running and none waiting shows that it runs.
    expect(altIn(pane, 'row:d:\\other', alt => alt === 'Running')).toBe('Running')
  })

  test('never marks this session unread: it is in view', async ($, on) => {
    world(on, {
      rows: ROWS,
      self: session('local_me', 'D:\\Projects\\shop', '2026-10-16T12:00:00Z'),
      files: { ...FILES, ...record('local_me', AT - 60_000, AT) },
    })
    await pin($, 'D:\\Projects\\shop')

    const drawn = await (await mountPane($, 'desktop')).drawn()

    expect(altIn(drawn, 'srow:local_me')).toBe('Idle')
  })

  test('draws a change of state within seconds', async ($, on) => {
    const { clock, put } = world(on, {
      rows: ROWS,
      files: { ...FILES, ...live(1, 'local_w', 'idle', AT), ...record('local_w', AT, AT - 60_000) },
    })
    // The session's start sets the reads going, on the test's clock.
    await $.session.start({ cwd: HERE, surface: 'desktop', isInteractive: true })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'desktop')
    expect(altIn(await pane.drawn(), 'srow:local_w')).toBe('Idle')

    put(`${LIVE}\\1.json`, { pid: 1, hostSessionId: 'local_w', status: 'waiting', statusUpdatedAt: NOW, updatedAt: NOW })
    await clock.advance(5_000)

    expect(altIn(await pane.drawn(), 'srow:local_w')).toBe('Waiting for you')
  })

  test('colors the dots on the terminal', async ($, on) => {
    world(on, { rows: ROWS, files: FILES })
    await pin($, 'D:\\Projects\\shop')
    const pane = await mountPane($, 'terminal')

    const dot = nodeIn(await pane.find({ key: 'srow:local_w' }), one => one.type === 'Text')

    expect(dot?.props?.color).toBe('warning')
    expect(dot?.children).toEqual(['●'])
  })

  test('status says where the states are read from', async ($, on) => {
    world(on, { rows: ROWS, files: FILES })

    expect(await statusOf($)).toContain(`Session states: read from ${RECORDS} and ${LIVE}`)
  })
})
