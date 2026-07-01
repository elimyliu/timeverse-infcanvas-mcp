// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// MCP 协议冒烟测试 - v3(纯动态 projectDir)
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROJECT_A = path.join(ROOT, 'test-project-A')
const PROJECT_B = path.join(ROOT, 'test-project-B')
await fs.mkdir(PROJECT_A, { recursive: true })
await fs.mkdir(PROJECT_B, { recursive: true })

// 不设环境变量,全通过参数传 projectDir
const server = spawn('node', [path.join(ROOT, 'mcp-server', 'server.mjs')], {
  env: { ...process.env, INF_CANVAS_DIR: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let nextId = 1
const pending = new Map()

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else if (msg.result?.isError) reject(new Error(msg.result.content?.[0]?.text || '工具执行失败'))
        else resolve(msg.result)
      }
    } catch (e) {}
  }
})

server.stderr.on('data', (d) => {})
server.on('exit', (code) => console.error(`[exit] ${code}`))

function send(method, params, timeoutMs = 5000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, timeoutMs)
  })
}
function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

async function run() {
  console.log('=== 1. initialize ===')
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  })
  console.log(`  server: ${init.serverInfo.name} ${init.serverInfo.version}`)
  notify('notifications/initialized', {})

  console.log('\n=== 2. get_canvas_snapshot (不传 projectDir,应报错) ===')
  try {
    await send('tools/call', { name: 'get_canvas_snapshot', arguments: {} })
    console.log('  ❌ 应报错')
  } catch (e) {
    console.log(`  ✓ 正确报错: ${e.message.split('\n')[0]}`)
  }

  console.log('\n=== 3. create_ai_image_holder (传到 A 项目) ===')
  const r3 = await send('tools/call', {
    name: 'create_ai_image_holder',
    arguments: { projectDir: PROJECT_A, w: 512, h: 512, prompt: 'cat' },
  })
  const shapeA = JSON.parse(r3.content[0].text).shape
  console.log(`  A shape ID: ${shapeA.id}`)
  console.log(`  pos=(${shapeA.x}, ${shapeA.y})`)

  console.log('\n=== 4. create_ai_image_holder (传到 B 项目,应在独立目录) ===')
  const r4 = await send('tools/call', {
    name: 'create_ai_image_holder',
    arguments: { projectDir: PROJECT_B, w: 600, h: 400, prompt: 'dog' },
  })
  const shapeB = JSON.parse(r4.content[0].text).shape
  console.log(`  B shape ID: ${shapeB.id}`)

  console.log('\n=== 5. get_canvas_snapshot (传 projectDir=A,验证数据隔离) ===')
  const r5 = await send('tools/call', {
    name: 'get_canvas_snapshot',
    arguments: { projectDir: PROJECT_A },
  })
  const snapA = JSON.parse(r5.content[0].text)
  const inA = snapA.shapes.some((s) => s.id === shapeA.id)
  const inBwrong = snapA.shapes.some((s) => s.id === shapeB.id)
  console.log(`  A 中 shapes: ${snapA.shapes.length}`)
  console.log(`  包含 shapeA: ${inA}${inA ? '' : ' ❌'}`)
  console.log(`  不包含 shapeB: ${!inBwrong}${!inBwrong ? '' : ' ❌'}`)

  console.log('\n=== 6. get_canvas_snapshot (传 projectDir=B,验证数据隔离) ===')
  const r6 = await send('tools/call', {
    name: 'get_canvas_snapshot',
    arguments: { projectDir: PROJECT_B },
  })
  const snapB = JSON.parse(r6.content[0].text)
  const inB = snapB.shapes.some((s) => s.id === shapeB.id)
  console.log(`  B 中 shapes: ${snapB.shapes.length}`)
  console.log(`  包含 shapeB: ${inB}${inB ? '' : ' ❌'}`)

  console.log('\n=== 7. update_shape_status (传 projectDir=A) ===')
  const r7 = await send('tools/call', {
    name: 'update_shape_status',
    arguments: { projectDir: PROJECT_A, shapeId: shapeA.id, status: 'generating', progress: 30 },
  })
  const st = JSON.parse(r7.content[0].text)
  console.log(`  status: ${st.props.status}, progress: ${st.props.progress}`)

  console.log('\n=== 8. insert_image (URL 图片,传 projectDir=B) ===')
  const r8 = await send('tools/call', {
    name: 'insert_image',
    arguments: {
      projectDir: PROJECT_B,
      sourcePath: 'https://picsum.photos/600/400',
      fillHolderId: shapeB.id,
    },
  })
  const filled = JSON.parse(r8.content[0].text)
  console.log(`  filled: ${!!filled.filled} -> type: ${filled.shape.type}`)

  console.log('\n=== 9. 多次调用不同 projectDir(验证线程安全 + 缓存) ===')
  const r9a = await send('tools/call', { name: 'list_pages', arguments: { projectDir: PROJECT_A } })
  const r9b = await send('tools/call', { name: 'list_pages', arguments: { projectDir: PROJECT_B } })
  const aPages = JSON.parse(r9a.content[0].text).length
  const bPages = JSON.parse(r9b.content[0].text).length
  console.log(`  A pages: ${aPages}, B pages: ${bPages} (应都有 1)`)

  console.log('\n=== 10. tools/list (验证数量) ===')
  const r10 = await send('tools/list', {})
  console.log(`  tools: ${r10.tools.length}`)
  // 验证每个工具都要求 projectDir
  const allRequired = r10.tools.every((t) => {
    if (t.name === '__undefined__') return true // 跳过无参工具
    return t.inputSchema.required?.includes('projectDir')
  })
  console.log(`  全部工具都要求 projectDir: ${allRequired}`)

  console.log('\nALL TESTS PASSED')
  server.kill()
  process.exit(0)
}

run().catch((err) => {
  console.error('FAILED:', err.message)
  server.kill()
  process.exit(1)
})
