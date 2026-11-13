import {
  CARD_WIDTH,
  GRID_BASE,
  MAX_DATA_URL_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  type BoardItem,
  type ItemKind,
  type Point,
  type Stroke,
  formatBytes,
  hitStroke,
  hostnameFromUrl,
  isHttpUrl,
  isSafeDataUrl,
  loadBoard,
  parseUriList,
  pathFromPoints,
  placeOrigin,
  saveBoard,
  screenToWorld,
  titleFromText,
  zoomAt,
} from './model'

const SVG_NS = 'http://www.w3.org/2000/svg'
const HARD_READ_LIMIT = 25_000_000

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
  md: 'text/plain',
}

type DrawGesture = {
  kind: 'draw'
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  points: Point[]
  drawing: boolean
}

type PanGesture = {
  kind: 'pan'
  pointerId: number
  lastX: number
  lastY: number
}

type MoveGesture = {
  kind: 'move'
  pointerId: number
  id: string
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
  href: string | null
}

type PinchGesture = {
  kind: 'pinch'
  startDistance: number
  startZoom: number
  lastMidX: number
  lastMidY: number
}

type Gesture = DrawGesture | PanGesture | MoveGesture | PinchGesture

const viewport = must<HTMLDivElement>('viewport')
const world = must<HTMLDivElement>('world')
const ink = must<SVGSVGElement>('ink')
const itemsRoot = must<HTMLDivElement>('items')
const empty = must<HTMLDivElement>('empty')
const zoomLabel = must<HTMLSpanElement>('zoom-label')
const dropBanner = must<HTMLDivElement>('drop-banner')
const status = must<HTMLDivElement>('status')

const loaded = loadBoard(localStorage)
let camera = loaded.camera
const strokes: Stroke[] = loaded.strokes
const items: BoardItem[] = loaded.items
const itemElements = new Map<string, HTMLElement>()

let selectedItemId: string | null = null
let selectedStrokeId: string | null = null
let gesture: Gesture | null = null
let livePath: SVGPathElement | null = null
let spaceDown = false
let pointerSeen = false
let lastClient = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
let saveTimer = 0
let quotaWarned = false
let statusTimer = 0
let dropTimer = 0
const pointers = new Map<number, Point>()

for (const stroke of strokes) appendStrokePath(stroke)
for (const item of items) mountItem(item)
renderCamera()
syncEmpty()

window.addEventListener('pointerdown', onPointerDown, true)
window.addEventListener('pointermove', onPointerMove, true)
window.addEventListener('pointerup', onPointerUp, true)
window.addEventListener('pointercancel', onPointerUp, true)
window.addEventListener('wheel', onWheel, { passive: false })
window.addEventListener('keydown', onKeyDown, true)
window.addEventListener('keyup', onKeyUp, true)
window.addEventListener('blur', releaseSpace)
window.addEventListener('paste', onPaste)
window.addEventListener('dragenter', onDragOver, true)
window.addEventListener('dragover', onDragOver, true)
window.addEventListener('dragleave', scheduleHideDrop, true)
window.addEventListener('drop', onDrop, true)
window.addEventListener('dragend', hideDrop, true)
window.addEventListener('auxclick', (event) => {
  if (event.button === 1) event.preventDefault()
})
window.addEventListener('pagehide', flushSave)
window.addEventListener('beforeunload', flushSave)

must<HTMLButtonElement>('zoom-in').addEventListener('click', () => zoomBy(1.15))
must<HTMLButtonElement>('zoom-out').addEventListener('click', () => zoomBy(1 / 1.15))
must<HTMLButtonElement>('zoom-reset').addEventListener('click', resetZoom)

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('button, input, textarea, label, a.download')) {
    const card = target.closest('.card')
    if (card instanceof HTMLElement && card.dataset.id) selectItem(card.dataset.id)
    return
  }

  const textBody = target?.closest('.text-body')
  if (textBody instanceof HTMLElement && textBody.scrollHeight > textBody.clientHeight + 1) {
    const card = textBody.closest('.card')
    if (card instanceof HTMLElement && card.dataset.id) selectItem(card.dataset.id)
    return
  }

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  pointerSeen = true
  lastClient = { x: event.clientX, y: event.clientY }

  if (pointers.size >= 2) {
    beginPinch()
    return
  }
  if (event.button === 1 || (event.button === 0 && spaceDown)) {
    beginPan(event)
    return
  }
  if (event.button !== 0) return

  const card = target?.closest('.card')
  if (card instanceof HTMLElement) {
    beginMove(event, card)
    return
  }
  if (target?.closest('.dock, .top')) return
  beginDraw(event)
}

function onPointerMove(event: PointerEvent) {
  lastClient = { x: event.clientX, y: event.clientY }
  pointerSeen = true
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (!gesture) return
  event.preventDefault()
  if (gesture.kind === 'draw' && spaceDown) {
    switchDrawToPan(event.clientX, event.clientY)
    return
  }
  if (gesture.kind === 'pinch') {
    updatePinch(gesture)
    return
  }
  if (gesture.pointerId !== event.pointerId) return
  if (gesture.kind === 'draw') updateDraw(gesture, event)
  else if (gesture.kind === 'pan') updatePan(gesture, event)
  else updateMove(gesture, event)
}

function onPointerUp(event: PointerEvent) {
  lastClient = { x: event.clientX, y: event.clientY }
  const tracked = pointers.has(event.pointerId)
  pointers.delete(event.pointerId)
  if (!tracked) return
  if (gesture?.kind === 'pinch') {
    if (pointers.size < 2) finishPinch()
    return
  }
  if (gesture && gesture.pointerId === event.pointerId) {
    const current = gesture
    gesture = null
    finishSingle(current)
  }
}

function beginPinch() {
  if (gesture?.kind === 'move' && gesture.moved) scheduleSave()
  clearLive()
  const ends = pointerPair()
  if (!ends) return
  const [a, b] = ends
  gesture = {
    kind: 'pinch',
    startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    startZoom: camera.zoom,
    lastMidX: (a.x + b.x) / 2,
    lastMidY: (a.y + b.y) / 2,
  }
  viewport.classList.add('is-panning')
}

function updatePinch(active: PinchGesture) {
  const ends = pointerPair()
  if (!ends) return
  const [a, b] = ends
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  camera.x += midX - active.lastMidX
  camera.y += midY - active.lastMidY
  active.lastMidX = midX
  active.lastMidY = midY
  const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
  camera = zoomAt(camera, midX, midY, active.startZoom * (distance / active.startDistance))
  renderCamera()
}

function finishPinch() {
  gesture = null
  viewport.classList.remove('is-panning')
  scheduleSave()
}

function beginPan(event: PointerEvent) {
  event.preventDefault()
  blurField()
  capture(event)
  gesture = { kind: 'pan', pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
  viewport.classList.add('is-panning')
}

function updatePan(active: PanGesture, event: PointerEvent) {
  camera.x += event.clientX - active.lastX
  camera.y += event.clientY - active.lastY
  active.lastX = event.clientX
  active.lastY = event.clientY
  renderCamera()
}

function beginMove(event: PointerEvent, card: HTMLElement) {
  const id = card.dataset.id
  if (!id) return
  const item = items.find((entry) => entry.id === id)
  if (!item) return
  event.preventDefault()
  blurField()
  selectItem(id)
  capture(event)
  const anchor = event.target instanceof Element ? event.target.closest('a.link-url') : null
  gesture = {
    kind: 'move',
    pointerId: event.pointerId,
    id,
    startX: event.clientX,
    startY: event.clientY,
    originX: item.x,
    originY: item.y,
    moved: false,
    href: anchor?.getAttribute('href') ?? null,
  }
}

function updateMove(active: MoveGesture, event: PointerEvent) {
  if (!active.moved) {
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    if (dx * dx + dy * dy < 16) return
    active.moved = true
    itemElements.get(active.id)?.classList.add('is-moving')
  }
  const item = items.find((entry) => entry.id === active.id)
  if (!item) return
  item.x = active.originX + (event.clientX - active.startX) / camera.zoom
  item.y = active.originY + (event.clientY - active.startY) / camera.zoom
  const element = itemElements.get(item.id)
  if (!element) return
  element.style.left = `${item.x}px`
  element.style.top = `${item.y}px`
}

function beginDraw(event: PointerEvent) {
  event.preventDefault()
  blurField()
  capture(event)
  gesture = {
    kind: 'draw',
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    points: [],
    drawing: false,
  }
}

function updateDraw(active: DrawGesture, event: PointerEvent) {
  const samples = event.getCoalescedEvents?.()
  const list = samples && samples.length > 0 ? samples : [event]
  for (const sample of list) addDrawPoint(active, sample.clientX, sample.clientY)
}

function addDrawPoint(active: DrawGesture, x: number, y: number) {
  if (!active.drawing) {
    const dx = x - active.startX
    const dy = y - active.startY
    if (dx * dx + dy * dy < 16) return
    active.drawing = true
    clearSelection()
    active.points.push(roundPoint(screenToWorld(active.startX, active.startY, camera)))
    active.lastX = active.startX
    active.lastY = active.startY
  }
  const dx = x - active.lastX
  const dy = y - active.lastY
  if (dx * dx + dy * dy < 2.25) return
  active.lastX = x
  active.lastY = y
  active.points.push(roundPoint(screenToWorld(x, y, camera)))
  ensureLive().setAttribute('d', pathFromPoints(active.points))
}

function finishSingle(active: Exclude<Gesture, PinchGesture>) {
  if (active.kind === 'draw') {
    clearLive()
    if (active.drawing && active.points.length >= 2) {
      const stroke: Stroke = { id: uid(), points: active.points }
      strokes.push(stroke)
      appendStrokePath(stroke)
      syncEmpty()
      flushSave()
    } else {
      const world = screenToWorld(lastClient.x, lastClient.y, camera)
      const hit = hitStroke(strokes, world, 10 / camera.zoom)
      if (hit) selectStroke(hit)
      else clearSelection()
    }
    return
  }
  if (active.kind === 'pan') {
    viewport.classList.remove('is-panning')
    scheduleSave()
    return
  }
  itemElements.get(active.id)?.classList.remove('is-moving')
  if (active.moved) {
    scheduleSave()
    return
  }
  if (active.href && isHttpUrl(active.href)) {
    window.open(active.href, '_blank', 'noopener,noreferrer')
  }
}

function onWheel(event: WheelEvent) {
  if (scrollableField(event.target)) return
  event.preventDefault()
  const { x, y } = wheelPixels(event)
  if (event.ctrlKey || event.metaKey) {
    camera = zoomAt(camera, event.clientX, event.clientY, camera.zoom * Math.exp(-y * 0.0016))
  } else {
    camera.x -= x
    camera.y -= y
  }
  renderCamera()
  scheduleSave()
}

function onKeyDown(event: KeyboardEvent) {
  if (isSpaceKey(event)) {
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
    if (event.target instanceof Element && event.target.closest('button, a')) return
    event.preventDefault()
    spaceDown = true
    viewport.classList.add('is-space')
    if (gesture?.kind === 'draw') switchDrawToPan(lastClient.x, lastClient.y)
    return
  }
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeSelected()
    return
  }
  if (event.key === 'Escape') {
    clearSelection()
    return
  }
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
    event.preventDefault()
    zoomBy(1.15)
    return
  }
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
    event.preventDefault()
    zoomBy(1 / 1.15)
    return
  }
  if (event.key === '0' || event.code === 'Numpad0') {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    resetZoom()
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    return
  }
  const step = event.shiftKey ? 120 : 48
  if (event.key === 'ArrowLeft') camera.x += step
  else if (event.key === 'ArrowRight') camera.x -= step
  else if (event.key === 'ArrowUp') camera.y += step
  else if (event.key === 'ArrowDown') camera.y -= step
  else return
  event.preventDefault()
  renderCamera()
  scheduleSave()
}

function onKeyUp(event: KeyboardEvent) {
  if (isSpaceKey(event)) releaseSpace()
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
}

function switchDrawToPan(x: number, y: number) {
  if (gesture?.kind !== 'draw') return
  const pointerId = gesture.pointerId
  clearLive()
  gesture = { kind: 'pan', pointerId, lastX: x, lastY: y }
  viewport.classList.add('is-panning')
}

function releaseSpace() {
  spaceDown = false
  viewport.classList.remove('is-space')
}

function zoomBy(factor: number) {
  camera = zoomAt(camera, window.innerWidth / 2, window.innerHeight / 2, camera.zoom * factor)
  renderCamera()
  scheduleSave()
}

function resetZoom() {
  camera = zoomAt(camera, window.innerWidth / 2, window.innerHeight / 2, 1)
  renderCamera()
  scheduleSave()
}

function renderCamera() {
  world.style.transform = `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})`
  const step = camera.zoom < 0.35 ? GRID_BASE * 4 : camera.zoom < 0.7 ? GRID_BASE * 2 : GRID_BASE
  const grid = step * camera.zoom
  viewport.style.backgroundSize = `${grid}px ${grid}px`
  viewport.style.backgroundPosition = `${mod(camera.x, grid)}px ${mod(camera.y, grid)}px`
  zoomLabel.textContent = `${Math.round(camera.zoom * 100)}%`
}

function onPaste(event: ClipboardEvent) {
  if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
  const data = event.clipboardData
  if (!data) return
  event.preventDefault()
  void handleTransfer(data, pointerWorld())
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  window.clearTimeout(dropTimer)
  viewport.classList.add('is-drop')
  dropBanner.hidden = false
}

function scheduleHideDrop() {
  window.clearTimeout(dropTimer)
  dropTimer = window.setTimeout(hideDrop, 80)
}

function hideDrop() {
  viewport.classList.remove('is-drop')
  dropBanner.hidden = true
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  hideDrop()
  const data = event.dataTransfer
  if (!data) return
  pointerSeen = true
  lastClient = { x: event.clientX, y: event.clientY }
  void handleTransfer(data, screenToWorld(event.clientX, event.clientY, camera))
}

async function handleTransfer(data: DataTransfer, worldPoint: Point) {
  const files = await collectFiles(data)
  if (files.length > 0) {
    for (let index = 0; index < files.length; index++) {
      await placeFile(files[index], originFor(worldPoint, index))
    }
    return
  }
  const urls = parseUriList(data.getData('text/uri-list'))
  if (urls.length > 0) {
    urls.forEach((url, index) => placeLink(url, originFor(worldPoint, index)))
    return
  }
  let text = data.getData('text/plain')
  if (!text.trim()) {
    const html = data.getData('text/html')
    if (html) text = htmlToText(html)
  }
  if (!text.trim()) {
    showStatus('Nothing in that paste or drop could be placed.')
    return
  }
  if (isHttpUrl(text)) placeLink(text.trim(), originFor(worldPoint, 0))
  else placeText(text, originFor(worldPoint, 0))
}

async function placeFile(file: File, at: Point) {
  const typed = ensureType(file)
  const kind: ItemKind = typed.type.startsWith('image/') ? 'image' : 'file'
  let dataUrl: string | undefined
  let warning: string | null = null
  const tooBigToRead = typed.size > HARD_READ_LIMIT || (kind === 'file' && typed.size > MAX_FILE_BYTES)
  if (tooBigToRead) {
    warning = 'Saved the item. The file was too large to keep in this browser.'
  } else {
    try {
      const raw = kind === 'image' ? await imageFileToDataUrl(typed) : await readAsDataUrl(typed)
      if (raw.length <= MAX_DATA_URL_CHARS && isSafeDataUrl(raw, kind === 'image')) dataUrl = raw
      else warning = 'Saved the item. The file was too large to keep in this browser.'
    } catch {
      warning = 'Saved the item, but the file contents could not be kept.'
    }
  }
  addItem({
    id: uid(),
    kind,
    title: (kind === 'image' ? imageTitle(typed.name) : typed.name || 'File').slice(0, MAX_TITLE_CHARS),
    description: '',
    x: at.x,
    y: at.y,
    fileName: typed.name || undefined,
    mime: typed.type || undefined,
    fileSize: typed.size,
    dataUrl,
  })
  if (warning) showStatus(warning)
}

function placeText(value: string, at: Point) {
  const trimmed = value.trim()
  if (!trimmed) return
  const text = trimmed.slice(0, MAX_TEXT_CHARS)
  addItem({
    id: uid(),
    kind: 'text',
    title: titleFromText(text, 'Text'),
    description: '',
    x: at.x,
    y: at.y,
    text,
  })
  if (trimmed.length > MAX_TEXT_CHARS) showStatus('That text was shortened to fit in this browser.')
}

function placeLink(url: string, at: Point) {
  const href = url.trim()
  if (!isHttpUrl(href)) return
  addItem({
    id: uid(),
    kind: 'link',
    title: hostnameFromUrl(href).slice(0, MAX_TITLE_CHARS),
    description: '',
    x: at.x,
    y: at.y,
    text: href,
  })
}

function addItem(item: BoardItem) {
  items.push(item)
  mountItem(item)
  selectItem(item.id)
  syncEmpty()
  flushSave()
}

function mountItem(item: BoardItem) {
  const article = document.createElement('article')
  article.className = 'card'
  article.dataset.id = item.id
  article.style.width = `${CARD_WIDTH}px`
  article.style.left = `${item.x}px`
  article.style.top = `${item.y}px`
  article.draggable = false
  article.setAttribute('role', 'group')
  article.setAttribute('aria-label', item.title || kindLabel(item.kind))

  const content = document.createElement('div')
  content.className = 'card-content'
  content.append(renderContent(item))

  const title = document.createElement('input')
  title.className = 'title'
  title.type = 'text'
  title.value = item.title
  title.placeholder = 'Title'
  title.ariaLabel = 'Title'
  title.autocomplete = 'off'
  title.spellcheck = false
  title.maxLength = MAX_TITLE_CHARS
  title.addEventListener('click', () => title.select())
  title.addEventListener('input', () => {
    item.title = title.value
    article.setAttribute('aria-label', item.title || kindLabel(item.kind))
    scheduleSave()
  })
  title.addEventListener('blur', flushSave)

  const description = document.createElement('textarea')
  description.className = 'description'
  description.value = item.description
  description.placeholder = 'Description'
  description.ariaLabel = 'Description'
  description.rows = 2
  description.maxLength = MAX_DESCRIPTION_CHARS
  description.addEventListener('input', () => {
    item.description = description.value
    fitDescription(description)
    scheduleSave()
  })
  description.addEventListener('blur', flushSave)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'remove'
  remove.setAttribute('aria-label', 'Remove item')
  remove.textContent = '×'
  remove.addEventListener('click', (event) => {
    event.stopPropagation()
    removeItem(item.id)
  })

  article.append(labeledField('Title', title), content, labeledField('Description', description), remove)
  itemsRoot.append(article)
  itemElements.set(item.id, article)
  fitDescription(description)
}

function renderContent(item: BoardItem): HTMLElement {
  if (item.kind === 'image') return renderImage(item)
  if (item.kind === 'link') return renderLink(item)
  if (item.kind === 'file') return renderFile(item)
  return renderText(item)
}

function renderText(item: BoardItem): HTMLElement {
  const body = document.createElement('div')
  body.className = 'text-body'
  body.textContent = item.text ?? ''
  return body
}

function renderLink(item: BoardItem): HTMLElement {
  const link = document.createElement('a')
  link.className = 'link-url'
  link.draggable = false
  const url = item.text ?? ''
  if (isHttpUrl(url)) {
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
  }
  link.textContent = url
  return link
}

function renderImage(item: BoardItem): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'image-wrap'
  const src = item.dataUrl && isSafeDataUrl(item.dataUrl, true) ? item.dataUrl : null
  if (!src) {
    wrap.append(note(item.fileName ? `${item.fileName} could not be kept in this browser.` : 'Image could not be kept.'))
    return wrap
  }
  const image = document.createElement('img')
  image.alt = item.fileName || item.title || 'Image'
  image.draggable = false
  image.src = src
  image.addEventListener('error', () => {
    image.remove()
    wrap.append(note('This image could not be shown.'))
  })
  wrap.append(image)
  return wrap
}

function renderFile(item: BoardItem): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'file-block'
  const badge = document.createElement('div')
  badge.className = 'badge'
  badge.textContent = extensionLabel(item.fileName, item.mime)
  const info = document.createElement('div')
  info.className = 'file-info'
  const name = document.createElement('div')
  name.className = 'file-name'
  name.textContent = item.fileName || item.title || 'File'
  const meta = document.createElement('div')
  meta.className = 'file-meta'
  meta.textContent = [item.mime || 'File', formatBytes(item.fileSize)].filter(Boolean).join(' · ')
  info.append(name, meta)
  const src = item.dataUrl && isSafeDataUrl(item.dataUrl) ? item.dataUrl : null
  if (src) {
    const download = document.createElement('a')
    download.className = 'download'
    download.href = src
    download.download = item.fileName || 'download'
    download.textContent = 'Download'
    info.append(download)
  } else {
    info.append(note('Too large to keep the file in this browser.'))
  }
  wrap.append(badge, info)
  return wrap
}

function note(message: string): HTMLParagraphElement {
  const paragraph = document.createElement('p')
  paragraph.className = 'file-note'
  paragraph.textContent = message
  return paragraph
}

let stackOrder = 1

function selectItem(id: string) {
  selectedItemId = id
  selectedStrokeId = null
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0 && index < items.length - 1) {
    const [item] = items.splice(index, 1)
    items.push(item)
  }
  const element = itemElements.get(id)
  if (element) element.style.zIndex = String(++stackOrder)
  syncSelection()
}

function labeledField(caption: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label')
  label.className = 'field'
  const span = document.createElement('span')
  span.className = 'field-caption'
  span.textContent = caption
  label.append(span, control)
  return label
}

function selectStroke(id: string) {
  selectedStrokeId = id
  selectedItemId = null
  syncSelection()
}

function clearSelection() {
  selectedItemId = null
  selectedStrokeId = null
  syncSelection()
}

function syncSelection() {
  for (const [id, element] of itemElements) {
    element.classList.toggle('selected', id === selectedItemId)
  }
  for (const path of ink.querySelectorAll<SVGPathElement>('path[data-id]')) {
    path.classList.toggle('selected', path.dataset.id === selectedStrokeId)
  }
}

function removeSelected() {
  if (selectedItemId) removeItem(selectedItemId)
  else if (selectedStrokeId) removeStroke(selectedStrokeId)
}

function removeItem(id: string) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return
  items.splice(index, 1)
  itemElements.get(id)?.remove()
  itemElements.delete(id)
  if (selectedItemId === id) selectedItemId = null
  syncEmpty()
  flushSave()
}

function removeStroke(id: string) {
  const index = strokes.findIndex((stroke) => stroke.id === id)
  if (index < 0) return
  strokes.splice(index, 1)
  ink.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove()
  if (selectedStrokeId === id) selectedStrokeId = null
  syncEmpty()
  flushSave()
}

function appendStrokePath(stroke: Stroke) {
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', pathFromPoints(stroke.points))
  path.dataset.id = stroke.id
  path.classList.add('stroke')
  if (stroke.id === selectedStrokeId) path.classList.add('selected')
  ink.append(path)
}

function ensureLive(): SVGPathElement {
  if (!livePath) {
    livePath = document.createElementNS(SVG_NS, 'path')
    livePath.classList.add('stroke', 'live')
    ink.append(livePath)
  }
  return livePath
}

function clearLive() {
  livePath?.remove()
  livePath = null
}

function syncEmpty() {
  empty.hidden = strokes.length > 0 || items.length > 0
}

function scheduleSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushSave, 200)
}

function flushSave() {
  window.clearTimeout(saveTimer)
  saveTimer = 0
  const result = saveBoard(localStorage, { camera, strokes, items })
  if (result === 'full') {
    if (!quotaWarned) {
      quotaWarned = true
      showStatus('This browser is out of space, so the latest change could not be saved.')
    }
    return
  }
  quotaWarned = false
}

function showStatus(message: string) {
  status.textContent = message
  status.dataset.show = 'true'
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    status.dataset.show = 'false'
  }, 4600)
}

function pointerWorld(): Point {
  const client = pointerSeen ? lastClient : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  return screenToWorld(client.x, client.y, camera)
}

function originFor(point: Point, index: number): Point {
  return placeOrigin(
    point,
    index,
    items.map((item) => ({ x: item.x, y: item.y })),
  )
}

function pointerPair(): [Point, Point] | null {
  const values = [...pointers.values()]
  if (values.length < 2) return null
  return [values[0], values[1]]
}

function capture(event: PointerEvent) {
  try {
    viewport.setPointerCapture(event.pointerId)
  } catch {
    // The pointer can already be gone.
  }
}

function blurField() {
  const active = document.activeElement
  if (active instanceof HTMLElement && isTypingTarget(active)) active.blur()
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const field = target.closest('input, textarea')
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? !field.readOnly && !field.disabled
    : false
}

function scrollableField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const box = target.closest('textarea, .text-body')
  return box instanceof HTMLElement && box.scrollHeight > box.clientHeight + 1
}

function wheelPixels(event: WheelEvent): Point {
  let x = event.deltaX
  let y = event.deltaY
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    x *= 16
    y *= 16
  } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    x *= viewport.clientWidth
    y *= viewport.clientHeight
  }
  return { x, y }
}

function fitDescription(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto'
  const next = Math.min(180, Math.max(44, textarea.scrollHeight))
  textarea.style.height = `${next}px`
  textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden'
}

async function collectFiles(data: DataTransfer): Promise<File[]> {
  const files: File[] = []
  const seen = new Set<string>()
  const push = (file: File | null) => {
    if (!file) return
    const key = `${file.name}:${file.size}:${file.lastModified}:${file.type}`
    if (seen.has(key)) return
    seen.add(key)
    files.push(file)
  }
  for (const file of Array.from(data.files)) push(file)
  const entries: FileSystemEntry[] = []
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) {
        push(file)
        continue
      }
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }
  }
  for (const entry of entries) {
    push(await fileFromEntry(entry))
  }
  return files
}

function fileFromEntry(entry: FileSystemEntry): Promise<File | null> {
  if (!entry.isFile) return Promise.resolve(null)
  return new Promise((resolve) => {
    ;(entry as FileSystemFileEntry).file(
      (file) => resolve(file),
      () => resolve(null),
    )
  })
}

function ensureType(file: File): File {
  if (file.type) return file
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const mime = EXT_MIME[ext] ?? 'application/octet-stream'
  return new File([file], file.name, { type: mime, lastModified: file.lastModified })
}

function imageTitle(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return base || 'Image'
}

function extensionLabel(fileName: string | undefined, mime: string | undefined): string {
  const ext = fileName?.includes('.') ? (fileName.split('.').pop() ?? '') : ''
  const clean = ext.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase()
  if (clean) return clean
  const sub = mime?.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase()
  return sub || 'FILE'
}

function kindLabel(kind: ItemKind): string {
  if (kind === 'image') return 'Image'
  if (kind === 'file') return 'File'
  if (kind === 'link') return 'Link'
  return 'Text'
}

function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read the file'))
    }
    reader.readAsDataURL(file)
  })
}

async function imageFileToDataUrl(file: File): Promise<string> {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml' || file.size <= 450_000) {
    return readAsDataUrl(file)
  }
  try {
    const scaled = await downscaleImage(file)
    return scaled.length <= MAX_DATA_URL_CHARS ? scaled : readAsDataUrl(file)
  } catch {
    return readAsDataUrl(file)
  }
}

async function downscaleImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not draw the image')
    context.drawImage(bitmap, 0, 0, width, height)
    const keepPng = file.type === 'image/png' && width * height < 700_000
    return keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    bitmap.close()
  }
}

function roundPoint(point: Point): Point {
  return {
    x: Math.round(point.x * 100) / 100,
    y: Math.round(point.y * 100) / 100,
  }
}

function uid(): string {
  return crypto.randomUUID()
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function must<T extends Element>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as unknown as T
}
