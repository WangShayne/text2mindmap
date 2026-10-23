import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation.js'
import Export from 'simple-mind-map/src/plugins/Export.js'
import ExportPDF from 'simple-mind-map/src/plugins/ExportPDF.js'
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind.js'
import type { OutlineNode } from '../../../shared/outline'
import { outlineToSmm, smmToOutline, type SmmNode } from '../../../shared/smm'
import { DEFAULT_MAP_STYLE, MAP_THEMES, type MapStyle } from '../../../shared/mapStyle'
import { THEME_CONFIGS, smmThemeName } from './themes'
import type { AdapterFactory, ExportFormat, FlashKind, MapCommand, MindMapAdapter, Selection } from './adapter'

/** Image/file formats this renderer exports in the browser (known before the map is created). */
export const SMM_EXPORT_FORMATS: ExportFormat[] = ['png', 'svg', 'pdf', 'xmind']

let pluginsRegistered = false
function registerPlugins() {
  if (pluginsRegistered) return
  pluginsRegistered = true
  const M = MindMap as any
  for (const t of MAP_THEMES) M.defineTheme(smmThemeName(t), THEME_CONFIGS[t])
  M.usePlugin(Drag).usePlugin(Select).usePlugin(KeyboardNavigation).usePlugin(ExportPDF).usePlugin(ExportXMind).usePlugin(Export)
}

function findPath(node: SmmNode, uid: string, indices: number[] = [], texts: string[] = []): Selection | null {
  const t = [...texts, String(node.data.text ?? '')]
  if (node.data.uid === uid) return { indices, texts: t }
  const ch = node.children ?? []
  for (let i = 0; i < ch.length; i++) {
    const r = findPath(ch[i], uid, [...indices, i], t)
    if (r) return r
  }
  return null
}

/** Copies `expand: false` onto nodes that kept their path and text, so an update does not reopen them. */
function keepCollapsed(prev: SmmNode, next: SmmNode) {
  if (prev.data.text !== next.data.text) return
  if (prev.data.expand === false) next.data.expand = false
  const a = prev.children ?? [], b = next.children ?? []
  for (let i = 0; i < Math.min(a.length, b.length); i++) keepCollapsed(a[i], b[i])
}

const FLASH_MS: Record<FlashKind, number> = { added: 1500, updated: 1000, focus: 1500 }

export const createSimpleMindMap: AdapterFactory = (el, initialStyle = DEFAULT_MAP_STYLE) => {
  registerPlugins()
  // simple-mind-map refuses a container without size; give it one until layout settles.
  const r = el.getBoundingClientRect()
  const sized = r.width > 0 && r.height > 0
  if (!sized) { el.style.minWidth = '100px'; el.style.minHeight = '100px' }
  const mm: any = new (MindMap as any)({
    el,
    data: outlineToSmm({ text: '', kind: 'heading', children: [] }),
    layout: initialStyle.layout,
    theme: smmThemeName(initialStyle.theme),
    readonly: false,
    fit: true,
    mousewheelAction: 'zoom',
    mouseScaleCenterUseMousePosition: true,
    exportPaddingX: 40,
    exportPaddingY: 40,
    addHistoryTime: 50,
    // Keep only features that Markdown can represent.
    enableFreeDrag: false,
    isShowCreateChildBtnIcon: true,
  })
  if (!sized) { el.style.minWidth = ''; el.style.minHeight = '' }
  // Generalizations (Ctrl+G) cannot be expressed in Markdown.
  mm.keyCommand.removeShortcut('Control+g')

  // Clicking the map should give it keyboard focus (and take it away from the editor).
  const onDown = () => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && !el.contains(a)) a.blur() }
  el.addEventListener('mousedown', onDown, true)

  const changeCbs = new Set<(t: OutlineNode) => void>()
  const selectCbs = new Set<(s: Selection | null) => void>()
  const clickCbs = new Set<(indices: number[]) => void>()
  let selection: Selection | null = null

  mm.on('data_change', (data: SmmNode) => {
    if (!data) return
    const tree = smmToOutline(data)
    changeCbs.forEach((cb) => cb(tree))
  })
  mm.on('node_active', (_node: any, list: any[]) => {
    const node = list?.[0]
    selection = node ? findPath(mm.getData(false), node.getData('uid')) : null
    selectCbs.forEach((cb) => cb(selection))
  })

  mm.on('node_click', (node: any) => {
    const sel = findPath(mm.getData(false), node.getData('uid'))
    if (sel) clickCbs.forEach((cb) => cb(sel.indices))
  })

  const nodeAt = (indices: number[]) => {
    let n = mm.renderer.root
    for (const i of indices) n = n?.children?.[i]
    return n
  }
  // Flashes requested while a render is pending wait for it, so the new nodes exist.
  let renderPending = false
  let queued: Array<() => void> = []
  mm.on('node_tree_render_end', () => {
    renderPending = false
    const q = queued
    queued = []
    q.forEach((fn) => fn())
  })
  const whenRendered = (fn: () => void) => {
    if (!renderPending) return fn()
    queued.push(fn)
    // Identical data may not re-render; do not hold the highlight forever.
    setTimeout(() => { if (queued.includes(fn)) { queued = queued.filter((f) => f !== fn); fn() } }, 1000)
  }
  const flashNow = (paths: number[][], kind: FlashKind) => {
    for (const p of paths) {
      const g: SVGElement | undefined = nodeAt(p)?.group?.node
      if (!g) continue
      const cls = `node-flash-${kind}`
      g.classList.remove(cls)
      void g.getBoundingClientRect() // restart the animation
      g.classList.add(cls)
      setTimeout(() => g.classList.remove(cls), FLASH_MS[kind])
    }
  }

  let destroyed = false
  const safe = (fn: () => void) => { if (destroyed || !el.isConnected || !el.clientWidth || !el.clientHeight) return; try { fn() } catch (e) { console.warn(e) } }
  const ro = new ResizeObserver(() => safe(() => mm.resize()))
  ro.observe(el)

  let style: MapStyle = { ...initialStyle }
  // A layout switch re-renders asynchronously; fit once that render has finished.
  let fitAfterRender = false
  mm.on('node_tree_render_end', () => { if (fitAfterRender) { fitAfterRender = false; safe(() => mm.view.fit()) } })

  const adapter: MindMapAdapter = {
    setOutline(tree, opts) {
      const data = outlineToSmm(tree)
      if (opts?.reset) {
        mm.setData(data)
        selection = null
        selectCbs.forEach((cb) => cb(null))
        setTimeout(() => safe(() => mm.view.fit()), 50)
      } else {
        keepCollapsed(mm.getData(false), data)
        renderPending = true
        mm.updateData(data)
      }
    },
    setReadonly(on) { mm.setMode(on ? 'readonly' : 'edit') },
    flash(paths, kind) { whenRendered(() => flashNow(paths, kind)) },
    onNodeClick(cb) { clickCbs.add(cb); return () => clickCbs.delete(cb) },
    reveal(indices) {
      whenRendered(() => {
        const g: SVGElement | undefined = nodeAt(indices)?.group?.node
        if (!g) return
        const n = g.getBoundingClientRect(), box = el.getBoundingClientRect(), m = 40
        // Smallest pan that brings the node inside the view; the zoom is left alone.
        const dx = n.left < box.left + m ? box.left + m - n.left : n.right > box.right - m ? box.right - m - n.right : 0
        const dy = n.top < box.top + m ? box.top + m - n.top : n.bottom > box.bottom - m ? box.bottom - m - n.bottom : 0
        if (dx || dy) mm.view.translateXY(dx, dy)
        flashNow([indices], 'focus')
      })
    },
    getViewState() {
      const collapsed: number[][] = []
      const walk = (n: SmmNode, p: number[]) => { if (n.data.expand === false) collapsed.push(p); (n.children ?? []).forEach((c, i) => walk(c, [...p, i])) }
      walk(mm.getData(false), [])
      const v = mm.view
      return { transform: { scaleX: v.scale, translateX: v.x, translateY: v.y }, collapsed }
    },
    getOutline() { return smmToOutline(mm.getData(false)) },
    onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb) },
    onSelect(cb) { selectCbs.add(cb); return () => selectCbs.delete(cb) },
    getSelection() { return selection },
    command(cmd: MapCommand) {
      switch (cmd) {
        case 'addChild': mm.execCommand('INSERT_CHILD_NODE'); break
        case 'addSibling': mm.execCommand('INSERT_NODE'); break
        case 'remove': mm.execCommand('REMOVE_NODE'); break
        case 'undo': mm.execCommand('BACK'); break
        case 'redo': mm.execCommand('FORWARD'); break
        case 'fit': safe(() => mm.view.fit()); break
        case 'expandAll': mm.execCommand('EXPAND_ALL'); break
        case 'collapseAll': mm.execCommand('UNEXPAND_ALL'); break
        case 'zoomIn': mm.view.enlarge(); break
        case 'zoomOut': mm.view.narrow(); break
      }
    },
    exportFormats: SMM_EXPORT_FORMATS,
    async exportAs(format, fileName) {
      // png/pdf: (name, transparent=false); svg: (name); xmind: (name)
      await mm.export(format, true, fileName, false)
    },
    setStyle(next) {
      if (next.theme !== style.theme) mm.setTheme(smmThemeName(next.theme))
      if (next.layout !== style.layout) {
        fitAfterRender = true
        mm.setLayout(next.layout)
      }
      style = { ...next }
    },
    resize() { safe(() => mm.resize()) },
    destroy() {
      destroyed = true
      ro.disconnect()
      queued = []
      el.removeEventListener('mousedown', onDown, true)
      mm.destroy()
    },
  }
  return adapter
}
