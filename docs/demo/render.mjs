// Draws the README's pictures from demo projects: node docs/demo/render.mjs
// The projects and sessions are made up; the icons, dots and counts are drawn
// in the colors hooks/register.tsx draws them in.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'images')
const FONT = "Inter, 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif"
const MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, Menlo, monospace"

// The mod's own colors (hooks/register.tsx).
const SWATCHES = [
  ['#F5C4B3', '#712B13'],
  ['#9FE1CB', '#085041'],
  ['#CECBF6', '#3C3489'],
  ['#C0DD97', '#27500A'],
  ['#B5D4F4', '#0C447C'],
  ['#FAC775', '#633806'],
  ['#F4C0D1', '#72243E'],
]
const DOT_COLORS = {
  waiting: ['#BA7517', '#EF9F27'],
  unread: ['#378ADD', '#85B7EB'],
  running: ['#888780', '#B4B2A9'],
  idle: ['#B4B2A9', '#5F5E5A'],
}
const BADGE_COLORS = {
  waiting: ['#FAEEDA', '#633806', '#633806', '#FAC775'],
  unread: ['#E6F1FB', '#0C447C', '#0C447C', '#B5D4F4'],
}

const THEMES = {
  light: {
    isDark: false,
    backdrop: ['#F1ECE2', '#E3DCCD'],
    window: '#FAF9F5',
    bar: '#F2F0E9',
    sidebar: '#F4F2EC',
    pane: '#FFFFFF',
    border: '#E4E1D7',
    text: '#1F1E1D',
    dim: '#73726C',
    faint: '#A3A29C',
    active: '#EFEDE5',
    hover: '#F3F2EE',
    bubble: '#EFEDE5',
    prompt: '#FFFFFF',
    card: '#F7F6F2',
    added: '#2F7A3E',
    removed: '#B3412F',
    accent: '#D97757',
    shadow: '#1F1E1D',
    shadowOpacity: 0.16,
  },
  dark: {
    isDark: true,
    backdrop: ['#11110F', '#1E1D1B'],
    window: '#262624',
    bar: '#201F1D',
    sidebar: '#1F1E1D',
    pane: '#2A2927',
    border: '#3A3936',
    text: '#F3F1EA',
    dim: '#A3A29C',
    faint: '#6F6E69',
    active: '#363532',
    hover: '#31302D',
    bubble: '#363532',
    prompt: '#30302E',
    card: '#2E2D2B',
    added: '#7BC48A',
    removed: '#E58C7A',
    accent: '#D97757',
    shadow: '#000000',
    shadowOpacity: 0.55,
  },
}

// Demo data: the pinned projects in the order of their tabs, the other recent
// projects the latest first, and the sessions of the one this session is in.
const SESSIONS = [
  { title: 'Refactor billing webhooks', when: 'here', state: 'running' },
  { title: 'Add rate limiting to the public API', when: '4m', state: 'waiting' },
  { title: 'Migrate auth to passkeys', when: '18m', state: 'unread' },
  { title: 'Fix the flaky checkout test', when: '2h' },
  { title: 'Draft release notes for v2.4', when: '1d' },
]
const PINNED = [
  { name: 'orbit-api', color: 0, isOpen: true, isCurrent: true, mark: { count: 2, state: 'waiting' }, more: 3 },
  { name: 'pixel-forge', color: 2, mark: { count: 1, state: 'unread' } },
  { name: 'northwind-web', color: 1, mark: { isRunning: true } },
  { name: 'atlas-cli', color: 4 },
]
const PROJECTS = [
  { name: 'lumen-docs', color: 5 },
  { name: 'ember-mobile', color: 6, isHovered: true },
  { name: 'kite-agent', color: 3, mark: { isRunning: true } },
  { name: 'vector-search', color: 4, mark: { count: 1, state: 'unread' } },
  { name: 'harbor', color: 1 },
  { name: 'tidal-billing', color: 2 },
  { name: 'maple-landing', color: 0 },
  { name: 'solace-ml', color: 5 },
  { name: 'This computer', isComputer: true },
]
const RECENTS = [
  'Refactor billing webhooks',
  'Add rate limiting to the public API',
  'Migrate auth to passkeys',
  'Tune search ranking weights',
  'Ship onboarding empty states',
  'Fix the flaky checkout test',
  'Profile slow dashboard queries',
  'Upgrade to React 19',
  'Rotate staging secrets',
  'Write e2e tests for search',
  'Draft release notes for v2.4',
  'Sketch the pricing page',
]

// SVG pieces.

const escape = value => String(value).replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)

const attributes = props =>
  Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => `${name}="${escape(value)}"`)
    .join(' ')

const node = (tag, props, body) =>
  body === undefined ? `<${tag} ${attributes(props)}/>` : `<${tag} ${attributes(props)}>${body}</${tag}>`

const text = (x, y, value, { size = 13, weight = 400, fill, anchor, family = FONT, opacity } = {}) =>
  node(
    'text',
    {
      x,
      y,
      'font-family': family,
      'font-size': size,
      'font-weight': weight,
      fill,
      opacity,
      'text-anchor': anchor,
      'dominant-baseline': 'central',
    },
    escape(value),
  )

const rect = (x, y, width, height, { rx, fill, stroke, strokeWidth, opacity } = {}) =>
  node('rect', { x, y, width, height, rx, fill, stroke, 'stroke-width': strokeWidth, opacity })

const line = (x1, y1, x2, y2, stroke, width = 1) => node('line', { x1, y1, x2, y2, stroke, 'stroke-width': width })

const svg = (width, height, body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<defs>${defs}</defs>${body}</svg>\n`

const backdrop = (id, width, height, theme) =>
  node(
    'linearGradient',
    { id, x1: 0, y1: 0, x2: 1, y2: 1 },
    node('stop', { offset: 0, 'stop-color': theme.backdrop[0] }) +
      node('stop', { offset: 1, 'stop-color': theme.backdrop[1] }),
  )

const shadow = (id, theme) =>
  node(
    'filter',
    { id, x: '-10%', y: '-10%', width: '120%', height: '130%' },
    node('feDropShadow', {
      dx: 0,
      dy: 18,
      stdDeviation: 22,
      'flood-color': theme.shadow,
      'flood-opacity': theme.shadowOpacity,
    }),
  )

const letterOf = name => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()

/** About how wide a run of text is drawn, in the faces above: wide m and w, narrow i, l, t, r. */
const widthOf = (value, size, weight = 400) =>
  [...value].reduce(
    (sum, char) => sum + (/[mwMW]/.test(char) ? 0.85 : /[ijlrtf.,'\- ]/.test(char) ? 0.36 : 0.57),
    0,
  ) *
  size *
  (weight >= 600 ? 1.06 : 1)

/** A project's icon: its letter on its square, as the mod draws it. */
const icon = (x, y, project, theme, size = 18) => {
  if (project.isComputer) {
    return computer(x, y, theme, size)
  }
  const [fill, ink] = SWATCHES[project.color % SWATCHES.length]
  const [ground, letter] = theme.isDark ? [ink, fill] : [fill, ink]

  return (
    rect(x, y, size, size, { rx: size * 0.25, fill: ground }) +
    text(x + size / 2, y + size / 2 + 0.5, letterOf(project.name), {
      size: Math.round(size * 0.62),
      weight: 650,
      fill: letter,
      anchor: 'middle',
    })
  )
}

/** This computer's icon: a screen on its stand. */
const computer = (x, y, theme, size = 18) => {
  const k = size / 20

  return node(
    'g',
    {
      transform: `translate(${x} ${y}) scale(${k})`,
      fill: 'none',
      stroke: theme.dim,
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    rect(3, 4, 14, 9.5, { rx: 1.5 }) + node('path', { d: 'M7.5 16.5h5M10 13.5v3' }),
  )
}

/** A session's dot: filled, pulsing while it runs, a ring when idle. */
const dot = (cx, cy, state, theme) => {
  const color = DOT_COLORS[state ?? 'idle'][theme.isDark ? 1 : 0]
  if (state === undefined) {
    return node('circle', { cx, cy, r: 3.25, fill: 'none', stroke: color, 'stroke-width': 1.5 })
  }
  const pulse =
    state === 'running'
      ? node('animate', { attributeName: 'opacity', values: '1;0.35;1', dur: '1.6s', repeatCount: 'indefinite' })
      : ''

  return node('circle', { cx, cy, r: 4, fill: color }, pulse)
}

/** A count as a pill whose right edge is at `right`, and how wide it is. */
const badge = (right, cy, count, state, theme) => {
  const label = String(count)
  const width = Math.max(18, 10 + label.length * 6)
  const [fill, ink, darkFill, darkInk] = BADGE_COLORS[state]
  const [ground, number] = theme.isDark ? [darkFill, darkInk] : [fill, ink]

  return {
    svg:
      rect(right - width, cy - 8, width, 16, { rx: 8, fill: ground }) +
      text(right - width / 2, cy + 0.5, label, { size: 10.5, weight: 600, fill: number, anchor: 'middle' }),
    width,
  }
}

/** A project's mark at the right of its row: the count that needs you, else a running dot. */
const mark = (right, cy, project, theme) => {
  if (project.mark?.count) {
    return badge(right, cy, project.mark.count, project.mark.state, theme)
  }
  if (project.mark?.isRunning) {
    return { svg: dot(right - 6, cy, 'running', theme), width: 12 }
  }

  return { svg: '', width: 0 }
}

/** A mouse pointer, its tip at x, y. */
const pointer = (x, y, theme) =>
  node('path', {
    d: `M${x} ${y} l0 15 l3.6 -3.4 l2.5 5.6 l2.3 -1 l-2.4 -5.5 l5 -0.3 z`,
    fill: theme.isDark ? '#F3F1EA' : '#1F1E1D',
    stroke: theme.isDark ? '#1F1E1D' : '#FFFFFF',
    'stroke-width': 1.2,
    'stroke-linejoin': 'round',
  })

/**
 * The Projects pane as the mod draws it on the desktop, and the heights of
 * the rows a caption points at.
 */
const pane = (x, y, width, height, theme) => {
  const parts = [rect(x, y, width, height, { fill: theme.pane })]
  const anchors = {}
  parts.push(text(x + 16, y + 20, 'Projects', { size: 13, weight: 600, fill: theme.text }))
  parts.push(text(x + width - 18, y + 20, '×', { size: 16, fill: theme.faint, anchor: 'middle' }))
  parts.push(line(x, y + 40, x + width, y + 40, theme.border))

  let cy = y + 52
  const caption = label => {
    parts.push(text(x + 16, cy + 8, label, { size: 11.5, weight: 500, fill: theme.faint }))
    cy += 22
  }
  const row = project => {
    const mid = cy + 14
    if (project.isCurrent) {
      parts.push(rect(x + 8, cy, width - 16, 28, { rx: 6, fill: theme.active }))
    }
    if (project.isHovered) {
      parts.push(rect(x + 8, cy, width - 16, 28, { rx: 6, fill: theme.hover }))
    }
    parts.push(icon(x + 16, cy + 5, project, theme))
    parts.push(
      node(
        'text',
        {
          x: x + 42,
          y: mid,
          'font-family': FONT,
          'font-size': 13,
          'font-weight': project.isCurrent ? 650 : 500,
          fill: project.isComputer ? theme.dim : theme.text,
          'dominant-baseline': 'central',
        },
        escape(project.name) + node('tspan', { fill: theme.faint, 'font-weight': 400 }, project.isOpen ? '  ▾' : '  ▸'),
      ),
    )
    let right = x + width - 18
    if (project.isHovered) {
      parts.push(text(right, mid, project.isPinned ? 'Unpin' : 'Pin', { size: 12, fill: theme.dim, anchor: 'end' }))
      parts.push(text(right - 36, mid, '+ New', { size: 12, fill: theme.dim, anchor: 'end' }))
      parts.push(pointer(right - 47, mid + 5, theme))
      right -= 84
    }
    parts.push(mark(right, mid, project, theme).svg)
    anchors[project.name] = mid
    cy += 30

    if (project.isOpen) {
      for (const session of SESSIONS) {
        const smid = cy + 13
        parts.push(dot(x + 34, smid, session.state, theme))
        parts.push(text(x + 46, smid, session.title, { size: 12.5, fill: theme.text }))
        parts.push(text(x + width - 18, smid, session.when, { size: 12, fill: theme.faint, anchor: 'end' }))
        anchors[session.title] = smid
        cy += 26
      }
      parts.push(text(x + 46, cy + 10, `+${project.more} more`, { size: 12, fill: theme.faint }))
      cy += 26
    }
  }

  anchors.pinned = cy + 8
  caption('Pinned')
  PINNED.forEach(project => row({ ...project, isPinned: true }))
  cy += 8
  anchors.projects = cy + 8
  caption('Projects')
  PROJECTS.forEach(row)

  return { svg: parts.join(''), anchors, bottom: cy }
}

/** The tabs above the prompt, from `x`; the tab of this session's project filled. */
const tabs = (x, y, theme) => {
  const parts = []
  let left = x
  for (const project of PINNED) {
    const label = project.name
    const labelWidth = widthOf(label, 13, project.isCurrent ? 600 : 500)
    const markWidth = project.mark?.count ? 24 : project.mark?.isRunning ? 16 : 0
    const width = 7 + 16 + 7 + labelWidth + markWidth + 8
    if (project.isCurrent) {
      parts.push(rect(left, y, width, 28, { rx: 7, fill: theme.active }))
    }
    parts.push(icon(left + 7, y + 6, project, theme, 16))
    parts.push(
      text(left + 30, y + 14.5, label, {
        size: 13,
        weight: project.isCurrent ? 600 : 500,
        fill: project.isCurrent ? theme.text : theme.dim,
      }),
    )
    parts.push(mark(left + width - 8, y + 14, project, theme).svg)
    left += width + 4
  }
  parts.push(text(left + 8, y + 14.5, 'Projects', { size: 13, fill: theme.faint }))

  return parts.join('')
}

/** The prompt box: a placeholder, an attach button, and the send button. */
const prompt = (x, y, width, theme) =>
  rect(x, y, width, 74, { rx: 16, fill: theme.prompt, stroke: theme.border }) +
  text(x + 20, y + 25, 'Reply to Claude…', { size: 14, fill: theme.faint }) +
  node('circle', { cx: x + 26, cy: y + 53, r: 11, fill: 'none', stroke: theme.border }) +
  text(x + 26, y + 53.5, '+', { size: 15, fill: theme.dim, anchor: 'middle' }) +
  node('circle', { cx: x + width - 26, cy: y + 52, r: 14, fill: theme.accent }) +
  node('path', {
    d: `M${x + width - 26} ${y + 58}v-12m-5 5l5-5l5 5`,
    stroke: '#FFFFFF',
    'stroke-width': 2,
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })

/** A tool call's card in the conversation. */
const card = (x, y, width, theme, tool, detail, result) =>
  rect(x, y, width, 40, { rx: 10, fill: theme.card, stroke: theme.border }) +
  text(x + 14, y + 20, tool, { size: 12.5, weight: 600, fill: theme.text }) +
  text(x + 22 + widthOf(tool, 12.5, 600), y + 20, detail, { size: 12, family: MONO, fill: theme.dim }) +
  result

/** The app around the pane: its sidebar, the conversation, the tabs and the prompt. */
const hero = theme => {
  const [W, H] = [1280, 800]
  const [wx, wy, ww, wh] = [40, 36, 1200, 728]
  const paneWidth = 334
  const px = wx + ww - paneWidth
  const parts = []

  parts.push(rect(0, 0, W, H, { fill: 'url(#ground)' }))
  parts.push(rect(wx, wy, ww, wh, { rx: 10, fill: theme.window, stroke: theme.border }).replace('/>', ' filter="url(#lift)"/>'))
  const inside = []
  inside.push(rect(wx, wy, ww, 40, { fill: theme.bar }))
  // A Windows title bar: the app's menu on the left, minimize, maximize and close on the right.
  const glyph = { stroke: theme.dim, 'stroke-width': 1, fill: 'none', 'stroke-linecap': 'round' }
  inside.push(node('path', { ...glyph, d: `M${wx + 18} ${wy + 15}h12M${wx + 18} ${wy + 20}h12M${wx + 18} ${wy + 25}h12` }))
  const buttons = wx + ww - 138
  inside.push(node('path', { ...glyph, d: `M${buttons + 18} ${wy + 20.5}h10` }))
  inside.push(rect(buttons + 64, wy + 15.5, 10, 10, { rx: 1.5, fill: 'none', stroke: theme.dim, strokeWidth: 1 }))
  inside.push(node('path', { ...glyph, d: `M${buttons + 110} ${wy + 15.5}l10 10m0 -10l-10 10` }))
  inside.push(text(wx + ww / 2, wy + 20, 'orbit-api  ·  Refactor billing webhooks', { size: 12.5, fill: theme.dim, anchor: 'middle' }))
  inside.push(line(wx, wy + 40, wx + ww, wy + 40, theme.border))

  // The app's own sidebar, sorted by recent activity.
  const sx = wx
  inside.push(rect(sx, wy + 40, 240, wh - 40, { fill: theme.sidebar }))
  inside.push(line(sx + 240, wy + 40, sx + 240, wy + wh, theme.border))
  inside.push(rect(sx + 14, wy + 56, 212, 32, { rx: 8, fill: theme.window, stroke: theme.border }))
  inside.push(text(sx + 28, wy + 72, '+', { size: 16, fill: theme.dim }))
  inside.push(text(sx + 46, wy + 72, 'New session', { size: 13, weight: 500, fill: theme.text }))
  inside.push(text(sx + 18, wy + 110, 'Recents', { size: 11.5, weight: 500, fill: theme.faint }))
  RECENTS.forEach((title, i) => {
    const ry = wy + 124 + i * 32
    if (i === 0) {
      inside.push(rect(sx + 8, ry, 224, 28, { rx: 6, fill: theme.active }))
    }
    inside.push(text(sx + 18, ry + 14, title.length > 27 ? `${title.slice(0, 26)}…` : title, { size: 12.5, fill: i === 0 ? theme.text : theme.dim }))
  })

  // The conversation.
  const cx = sx + 240
  const column = { left: cx + 48, right: px - 48 }
  const bubble = { width: 370, height: 58 }
  inside.push(rect(column.right - bubble.width, wy + 76, bubble.width, bubble.height, { rx: 16, fill: theme.bubble }))
  inside.push(text(column.right - bubble.width + 18, wy + 96, 'Webhooks retry forever when Stripe answers 409.', { size: 13.5, fill: theme.text }))
  inside.push(text(column.right - bubble.width + 18, wy + 115, 'Make them idempotent.', { size: 13.5, fill: theme.text }))
  const say = (yy, value) => inside.push(text(column.left, yy, value, { size: 14, fill: theme.text }))
  say(wy + 172, "I'll key each webhook by Stripe's event id and skip events")
  say(wy + 194, 'we have already processed, so a retry becomes a no-op.')
  const cardWidth = column.right - column.left
  inside.push(
    card(column.left, wy + 222, cardWidth, theme, 'Edit', 'src/billing/webhooks.ts',
      text(column.left + cardWidth - 52, wy + 242, '+18', { size: 12, weight: 600, fill: theme.added, anchor: 'end' }) +
        text(column.left + cardWidth - 14, wy + 242, '−6', { size: 12, weight: 600, fill: theme.removed, anchor: 'end' })),
  )
  inside.push(
    card(column.left, wy + 272, cardWidth, theme, 'Bash', 'npm test -- webhooks',
      text(column.left + cardWidth - 14, wy + 292, '24 passed', { size: 12, weight: 600, fill: theme.added, anchor: 'end' })),
  )
  say(wy + 344, 'Idempotent now: a replayed event returns 200 without charging')
  say(wy + 366, 'again. Next I am running the whole billing suite.')
  inside.push(text(column.left, wy + 412, '✻', { size: 16, fill: theme.accent }))
  inside.push(text(column.left + 22, wy + 412, 'Running the billing suite…', { size: 13.5, fill: theme.dim }))

  // The tabs above the prompt, and the prompt.
  inside.push(tabs(cx + 28, wy + wh - 130, theme))
  inside.push(prompt(cx + 28, wy + wh - 94, px - cx - 56, theme))

  // The Projects pane, docked beside the conversation.
  inside.push(line(px, wy + 40, px, wy + wh, theme.border))
  inside.push(pane(px, wy + 41, paneWidth, wh - 41, theme).svg)

  parts.push(node('g', { 'clip-path': 'url(#window)' }, inside.join('')))
  const defs =
    backdrop('ground', W, H, theme) +
    shadow('lift', theme) +
    node('clipPath', { id: 'window' }, rect(wx, wy, ww, wh, { rx: 10 }))

  return svg(W, H, parts.join(''), defs)
}

/** The pane by itself, with captions for what it shows, each led to its row. */
const paneShot = theme => {
  const [x, y, width] = [48, 40, 360]
  const measured = pane(x, y, width, 2000, theme)
  const height = measured.bottom - y + 10
  const [W, H] = [900, height + 80]
  const { svg: body, anchors } = pane(x, y, width, height, theme)
  const notes = [
    ['Pinned projects stay on top', 'In the order of your tabs.', anchors.pinned],
    ['What needs you, counted', 'Amber while a session waits for you.', anchors['orbit-api']],
    ['Every session has a state', 'Waiting for you, unread, running, idle.', anchors['Add rate limiting to the public API']],
    ['Point at a row for + New and Pin', 'Start a session, or pin the project.', anchors['ember-mobile']],
    ['This computer', 'Sessions started without a folder.', anchors['This computer']],
  ]
  const parts = [
    rect(0, 0, W, H, { fill: 'url(#ground)' }),
    node('g', { filter: 'url(#lift)' }, rect(x, y, width, height, { rx: 14, fill: theme.pane, stroke: theme.border })),
    node('g', { 'clip-path': 'url(#card)' }, body),
  ]
  // Each caption sits level with its row, pushed down where one above would crowd it.
  let floor = -Infinity
  for (const [title, detail, at] of notes) {
    const level = Math.max(at, floor + 64)
    floor = level
    const from = x + width + 10
    const labelX = x + width + 92
    parts.push(node('circle', { cx: from, cy: at, r: 3, fill: theme.accent }))
    parts.push(
      node('polyline', {
        points: `${from},${at} ${from + 24},${at} ${from + 50},${level} ${labelX - 10},${level}`,
        fill: 'none',
        stroke: theme.accent,
        'stroke-width': 1.2,
        'stroke-linejoin': 'round',
      }),
    )
    parts.push(text(labelX, level - 10, title, { size: 15, weight: 600, fill: theme.text }))
    parts.push(text(labelX, level + 11, detail, { size: 13, fill: theme.dim }))
  }
  const defs =
    backdrop('ground', W, H, theme) +
    shadow('lift', theme) +
    node('clipPath', { id: 'card' }, rect(x, y, width, height, { rx: 14 }))

  return svg(W, H, parts.join(''), defs)
}

/** The tabs above the prompt, close up. */
const tabsShot = theme => {
  const [W, H] = [1000, 200]
  const parts = [
    rect(0, 0, W, H, { fill: 'url(#ground)' }),
    node('g', { filter: 'url(#lift)' }, rect(40, 28, W - 80, 144, { rx: 16, fill: theme.window, stroke: theme.border })),
    tabs(64, 46, theme),
    prompt(64, 82, W - 128, theme),
  ]

  return svg(W, H, parts.join(''), backdrop('ground', W, H, theme) + shadow('lift', theme))
}

/** One state's dot, for the README's table; it follows the reader's light or dark theme. */
const dotShot = state => {
  const [light, dark] = DOT_COLORS[state]
  const paint = state === 'idle' ? 'fill:none;stroke:' : 'fill:'
  const pulse =
    state === 'running'
      ? node('animate', { attributeName: 'opacity', values: '1;0.35;1', dur: '1.6s', repeatCount: 'indefinite' })
      : ''

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
    `<style>.d{${paint}${light}}@media (prefers-color-scheme: dark){.d{${paint}${dark}}}</style>` +
    node('circle', { class: 'd', cx: 7, cy: 7, r: state === 'idle' ? 4 : 5, 'stroke-width': 1.6 }, pulse) +
    '</svg>\n'
  )
}

/** The repository's social preview: what env-tabs is, beside the pane. */
const social = () => {
  const theme = THEMES.dark
  const [W, H] = [1280, 640]
  const [x, y, width, height] = [800, 48, 380, 600]
  const { svg: body } = pane(x, y, width, height, theme)
  const bullets = [
    ['waiting', 'Pinned projects on top of a Projects pane'],
    ['unread', 'Live session states, like the sidebar dots'],
    ['running', 'A tab above the prompt for each project'],
  ]
  const parts = [
    rect(0, 0, W, H, { fill: 'url(#ground)' }),
    text(88, 210, 'env-tabs', { size: 84, weight: 700, fill: theme.text }),
    text(92, 290, "Your projects, pinned in Claude Desktop's", { size: 30, fill: theme.dim }),
    text(92, 332, 'Code tab.', { size: 30, fill: theme.dim }),
    ...bullets.flatMap(([state, label], i) => [
      dot(100, 412 + i * 46, state, theme),
      text(122, 412 + i * 46, label, { size: 22, fill: theme.text }),
    ]),
    node('g', { filter: 'url(#lift)' }, rect(x, y, width, height + 40, { rx: 16, fill: theme.pane, stroke: theme.border })),
    node('g', { 'clip-path': 'url(#card)' }, body),
  ]
  const defs =
    backdrop('ground', W, H, theme) +
    shadow('lift', theme) +
    node('clipPath', { id: 'card' }, rect(x, y, width, height + 40, { rx: 16 }))

  return svg(W, H, parts.join(''), defs)
}

mkdirSync(OUT, { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `hero-${name}.svg`), hero(theme))
  writeFileSync(join(OUT, `pane-${name}.svg`), paneShot(theme))
  writeFileSync(join(OUT, `tabs-${name}.svg`), tabsShot(theme))
}
for (const state of Object.keys(DOT_COLORS)) {
  writeFileSync(join(OUT, `dot-${state}.svg`), dotShot(state))
}
writeFileSync(join(OUT, 'social.svg'), social())
console.log(`Drew the pictures into ${OUT}`)
