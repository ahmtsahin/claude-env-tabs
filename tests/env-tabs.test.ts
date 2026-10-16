import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'env-tabs'
const TOOL = 'mcp__env-tabs__tabs'
const HERE = 'C:\\work\\scratch'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

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

type World = { rows?: object[]; os?: string; refuseMoves?: boolean }

/** Everything beneath the plugin: the app's tools, the store, the clock, the OS. */
const world = (on: On, { rows = [], os = 'Windows_NT', refuseMoves = false }: World = {}) => {
  const calls: AppCall[] = []
  const opened: string[][] = []
  const sections: { id: string; kind: string; name: string }[] = []

  mock.store(on)
  mock.clock(on)
  mock.env(on, os === '' ? {} : { OS: os })
  on('session.root', () => ({ value: HERE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    opened.push([...e.argv])
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })

  const app = (call: AppCall) => {
    switch (`${call.server}.${call.tool}`) {
      case 'ccd_session_mgmt.list_sessions':
        return answer(rows)
      case 'ccd_session_mgmt.get_session':
        return answer({ group: null, pinned: false })
      case 'ccd_sidebar.list_sections':
        return answer(sections)
      case 'ccd_sidebar.create_section': {
        const made = { id: `cg-${sections.length + 1}`, kind: 'manual', name: String(call.args.name) }
        sections.push(made)
        return answer(made)
      }
      case 'ccd_sidebar.move_sessions':
        return refuseMoves
          ? answer('The server-side auto mode classifier gave no verdict', true)
          : answer('Moved.')
      default:
        return answer('ok')
    }
  }
  on('mcp.call', ($, e) => {
    const call = { server: e.server, tool: e.tool, args: e.args }
    calls.push(call)
    return { value: app(call) }
  })

  return { calls, opened, moves: () => calls.filter(call => call.tool === 'move_sessions') }
}

describe('pinning', () => {
  test('files the loose sessions of the folder under a new sidebar section', async ($, on) => {
    const { moves } = world(on, {
      rows: [
        session('a', 'D:\\Projects\\shop', '2026-10-16T10:00:00Z'),
        session('b', 'd:/projects/shop/addons', '2026-10-16T09:00:00Z'),
        session('c', 'D:\\Projects\\shop', '2026-10-16T08:00:00Z', { pinned: true }),
        session('d', 'D:\\Projects\\shop', '2026-10-16T07:00:00Z', { group: { id: 'g', name: 'Mine' } }),
        session('e', 'D:\\Other', '2026-10-16T06:00:00Z'),
      ],
    })

    const pinned = await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })

    expect(String(pinned.result)).toContain('Pinned shop')
    expect(moves()).toEqual([
      {
        server: 'ccd_sidebar',
        tool: 'move_sessions',
        args: { session_ids: ['a', 'b'], section_id: 'cg-1' },
      },
    ])
  })

  test('reuses a section of the same name instead of making another', async ($, on) => {
    const { calls } = world(on)
    await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })
    await $.tool.call({ tool: TOOL, action: 'unpin', tab: 'shop' })
    await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })

    expect(calls.filter(call => call.tool === 'create_section')).toHaveLength(1)
  })

  test('says how to finish when the app refuses the move', async ($, on) => {
    world(on, { rows: [session('a', 'D:\\Projects\\shop', '2026-10-16T10:00:00Z')], refuseMoves: true })

    const pinned = String((await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })).result)

    expect(pinned).toContain('mcp__ccd_sidebar__move_sessions')
    expect(pinned).toContain('["a"]')
  })
})

describe('changing the tabs', () => {
  test('unpinning removes the tab and deletes its section', async ($, on) => {
    const { calls } = world(on)
    await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })

    const unpinned = await $.tool.call({ tool: TOOL, action: 'unpin', tab: '1' })

    expect(String(unpinned.result)).toContain('Unpinned shop')
    expect(calls.at(-1)).toEqual({
      server: 'ccd_sidebar',
      tool: 'delete_section',
      args: { section_id: 'cg-1' },
    })
  })

  test('move and rename change the order and the labels', async ($, on) => {
    world(on)
    await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\A' })
    await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\B' })

    await $.tool.call({ tool: TOOL, action: 'move', tab: 'B', position: 1 })
    await $.tool.call({ tool: TOOL, action: 'rename', tab: '1', label: 'Bee' })

    const status = String((await $.tool.call({ tool: TOOL, action: 'status' })).result)
    expect(status).toMatch(/1\. Bee[\s\S]*2\. A/)
  })
})

describe('the band', () => {
  for (const surface of SURFACES) {
    test(`draws a tab per pin and offers to pin this folder (${surface})`, async ($, on) => {
      world(on)
      await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })

      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND })

      expect(await band.find({ type: 'Button', text: 'shop' })).toBeDefined()
      expect(await band.find({ key: 'pin-here' })).toBeDefined()
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
      await $.tool.call({ tool: TOOL, action: 'pin', folder: 'D:\\Projects\\shop' })
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
})
