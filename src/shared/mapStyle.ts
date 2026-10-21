/**
 * Mind map look: colour theme and layout (structure). Stored per user (users.prefs) and applied to
 * every document. Shared by the server (validation) and the browser (picker + renderer).
 */
export const MAP_THEMES = ['light', 'dark', 'ocean', 'forest', 'sunset', 'mono'] as const
export type MapTheme = (typeof MAP_THEMES)[number]

/** simple-mind-map layout names. */
export const MAP_LAYOUTS = ['logicalStructure', 'mindMap', 'organizationStructure'] as const
export type MapLayout = (typeof MAP_LAYOUTS)[number]

export interface MapStyle { theme: MapTheme; layout: MapLayout }
export const DEFAULT_MAP_STYLE: MapStyle = { theme: 'light', layout: 'logicalStructure' }

export const isMapTheme = (v: unknown): v is MapTheme => typeof v === 'string' && (MAP_THEMES as readonly string[]).includes(v)
export const isMapLayout = (v: unknown): v is MapLayout => typeof v === 'string' && (MAP_LAYOUTS as readonly string[]).includes(v)

/** Reads a stored or posted value, falling back to the defaults for anything missing or unknown. */
export function normalizeMapStyle(v: unknown): MapStyle {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    theme: isMapTheme(o.theme) ? o.theme : DEFAULT_MAP_STYLE.theme,
    layout: isMapLayout(o.layout) ? o.layout : DEFAULT_MAP_STYLE.layout,
  }
}

/** Swatch colours for the picker: [background, root, branch, line]. Also tells the UI whether the map is dark. */
export const THEME_SWATCH: Record<MapTheme, { bg: string; root: string; branch: string; line: string; dark: boolean }> = {
  light: { bg: '#f8fafc', root: '#4f46e5', branch: '#eef2ff', line: '#94a3b8', dark: false },
  dark: { bg: '#0f172a', root: '#818cf8', branch: '#1e293b', line: '#475569', dark: true },
  ocean: { bg: '#f0f9ff', root: '#0369a1', branch: '#e0f2fe', line: '#38bdf8', dark: false },
  forest: { bg: '#f7fbf4', root: '#3f6212', branch: '#ecfccb', line: '#84cc16', dark: false },
  sunset: { bg: '#fff7ed', root: '#c2410c', branch: '#ffedd5', line: '#fb923c', dark: false },
  mono: { bg: '#ffffff', root: '#111827', branch: '#ffffff', line: '#111827', dark: false },
}
