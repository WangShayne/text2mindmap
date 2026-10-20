import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation.js'
import Export from 'simple-mind-map/src/plugins/Export.js'
import ExportPDF from 'simple-mind-map/src/plugins/ExportPDF.js'
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind.js'
import type { OutlineNode } from '../../../shared/outline'
import { outlineToSmm, smmToOutline, type SmmNode } from '../../../shared/smm'
import type { AdapterFactory, ExportFormat, MapCommand, MindMapAdapter, Selection } from './adapter'

let pluginsRegistered = false
function registerPlugins() {
  if (pluginsRegistered) return
  pluginsRegistered = true
  const M = MindMap as any
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

export const createSimpleMindMap: AdapterFactory = (el) => {
  registerPlugins()
  // simple-mind-map refuses a container without size; give it one until layout settles.
  const r = el.getBoundingClientRect()
  const sized = r.width > 0 && r.height > 0
  if (!sized) { el.style.minWidth = '100px'; el.style.minHeight = '100px' }
  const mm: any = new (MindMap as any)({
    el,
    data: outlineToSmm({ text: '', kind: 'heading', children: [] }),
    layout: 'logicalStructure',
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
    themeConfig: {
      backgroundColor: 'transparent',
      lineColor: '#94a3b8',
      lineWidth: 2,
      root: { fillColor: '#4f46e5', color: '#ffffff', fontSize: 20, borderWidth: 0, fontWeight: 'bold' },
      second: { fillColor: '#eef2ff', color: '#1e1b4b', borderColor: '#c7d2fe', borderWidth: 1, fontSize: 16 },
      node: { color: '#1f2937', fontSize: 14 },
    },
  })
  if (!sized) { el.style.minWidth = ''; el.style.minHeight = '' }
  // Generalizations (Ctrl+G) cannot be expressed in Markdown.
  mm.keyCommand.removeShortcut('Control+g')

  // Clicking the map should give it keyboard focus (and take it away from the editor).
  const onDown = () => { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && !el.contains(a)) a.blur() }
  el.addEventListener('mousedown', onDown, true)

  const changeCbs = new Set<(t: OutlineNode) => void>()
  const selectCbs = new Set<(s: Selection | null) => void>()
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

  let destroyed = false
  const safe = (fn: () => void) => { if (destroyed || !el.isConnected || !el.clientWidth || !el.clientHeight) return; try { fn() } catch (e) { console.warn(e) } }
  const ro = new ResizeObserver(() => safe(() => mm.resize()))
  ro.observe(el)

  const adapter: MindMapAdapter = {
    setOutline(tree, opts) {
      const data = outlineToSmm(tree)
      if (opts?.reset) {
        mm.setData(data)
        selection = null
        selectCbs.forEach((cb) => cb(null))
        setTimeout(() => safe(() => mm.view.fit()), 50)
      } else {
        mm.updateData(data)
      }
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
    exportFormats: ['png', 'svg', 'pdf', 'xmind'] as ExportFormat[],
    async exportAs(format, fileName) {
      // png/pdf: (name, transparent=false); svg: (name); xmind: (name)
      await mm.export(format, true, fileName, false)
    },
    resize() { safe(() => mm.resize()) },
    destroy() {
      destroyed = true
      ro.disconnect()
      el.removeEventListener('mousedown', onDown, true)
      mm.destroy()
    },
  }
  return adapter
}
