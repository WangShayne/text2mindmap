/**
 * Renderer-agnostic mind map interface. The app only talks to this interface and to the
 * Markdown <-> outline functions in src/shared/outline.ts, so the renderer
 * (simple-mind-map today) can be swapped, e.g. for mind-elixir, by writing another adapter.
 */
import type { OutlineNode } from '../../../shared/outline'
import type { MapStyle } from '../../../shared/mapStyle'

export type ExportFormat = 'png' | 'svg' | 'pdf' | 'xmind'

export interface Selection {
  /** child indices from the root, [] = root */
  indices: number[]
  /** node texts from the root to the selected node */
  texts: string[]
}

export type MapCommand = 'addChild' | 'addSibling' | 'remove' | 'undo' | 'redo' | 'fit' | 'expandAll' | 'collapseAll' | 'zoomIn' | 'zoomOut'

export interface MindMapAdapter {
  /** Render the outline. `reset` = new document (clear undo history, fit view). */
  setOutline(tree: OutlineNode, opts?: { reset?: boolean }): void
  /** Current outline as shown on the map. */
  getOutline(): OutlineNode
  /** Called after the user changes the map (rename, add, delete, drag, undo…). */
  onChange(cb: (tree: OutlineNode) => void): () => void
  onSelect(cb: (sel: Selection | null) => void): () => void
  getSelection(): Selection | null
  command(cmd: MapCommand): void
  readonly exportFormats: ExportFormat[]
  exportAs(format: ExportFormat, fileName: string): Promise<void>
  /** Colour theme and layout; also used by image exports. */
  setStyle(style: MapStyle): void
  resize(): void
  destroy(): void
}

export type AdapterFactory = (el: HTMLElement, style?: MapStyle) => MindMapAdapter
