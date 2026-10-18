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

type World = { rows?: object[]; self?: object; root?: string; os?: string; opens?: boolean }

/** Everything beneath the plugin: the app's tools, the store, the clock, the OS. */
const world = (
  on: On,
  { rows = [], self, root = HERE, os = 'Windows_NT', opens = true }: World = {},
) => {
  const calls: AppCall[] = []
  const opened: string[][] = []
  const panes: string[] = []
  const toasts: string[] = []

  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, os === '' ? {} : { OS: os })
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
    sidebar: () => calls.filter(call => call.server === 'ccd_sidebar'),
  }
}

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

const pin = ($: Engine, folder?: string) =>
  $.tool.call({ tool: TOOL, action: 'pin', ...(folder === undefined ? {} : { folder }) })

const statusOf = async ($: Engine) =>
  String((await $.tool.call({ tool: TOOL, action: 'status' })).result)

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

    expect((await band.find({ key: 'tab:d:\\projects\\shop' }))?.props.variant).toBe('secondary')
    await band.press({ key: 'pin-here' })

    expect(await statusOf($)).toContain('2. addons  (D:\\Projects\\shop\\addons;')
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
      expect((await pane.find({ key: 'session:me' }))?.text).toContain('here')
      expect((await pane.find({ key: 'session:b' }))?.text).toContain('2h')
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

    expect((await pane.find({ key: 'session:s' }))?.text).toContain('40m')
    expect(await pane.find({ key: 'session:t' })).toBeDefined()
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
