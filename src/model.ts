export type Point = { x: number; y: number }

export type Camera = { x: number; y: number; zoom: number }

export type ItemKind = 'image' | 'file' | 'text' | 'link'

export type BoardItem = {
  id: string
  kind: ItemKind
  title: string
  description: string
  x: number
  y: number
  text?: string
  fileName?: string
  mime?: string
  fileSize?: number
  dataUrl?: string
}

export type Stroke = {
  id: string
  points: Point[]
}

export type Board = {
  camera: Camera
  strokes: Stroke[]
  items: BoardItem[]
}

export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 8
export const GRID_BASE = 28
export const CARD_WIDTH = 280
export const PLACE_STEP_X = 304
export const PLACE_STEP_Y = 36
export const MAX_TEXT_CHARS = 100_000
export const MAX_TITLE_CHARS = 200
export const MAX_DESCRIPTION_CHARS = 8_000
export const MAX_FILE_BYTES = 2_500_000
export const MAX_DATA_URL_CHARS = 3_500_000
export const STORAGE_KEY = 'swipe-space.board.v1'

const ITEM_KINDS = new Set<ItemKind>(['image', 'file', 'text', 'link'])

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function defaultCamera(): Camera {
  return { x: 80, y: 72, zoom: 1 }
}

export function emptyBoard(): Board {
  return { camera: defaultCamera(), strokes: [], items: [] }
}

/** Top-left for a card centered on `point`, stepped so it does not cover another card. */
export function placeOrigin(point: Point, index: number, occupied: readonly Point[]): Point {
  let x = point.x - CARD_WIDTH / 2 + index * PLACE_STEP_X
  let y = point.y - 24 + index * PLACE_STEP_Y
  let guard = 0
  while (occupied.some((item) => cardsOverlap(item, { x, y })) && guard < 16) {
    x += PLACE_STEP_X
    y += PLACE_STEP_Y
    guard += 1
  }
  return { x, y }
}

function cardsOverlap(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < CARD_WIDTH && Math.abs(a.y - b.y) < 96
}

export function screenToWorld(sx: number, sy: number, camera: Camera): Point {
  return {
    x: (sx - camera.x) / camera.zoom,
    y: (sy - camera.y) / camera.zoom,
  }
}

/** Zoom toward the screen point, keeping the world point under it fixed. */
export function zoomAt(camera: Camera, sx: number, sy: number, nextZoom: number): Camera {
  const world = screenToWorld(sx, sy, camera)
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
  return {
    zoom,
    x: sx - world.x * zoom,
    y: sy - world.y * zoom,
  }
}

export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseUriList(raw: string): string[] {
  const urls: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (isHttpUrl(trimmed)) urls.push(trimmed)
  }
  return urls
}

export function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '') || 'Link'
  } catch {
    return 'Link'
  }
}

export function titleFromText(text: string, fallback: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean)
  if (!line) return fallback
  const clipped = line.length > 48 ? `${line.slice(0, 48).trimEnd()}…` : line
  return clipped.slice(0, MAX_TITLE_CHARS)
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) {
    const value = bytes / 1024
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function pathFromPoints(points: Point[]): string {
  if (points.length === 0) return ''
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString()
  if (points.length === 1) {
    return `M ${fmt(points[0].x)} ${fmt(points[0].y)} l 0.2 0`
  }
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`
  if (points.length === 2) {
    return `${d} L ${fmt(points[1].x)} ${fmt(points[1].y)}`
  }
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    d += ` Q ${fmt(points[i].x)} ${fmt(points[i].y)} ${fmt(midX)} ${fmt(midY)}`
  }
  const last = points[points.length - 1]
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`
  return d
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function strokeNear(points: Point[], point: Point, threshold: number): boolean {
  if (points.length === 0) return false
  if (points.length === 1) {
    return Math.hypot(points[0].x - point.x, points[0].y - point.y) <= threshold
  }
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(point, points[i - 1], points[i]) <= threshold) return true
  }
  return false
}

export function hitStroke(strokes: Stroke[], point: Point, threshold: number): string | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokeNear(strokes[i].points, point, threshold)) return strokes[i].id
  }
  return null
}

export function isSafeDataUrl(url: string, imagesOnly = false): boolean {
  if (!url.startsWith('data:')) return false
  const comma = url.indexOf(',')
  if (comma < 0) return false
  const meta = url.slice(5, comma).toLowerCase()
  if (
    meta.startsWith('text/html') ||
    meta.startsWith('application/javascript') ||
    meta.startsWith('text/javascript') ||
    meta.startsWith('application/xhtml')
  ) {
    return false
  }
  if (imagesOnly) return meta.startsWith('image/')
  return (
    meta.startsWith('image/') ||
    meta.startsWith('application/') ||
    meta.startsWith('audio/') ||
    meta.startsWith('video/') ||
    meta.startsWith('text/plain')
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizePoint(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const point = value as Partial<Point>
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null
  return { x: point.x, y: point.y }
}

function sanitizeCamera(value: unknown): Camera {
  const fallback = defaultCamera()
  if (!value || typeof value !== 'object') return fallback
  const camera = value as Partial<Camera>
  return {
    x: isFiniteNumber(camera.x) ? camera.x : fallback.x,
    y: isFiniteNumber(camera.y) ? camera.y : fallback.y,
    zoom: isFiniteNumber(camera.zoom) ? clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM) : fallback.zoom,
  }
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.slice(0, max)
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeItem(value: unknown): BoardItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<BoardItem>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.kind !== 'string' || !ITEM_KINDS.has(item.kind as ItemKind)) return null
  if (!isFiniteNumber(item.x) || !isFiniteNumber(item.y)) return null
  const kind = item.kind as ItemKind
  const text = optionalString(item.text, MAX_TEXT_CHARS)
  if (kind === 'link' && (!text || !isHttpUrl(text))) return null
  if (kind === 'text' && !text) return null
  let dataUrl = optionalString(item.dataUrl, MAX_DATA_URL_CHARS)
  if (dataUrl && !isSafeDataUrl(dataUrl, kind === 'image')) dataUrl = undefined
  return {
    id: item.id,
    kind,
    title: typeof item.title === 'string' ? item.title.slice(0, MAX_TITLE_CHARS) : '',
    description:
      typeof item.description === 'string' ? item.description.slice(0, MAX_DESCRIPTION_CHARS) : '',
    x: item.x,
    y: item.y,
    text,
    fileName: optionalString(item.fileName, 500),
    mime: optionalString(item.mime, 200),
    fileSize: isFiniteNumber(item.fileSize) && item.fileSize >= 0 ? item.fileSize : undefined,
    dataUrl,
  }
}

function sanitizeStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== 'object') return null
  const stroke = value as Partial<Stroke>
  if (typeof stroke.id !== 'string' || !stroke.id || !Array.isArray(stroke.points)) return null
  if (stroke.points.length > 20_000) return null
  const points = stroke.points
    .map((point) => sanitizePoint(point))
    .filter((point): point is Point => point !== null)
  if (points.length === 0) return null
  return { id: stroke.id, points }
}

export function sanitizeBoard(value: unknown): Board {
  if (!value || typeof value !== 'object') return emptyBoard()
  const raw = value as { camera?: unknown; strokes?: unknown; items?: unknown }
  const strokes = Array.isArray(raw.strokes)
    ? raw.strokes.map((stroke) => sanitizeStroke(stroke)).filter((stroke): stroke is Stroke => stroke !== null)
    : []
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => sanitizeItem(item)).filter((item): item is BoardItem => item !== null)
    : []
  return { camera: sanitizeCamera(raw.camera), strokes, items }
}

type BoardStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadBoard(storage: Pick<Storage, 'getItem'>): Board {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyBoard()
    return sanitizeBoard(JSON.parse(raw))
  } catch {
    return emptyBoard()
  }
}

export function saveBoard(storage: Pick<BoardStorage, 'setItem'>, board: Board): 'ok' | 'full' {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...board }))
    return 'ok'
  } catch {
    return 'full'
  }
}
