// Wire protocol between the browser and /api/realtime (our own small protocol; provider dialects are
// translated on the server). Shared by the server proxy and the browser client.
//
// Browser -> server: binary frames = PCM16 LE, 16 kHz, mono (about 100 ms each);
//                    text {"type":"stop"} (end of audio, flush the last segment), {"type":"ping"}.
// Server -> browser: {"type":"ready"} | {"type":"partial","seg":n,"text":"…"} (whole current hypothesis
//                    of segment n, replaces the previous one) | {"type":"final","seg":n,"text":"…"} |
//                    {"type":"error","code":"…","message":"…"} | {"type":"done"} | {"type":"pong"}.
//                    partial / final carry audioEnd: seconds of audio the server had received from the
//                    browser when the event arrived (an upper bound of the audio the text covers), so the
//                    browser can line captions up with its own audio timeline.

export const REALTIME_PATH = '/api/realtime'
export const REALTIME_SAMPLE_RATE = 16_000
/** 100 ms of PCM16 mono at 16 kHz. */
export const REALTIME_FRAME_SAMPLES = 1600
/** Largest binary frame the server accepts. */
export const REALTIME_MAX_FRAME_BYTES = 64 * 1024

export type RealtimeServerEvent =
  | { type: 'ready' }
  | { type: 'partial'; seg: number; text: string; audioEnd?: number }
  | { type: 'final'; seg: number; text: string; audioEnd?: number }
  | { type: 'error'; code: RealtimeErrorCode; message?: string }
  | { type: 'done' }
  | { type: 'pong' }

export type RealtimeErrorCode = 'idle' | 'busy' | 'too_long' | 'unavailable' | 'upstream' | 'not_configured' | 'bad_request'

/** WebSocket close codes used by /api/realtime (and forwarded from the upstream). */
export const CLOSE = {
  normal: 1000,
  /** Idle timeout (no audio for a while), from us or from the upstream ("going away"). */
  idle: 1001,
  /** Too many realtime sessions (ours or the upstream's --max-connections). */
  busy: 1008,
  /** Session too long / frame too large. */
  tooLong: 1009,
  /** Upstream unreachable or failed. */
  upstream: 1011,
  /** Realtime ASR is not configured. */
  notConfigured: 4404,
  /** This user opened a newer realtime session (e.g. another tab). */
  replaced: 4409,
} as const

/** Why live captions stopped, for the user-facing hint. null = a normal end. */
export type DegradeReason = 'idle' | 'busy' | 'too_long' | 'unavailable'

/** Maps a close code seen by the browser to a degrade reason. 1006 (abnormal) and anything unknown is "unavailable". */
export function classifyClose(code: number): DegradeReason | null {
  if (code === CLOSE.normal) return null
  if (code === CLOSE.idle) return 'idle'
  if (code === CLOSE.busy || code === 1013) return 'busy'
  if (code === CLOSE.tooLong) return 'too_long'
  return 'unavailable'
}
