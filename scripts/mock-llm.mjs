// A tiny OpenAI-compatible mock server for tests and smoke checks.
// Usage: node scripts/mock-llm.mjs [port]   (key: sk-test-secret, model: mock-model)
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const MOCK_KEY = 'sk-test-secret'
export const MOCK_MODEL = 'mock-model'

function outlineFor(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const title = (paras[0] ?? 'Outline').split(/[。.!?！？\n]/)[0].slice(0, 30)
  let md = `# ${title}\n\n`
  paras.slice(0, 12).forEach((p, i) => {
    const sentences = p.split(/(?<=[。.!?！？])/).map((s) => s.trim()).filter(Boolean)
    md += `## ${(sentences[0] ?? p).slice(0, 24)}\n`
    sentences.slice(1, 4).forEach((s) => { md += `- ${s.slice(0, 40)}\n  - detail ${i + 1}\n` })
    if (sentences.length < 2) md += `- point ${i + 1}\n`
    md += '\n'
  })
  return md
}

export function startMockLlm(port = 0) {
  const calls = []
  const counters = new Map()
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${MOCK_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL }, { id: 'other-model' }] }))
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('not found') }
    let body = ''
    for await (const c of req) body += c
    const j = JSON.parse(body)
    calls.push(j)
    if (j.model !== MOCK_MODEL) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `The model \`${j.model}\` does not exist`, code: 'model_not_found' } }))
    }
    const sys = j.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = j.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    let answer
    const n = (counters.get(user) ?? 0) + 1
    counters.set(user, n)
    if (user.includes('ALWAYS_PROSE')) answer = 'Sure! Here is a summary of the text. It talks about many things.\nI hope this helps.'
    else if (user.includes('PROSE_ONCE') && n === 1) answer = 'Here is your outline:\nThe text is about testing.\nIt has several parts.'
    else if (sys.includes('expand one node')) answer = '- 新子节点一\n  - 细节 A\n- 新子节点二\n- New child three'
    else if (user.includes('Reply with: ok')) answer = 'ok'
    else if (user.includes('Below are Markdown outlines')) answer = '```markdown\n# Merged outline\n' + user.split('\n').filter((l) => /^#{1}\s/.test(l)).map((l) => '## ' + l.slice(2) + '\n- merged point').join('\n') + '\n```'
    else answer = '<think>planning…</think>' + outlineFor(user.replace(/^This is part[^\n]*\n\n---\n\n/, ''))
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const pieces = answer.match(/[\s\S]{1,7}/g) ?? []
    let closed = false
    req.on('close', () => { closed = true })
    res.on('close', () => { closed = true })
    const delay = user.includes('SLOW') ? 200 : 2
    for (const p of pieces) {
      if (closed) { calls.push({ aborted: true }); return }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      await new Promise((r) => setTimeout(r, delay))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => server.listen(port, process.env.MOCK_HOST ?? '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) })))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 4010)
  startMockLlm(port).then(({ url }) => console.log(`mock LLM listening on ${url}`))
}
