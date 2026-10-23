/**
 * Node <-> slice linking for the three precision grades (docs/v0.5-ui-states.md §2):
 * `slice` = exact slices, `section` = the whole section, no ref = summary node with no slice.
 */
import { pathKey, type NodeRef } from '../../../shared/transcript'
import { fmtClock } from '../audio/useTranscriber'

export type Precision = NodeRef['precision'] | 'none'

export function refForNode(refs: NodeRef[], indices: number[]): NodeRef | undefined {
  const k = pathKey(indices)
  return refs.find((r) => pathKey(r.path) === k && r.sliceIds.length > 0)
}

export const precisionOf = (ref: NodeRef | undefined): Precision => ref?.precision ?? 'none'

export const fmtRange = (r: [number, number]) => `${fmtClock(r[0])} - ${fmtClock(r[1])}`

/**
 * The node for a clicked slice: the deepest exact (`slice`) ref that contains it, else the
 * shallowest `section` ref (the section branch, not one of its leaves).
 */
export function nodeForSlice(refs: NodeRef[], sliceId: string): NodeRef | undefined {
  const hits = refs.filter((r) => r.sliceIds.includes(sliceId))
  const exact = hits.filter((r) => r.precision === 'slice').sort((a, b) => b.path.length - a.path.length)
  if (exact.length) return exact[0]
  return hits.sort((a, b) => a.path.length - b.path.length)[0]
}
