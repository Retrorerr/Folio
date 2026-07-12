import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let port = Number(process.env.FOLIO_CDP_PORT || 9222)
let expression = ''

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--port') {
    port = Number(args[++index])
  } else if (args[index] === '--file') {
    expression = readFileSync(args[++index], 'utf8')
  } else {
    expression = args.slice(index).join(' ')
    break
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid DevTools port: ${port}`)
}
if (!expression.trim()) {
  expression = readFileSync(0, 'utf8')
}
if (!expression.trim()) {
  throw new Error('Pass a JavaScript expression or pipe one on stdin')
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`DevTools target list returned ${response.status}`)
  return response.json()
})
const target = targets.find((item) => item.type === 'page') || targets[0]
if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable Android WebView target was found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('Could not connect to the Android WebView')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)))
  else resolve(message.result)
})

function command(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

try {
  await command('Runtime.enable')
  const evaluation = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (evaluation.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text
    throw new Error(detail || 'The WebView expression failed')
  }
  const value = Object.prototype.hasOwnProperty.call(evaluation.result, 'value')
    ? evaluation.result.value
    : evaluation.result.description
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
} finally {
  socket.close()
}
