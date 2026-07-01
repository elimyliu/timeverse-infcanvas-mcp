#!/usr/bin/env node
// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// InfCanvas Web Server — 提供画布可视化 HTTP 服务
// 默认端口 3000，可通过环境变量 PORT 覆盖

import http from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '3000', 10)

// 从环境变量或 cwd 推断项目目录
const PROJECT_DIR = process.env.INF_CANVAS_DIR
  ? path.resolve(process.env.INF_CANVAS_DIR)
  : process.cwd()

const CANVAS_DIR = path.join(PROJECT_DIR, 'canvas')
const CLIENT_DIR = path.join(__dirname, '..', 'client', 'dist')

// ---------------- MIME 类型 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

// ---------------- 读取画布 JSON 工具函数 ----------------
async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf8')
    return JSON.parse(txt)
  } catch {
    return fallback
  }
}

const SHAPES_DIR = path.join(CANVAS_DIR, 'shapes')

// 从 shapeIndex 读取所有 shape 文件(并行)
async function readAllShapes(shapeIndex) {
  if (!shapeIndex || shapeIndex.length === 0) return []
  const results = await Promise.all(
    shapeIndex.map(id =>
      readJson(path.join(SHAPES_DIR, `${id}.json`), null)
    )
  )
  return results.filter(Boolean)
}

// ---------------- 写回画布数据 ----------------
async function writeCanvasData(snapshot) {
  const { pages = [], shapes = [], assets = [] } = snapshot

  // 写入索引(不含 shapes 内容)
  const idx = {
    version: 1,
    pages,
    shapeIndex: shapes.map(s => s.id),
    assets,
  }
  await writeJsonFile(path.join(CANVAS_DIR, 'canvas.json'), idx)

  // 写入每个 shape 独立文件
  const shapeWrites = shapes.map(s =>
    writeJsonFile(path.join(SHAPES_DIR, `${s.id}.json`), s)
  )
  await Promise.all(shapeWrites)
}

async function writeViewState(vs) {
  await writeJsonFile(path.join(CANVAS_DIR, 'view-state.json'), {
    currentPageId: vs.currentPageId || 'page:default',
    cameraX: vs.cameraX || 0,
    cameraY: vs.cameraY || 0,
    cameraZ: vs.cameraZ || 1,
  })
}

async function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, filePath)
}

// ---------------- 路由处理 ----------------
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  try {
    // ---- API: 快照 ----
    if (pathname === '/api/snapshot') {
      const idx = await readJson(path.join(CANVAS_DIR, 'canvas.json'), {
        version: 1, pages: [], shapeIndex: [], assets: [],
      })
      // 新格式: shapeIndex 存在且 shapes 为空 → 从独立文件读取
      let shapes = idx.shapes || []
      if (idx.shapeIndex && (!idx.shapes || idx.shapes.length === 0)) {
        shapes = await readAllShapes(idx.shapeIndex)
      }
      const snap = { ...idx, shapes, shapeIndex: undefined }
      delete snap.shapeIndex
      const viewState = await readJson(path.join(CANVAS_DIR, 'view-state.json'), {
        currentPageId: snap.pages?.[0]?.id || 'page:default',
        cameraX: 0, cameraY: 0, cameraZ: 1,
      })
      const selection = await readJson(path.join(CANVAS_DIR, 'selection.json'), {
        shapeIds: [], boundingBox: null, pageId: snap.pages?.[0]?.id,
      })
      return json(res, { snapshot: snap, viewState, selection })
    }

    // ---- API: 保存(编辑后写回) ----
    if (pathname === '/api/save' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const { snapshot, viewState } = body
      if (snapshot) await writeCanvasData(snapshot)
      if (viewState) await writeViewState(viewState)
      return json(res, { ok: true })
    }

    // ---- API: 资源文件(assets) ----
    if (pathname.startsWith('/api/assets/')) {
      const relativePath = pathname.slice('/api/assets/'.length)
      const filePath = path.join(CANVAS_DIR, 'pages', relativePath)
      return serveFile(res, filePath)
    }

    // ---- API: 健康检查 ----
    if (pathname === '/api/health') {
      return json(res, { ok: true, projectDir: PROJECT_DIR })
    }

    // ---- 静态文件(仅从 client/dist 提供) ----
    const servePath = pathname === '/' ? '/index.html' : pathname
    const filePath = path.join(CLIENT_DIR, servePath)
    const resolvedPath = path.resolve(filePath)

    if (!resolvedPath.startsWith(CLIENT_DIR)) {
      return sendStatus(res, 403, 'Forbidden')
    }

    await serveFile(res, resolvedPath)
  } catch (err) {
    console.error('[web-server]', err.message)
    if (!res.headersSent) {
      sendStatus(res, 500, 'Internal Server Error')
    }
  }
}

async function serveFile(res, filePath) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      return sendStatus(res, 404, 'Not Found')
    }
    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME[ext] || 'application/octet-stream'
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': content.length })
    res.end(content)
  } catch (err) {
    if (err.code === 'ENOENT') return sendStatus(res, 404, 'Not Found')
    throw err
  }
}

function json(res, data) {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

async function sendStatus(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(msg)
}

// ---------------- 启动 ----------------
const server = http.createServer(handleRequest)

server.listen(PORT, () => {
  console.log(`\n  🎨 InfCanvas Web Server`)
  console.log(`  ─────────────────────────`)
  console.log(`  URL:      http://localhost:${PORT}`)
  console.log(`  项目目录: ${PROJECT_DIR}`)
  console.log(`  画布目录: ${CANVAS_DIR}`)
  console.log(`  端口:     ${PORT}\n`)
})
