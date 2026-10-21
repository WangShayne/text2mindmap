// Regenerates wav.mjs (plain JS copy of src/shared/wav.ts) so the bench runs with any Node >= 18
// and no TypeScript tooling. tests/asr-bench.test.ts fails if the copy is out of date.
import { buildSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export function compileWav() {
  const r = buildSync({ entryPoints: [path.join(here, '../../src/shared/wav.ts')], bundle: false, format: 'esm', target: 'node18', write: false, legalComments: 'none' })
  return '// GENERATED from src/shared/wav.ts by scripts/asr-bench/build-wav.mjs. Do not edit.\n' + r.outputFiles[0].text
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.writeFileSync(path.join(here, 'wav.mjs'), compileWav())
  console.log('wrote scripts/asr-bench/wav.mjs')
}
