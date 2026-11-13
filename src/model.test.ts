import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyBoard,
  CARD_WIDTH,
  hitStroke,
  hostnameFromUrl,
  isHttpUrl,
  isSafeDataUrl,
  loadBoard,
  parseUriList,
  pathFromPoints,
  placeOrigin,
  sanitizeBoard,
  saveBoard,
  screenToWorld,
  titleFromText,
  zoomAt,
} from './model.ts'

describe('camera', () => {
  it('keeps the world point under the cursor when zooming', () => {
    const camera = { x: 100, y: 80, zoom: 1 }
    const sx = 420
    const sy = 260
    const before = screenToWorld(sx, sy, camera)
    const next = zoomAt(camera, sx, sy, 2.5)
    const after = screenToWorld(sx, sy, next)
    assert.equal(next.zoom, 2.5)
    assert.ok(Math.abs(before.x - after.x) < 1e-9)
    assert.ok(Math.abs(before.y - after.y) < 1e-9)
  })

  it('clamps extreme zoom without moving the cursor point', () => {
    const camera = { x: 0, y: 0, zoom: 1 }
    const next = zoomAt(camera, 10, 10, 100)
    assert.equal(next.zoom, 8)
    const before = screenToWorld(10, 10, camera)
    const after = screenToWorld(10, 10, next)
    assert.ok(Math.abs(before.x - after.x) < 1e-9)
    assert.ok(Math.abs(before.y - after.y) < 1e-9)
  })
})

describe('placement classification', () => {
  it('accepts http(s) urls and rejects other text', () => {
    assert.equal(isHttpUrl('https://example.com/a'), true)
    assert.equal(isHttpUrl('  http://example.com  '), true)
    assert.equal(isHttpUrl('javascript:alert(1)'), false)
    assert.equal(isHttpUrl('notes from today'), false)
    assert.equal(isHttpUrl('https://example.com and more'), false)
  })

  it('reads uri lists and skips comments', () => {
    const urls = parseUriList('# comment\nhttps://a.example/one\n\nhttps://b.example/two')
    assert.deepEqual(urls, ['https://a.example/one', 'https://b.example/two'])
  })

  it('derives titles from text and hosts', () => {
    assert.equal(titleFromText('  First line\nsecond', 'Text'), 'First line')
    assert.equal(hostnameFromUrl('https://www.example.com/path'), 'example.com')
  })
})

describe('paste offset', () => {
  it('centers the first card on the pointer and steps later ones aside', () => {
    const pointer = { x: 500, y: 400 }
    const first = placeOrigin(pointer, 0, [])
    assert.equal(first.x, pointer.x - CARD_WIDTH / 2)
    assert.equal(first.y, pointer.y - 24)

    const second = placeOrigin(pointer, 0, [first])
    assert.ok(Math.abs(second.x - first.x) >= CARD_WIDTH)
    assert.ok(second.y > first.y)

    const third = placeOrigin(pointer, 0, [first, second])
    assert.ok(Math.abs(third.x - second.x) >= CARD_WIDTH)
    assert.ok(third.y > second.y)
  })

  it('spaces a multi-file drop before checking for occupied cards', () => {
    const pointer = { x: 200, y: 200 }
    const first = placeOrigin(pointer, 0, [])
    const second = placeOrigin(pointer, 1, [first])
    assert.ok(Math.abs(second.x - first.x) >= CARD_WIDTH)
  })
})

describe('strokes', () => {
  it('hits the nearest stroke and misses empty space', () => {
    const strokes = [
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { id: 'b', points: [{ x: 0, y: 20 }, { x: 10, y: 20 }] },
    ]
    assert.equal(hitStroke(strokes, { x: 5, y: 1 }, 2), 'a')
    assert.equal(hitStroke(strokes, { x: 5, y: 19 }, 2), 'b')
    assert.equal(hitStroke(strokes, { x: 5, y: 10 }, 2), null)
  })

  it('builds a path from points', () => {
    assert.match(pathFromPoints([{ x: 1, y: 2 }, { x: 3, y: 4 }]), /^M 1 2 L 3 4$/)
  })
})

describe('persistence', () => {
  it('drops unsafe items and keeps the rest of the board', () => {
    const board = sanitizeBoard({
      camera: { x: 12, y: 8, zoom: 99 },
      strokes: [
        { id: 's', points: [{ x: 1, y: 2 }, { x: 'no', y: 3 }] },
        { id: '', points: [{ x: 1, y: 1 }] },
      ],
      items: [
        {
          id: 'ok',
          kind: 'text',
          title: 'Note',
          description: 'Kept',
          x: 4,
          y: 5,
          text: 'hello',
        },
        {
          id: 'bad-link',
          kind: 'link',
          title: 'Nope',
          description: '',
          x: 0,
          y: 0,
          text: 'javascript:alert(1)',
        },
        {
          id: 'img',
          kind: 'image',
          title: 'Shot',
          description: '',
          x: 1,
          y: 1,
          dataUrl: 'data:text/html,<script>',
        },
      ],
    })
    assert.equal(board.camera.zoom, 8)
    assert.equal(board.strokes.length, 1)
    assert.deepEqual(board.strokes[0].points, [{ x: 1, y: 2 }])
    assert.equal(board.items.length, 2)
    assert.equal(board.items[0].text, 'hello')
    assert.equal(board.items[1].dataUrl, undefined)
  })

  it('round-trips a board through storage', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
    }
    const board = emptyBoard()
    board.items.push({
      id: 't',
      kind: 'text',
      title: 'Hello',
      description: 'World',
      x: 10,
      y: 20,
      text: 'Copied text',
    })
    assert.equal(saveBoard(storage, board), 'ok')
    const loaded = loadBoard(storage)
    assert.equal(loaded.items[0].description, 'World')
    assert.equal(loaded.items[0].text, 'Copied text')
  })

  it('rejects non-image data urls when an image is required', () => {
    assert.equal(isSafeDataUrl('data:image/png;base64,aaaa', true), true)
    assert.equal(isSafeDataUrl('data:application/pdf;base64,aaaa', true), false)
    assert.equal(isSafeDataUrl('data:text/html,hi'), false)
  })
})
