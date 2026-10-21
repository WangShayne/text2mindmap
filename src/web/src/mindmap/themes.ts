/** simple-mind-map theme configs for the themes listed in shared/mapStyle.ts (registered with MindMap.defineTheme). */
import type { MapTheme } from '../../../shared/mapStyle'

const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

function palette(p: { bg: string; line: string; rootFill: string; rootColor: string; secondFill: string; secondColor: string; secondBorder: string; nodeColor: string; lineWidth?: number; borderRadius?: number }) {
  const r = p.borderRadius ?? 6
  return {
    backgroundColor: p.bg,
    lineColor: p.line,
    lineWidth: p.lineWidth ?? 2,
    generalizationLineColor: p.line,
    root: { fillColor: p.rootFill, color: p.rootColor, fontSize: 20, fontWeight: 'bold', borderWidth: 0, borderColor: 'transparent', borderRadius: r, fontFamily: FONT, hoverRectColor: p.line },
    second: { fillColor: p.secondFill, color: p.secondColor, borderColor: p.secondBorder, borderWidth: 1, fontSize: 16, borderRadius: r, fontFamily: FONT, hoverRectColor: p.line },
    node: { color: p.nodeColor, fontSize: 14, fontFamily: FONT, hoverRectColor: p.line },
    generalization: { fillColor: p.secondFill, color: p.secondColor, borderColor: p.secondBorder, fontFamily: FONT },
  }
}

export const THEME_CONFIGS: Record<MapTheme, Record<string, unknown>> = {
  light: palette({ bg: '#f8fafc', line: '#94a3b8', rootFill: '#4f46e5', rootColor: '#ffffff', secondFill: '#eef2ff', secondColor: '#1e1b4b', secondBorder: '#c7d2fe', nodeColor: '#1f2937' }),
  dark: palette({ bg: '#0f172a', line: '#475569', rootFill: '#6366f1', rootColor: '#ffffff', secondFill: '#1e293b', secondColor: '#e2e8f0', secondBorder: '#334155', nodeColor: '#cbd5e1' }),
  ocean: palette({ bg: '#f0f9ff', line: '#38bdf8', rootFill: '#0369a1', rootColor: '#ffffff', secondFill: '#e0f2fe', secondColor: '#0c4a6e', secondBorder: '#7dd3fc', nodeColor: '#164e63' }),
  forest: palette({ bg: '#f7fbf4', line: '#84cc16', rootFill: '#3f6212', rootColor: '#ffffff', secondFill: '#ecfccb', secondColor: '#1a2e05', secondBorder: '#bef264', nodeColor: '#365314' }),
  sunset: palette({ bg: '#fff7ed', line: '#fb923c', rootFill: '#c2410c', rootColor: '#ffffff', secondFill: '#ffedd5', secondColor: '#7c2d12', secondBorder: '#fdba74', nodeColor: '#7c2d12' }),
  mono: palette({ bg: '#ffffff', line: '#111827', rootFill: '#111827', rootColor: '#ffffff', secondFill: '#ffffff', secondColor: '#111827', secondBorder: '#111827', nodeColor: '#374151', lineWidth: 1.5, borderRadius: 2 }),
}

export const smmThemeName = (t: MapTheme) => `t2m-${t}`
