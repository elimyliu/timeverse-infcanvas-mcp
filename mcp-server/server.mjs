#!/usr/bin/env node
// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// Timeverse InfCanvas MCP Server - 纯动态项目目录
// projectDir 由 AI 客户端在每次 tool 调用时通过参数传入
// 绝不粘性,不设"当前目录"概念,调用时没有 projectDir 就报错
//
// 传入方式(优先级):
//   1. tool 参数的 projectDir 字段(每次调用传,完全动态)
//   2. 环境变量 INF_CANVAS_DIR(兜底,适合固定项目)
//   3. MCP Roots 协议(少数客户端支持,server 自动检测)
//
// 提示: 工具文档已向 AI 说明"每次调用都传 projectDir"

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CanvasStore } from './canvas-store.mjs'
import { generateImage } from './image-generator.mjs'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

// ---------------- 目录解析 ----------------
const ENV_DIR = process.env.INF_CANVAS_DIR
  ? path.resolve(process.env.INF_CANVAS_DIR)
  : null

let rootsDir = null // 来自 MCP Roots

const ERROR_NO_DIR =
  '缺少 projectDir 参数。用法:\n' +
  '  在每个工具调用的参数里加 projectDir:"/path/to/your/project"\n' +
  '  或在启动 server 时设置环境变量 INF_CANVAS_DIR'

/**
 * 解析最终使用的目录
 * @param {string|undefined} fromArg - 工具调用参数中的 projectDir
 */
function resolveDir(fromArg) {
  if (fromArg) return path.resolve(fromArg)
  if (rootsDir) return rootsDir
  if (ENV_DIR) return ENV_DIR
  return null // 不抛错,让调用方处理
}

// ---------------- Store 工厂(缓存,按目录) ----------------
const storeCache = new Map()

async function getStore(projectDir) {
  const dir = resolveDir(projectDir)
  if (!dir) throw new Error(ERROR_NO_DIR)
  if (!storeCache.has(dir)) {
    const store = new CanvasStore(dir)
    const initPromise = store.init()
    storeCache.set(dir, { store, initPromise })
  }
  const entry = storeCache.get(dir)
  await entry.initPromise
  return entry.store
}

// ---------------- 工具定义 ----------------
// 除 projectDir 外,所有工具定义与之前一致
const TOOLS = [
  {
    name: 'get_canvas_snapshot',
    description:
      '获取画布全量快照。必须传入 projectDir(项目目录绝对路径)以定位画布数据。',
    inputSchema: {
      type: 'object',
      required: ['projectDir'],
      properties: {
        projectDir: {
          type: 'string',
          description: '【必填】用户项目目录,server 会在其下创建 canvas/ 文件夹',
        },
        pageId: { type: 'string', description: '可选,只返回某页数据' },
      },
    },
  },
  {
    name: 'get_selection',
    description:
      '读取当前用户选中的 shape。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
      },
    },
  },
  {
    name: 'list_pages',
    description: '列出画布所有页面。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir'],
      properties: { projectDir: { type: 'string', description: '【必填】项目目录' } },
    },
  },
  {
    name: 'create_page',
    description: '创建新页面。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'switch_page',
    description: '切换当前页面。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'pageId'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        pageId: { type: 'string' },
      },
    },
  },
  {
    name: 'create_ai_image_holder',
    description:
      '在画布上创建 AI 图片占位框。必须传入 projectDir。AI 生图后调用 insert_image 填入。',
    inputSchema: {
      type: 'object',
      required: ['projectDir'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number', description: '宽,默认 512' },
        h: { type: 'number', description: '高,默认 512' },
        pageId: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
      },
    },
  },
  {
    name: 'insert_image',
    description:
      '把图片插入到画布。必须传入 projectDir。支持本地路径或 HTTP URL,可选填入占位框。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'sourcePath'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        sourcePath: { type: 'string', description: '图片路径(file:// 或 http://)' },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        pageId: { type: 'string' },
        fillHolderId: { type: 'string', description: '填入已有占位框的 ID' },
      },
    },
  },
  {
    name: 'fill_ai_holder',
    description:
      '把已有 asset 填入占位框。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'holderId', 'assetId'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        holderId: { type: 'string' },
        assetId: { type: 'string' },
      },
    },
  },
  {
    name: 'update_shape',
    description:
      '更新 shape 属性。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'shapeId'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        shapeId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        props: { type: 'object' },
      },
    },
  },
  {
    name: 'update_shape_status',
    description:
      '流式更新占位框状态(idle→generating→done)。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'shapeId', 'status'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        shapeId: { type: 'string' },
        status: { type: 'string', enum: ['idle', 'generating', 'done', 'error'] },
        progress: { type: 'number', description: '0-100' },
        errorMessage: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_shapes',
    description:
      '删除 shape。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'shapeIds'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        shapeIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'generate_image',
    description:
      '大模型生图并直接填入画布。支持 flux-schnell / sdxl / dall-e-3 / custom。必须传入 projectDir。',
    inputSchema: {
      type: 'object',
      required: ['projectDir', 'prompt'],
      properties: {
        projectDir: { type: 'string', description: '【必填】项目目录' },
        prompt: { type: 'string', description: '【必填】图片描述' },
        model: { type: 'string', enum: ['flux-schnell', 'sdxl', 'dall-e-3', 'custom'], description: '模型,默认 flux-schnell' },
        width: { type: 'number', description: '宽,默认 1024' },
        height: { type: 'number', description: '高,默认 768' },
        fillHolderId: { type: 'string', description: '可选,填入已有占位框' },
        apiKey: { type: 'string', description: '可选,临时覆盖 API Key' },
        endpoint: { type: 'string', description: '可选,临时覆盖 API 端点(custom 模型用)' },
      },
    },
  },
  {
    name: 'start_web_server',
    description:
      '启动画布可视化 Web Server,在浏览器中实时查看和拖拽操作画布。返回访问 URL。如果已启动则返回已有 URL。',
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        projectDir: { type: 'string', description: '项目目录' },
        port: { type: 'number', description: '端口,默认 3000' },
      },
    },
  },
]

// ---------------- Web Server 启动 ----------------
async function runWebServer(args) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const webServerPath = path.join(__dirname, '..', 'web-server', 'web-server.mjs')
  const port = args?.port || 3000
  const url = `http://localhost:${port}`

  // 检查是否已有该端口进程
  try {
    const res = await fetch(url).catch(() => null)
    if (res && res.ok) {
      return { url, status: 'already_running', message: 'Web Server 已在运行' }
    }
  } catch { /* 未启动,继续 */ }

  spawn(process.execPath, [webServerPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, INF_CANVAS_DIR: path.resolve(__dirname, '..') },
    detached: false,
  }).on('error', (err) => {
    console.error(`[canvas-mcp] Web Server 启动失败: ${err.message}`)
  })

  // 等待启动就绪
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url).catch(() => null)
      if (res && res.ok) {
        return { url, status: 'started', message: `Web Server 已启动 → [${url}](${url})` }
      }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { url, status: 'started', message: `Web Server 已启动 → [${url}](${url})（首次加载可能稍慢）` }
}

// ---------------- 工具执行 ----------------
async function executeTool(name, args) {
  // 尝试读取 MCP Roots(仅第一次,带 2s 超时,避免客户端不支持时挂起)
  if (!rootsDir && !ENV_DIR) {
    try {
      const rootsResult = await Promise.race([
        server.listRoots().catch(() => null),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ])
      if (rootsResult?.roots?.length) {
        for (const r of rootsResult.roots) {
          if (r.uri.startsWith('file://')) {
            try {
              rootsDir = fileURLToPath(r.uri)
              console.error(`[canvas-mcp] MCP roots dir: ${rootsDir}`)
              break
            } catch {}
          }
        }
      }
    } catch {
      // 客户端不支持 roots
    }
  }

  // start_web_server 不需要 projectDir，单独处理
  if (name === 'start_web_server') {
    return runWebServer(args)
  }

  // 从参数中提取 projectDir
  const providedDir = args?.projectDir
  const dir = resolveDir(providedDir)
  if (!dir) throw new Error(ERROR_NO_DIR)

  const store = await getStore(providedDir)

  switch (name) {
    case 'get_canvas_snapshot': {
      const snap = await store.getSnapshot()
      if (args?.pageId) {
        return {
          pages: snap.pages,
          shapes: snap.shapes.filter(
            (s) => (s.pageId || snap.pages[0].id) === args.pageId
          ),
          assets: snap.assets,
        }
      }
      return snap
    }
    case 'get_selection': {
      const sel = await store.getSelection()
      const shapes = await store.getShapesByIds(sel.shapeIds)
      return { selection: sel, shapes }
    }
    case 'list_pages':
      return await store.listPages()
    case 'create_page':
      return { page: await store.createPage(args?.name) }
    case 'switch_page':
      await store.switchPage(args.pageId)
      return { ok: true, currentPageId: args.pageId }
    case 'create_ai_image_holder': {
      const { projectDir: _, ...rest } = args || {}
      return { shape: await store.createAIImageHolder(rest) }
    }
    case 'insert_image': {
      const { projectDir: _, ...rest } = args
      return await store.insertImage(rest)
    }
    case 'fill_ai_holder': {
      const { projectDir: _, ...rest } = args
      const snap = await store.getSnapshot()
      return await store._fillHolder(snap, rest.holderId, rest.assetId, null)
    }
    case 'update_shape': {
      const { projectDir: _, ...rest } = args
      return await store.updateShape(rest.shapeId, rest)
    }
    case 'update_shape_status': {
      const { projectDir: _, ...rest } = args
      return await store.updateShapeStatus(rest.shapeId, rest.status, {
        progress: rest.progress,
        errorMessage: rest.errorMessage,
      })
    }
    case 'delete_shapes': {
      const { projectDir: _, ...rest } = args
      return await store.deleteShapes(rest.shapeIds)
    }
    case 'generate_image': {
      const { projectDir: _, prompt, model, width, height, fillHolderId, apiKey, endpoint } = args || {}
      // 1. 生图
      const { buffer, ext } = await generateImage({ prompt, model, width, height, apiKey, endpoint })

      // 2. 保存到 canvas assets 目录
      const snap = await store.getSnapshot()
      const viewState = await store.getViewState()
      const pageId = viewState.currentPageId
      const fileName = `${crypto.randomBytes(8).toString('hex')}${ext}`
      const targetDir = path.join(store.canvasDir, 'pages', pageId, 'assets')
      await fs.mkdir(targetDir, { recursive: true })
      const targetPath = path.join(targetDir, fileName)
      await fs.writeFile(targetPath, buffer)

      const asset = {
        id: `asset:${crypto.randomBytes(8).toString('hex')}`,
        type: 'image',
        src: `file://${targetPath.replace(/\\/g, '/')}`,
        w: width,
        h: height,
      }
      snap.assets.push(asset)
      await store.saveSnapshot(snap)

      // 3. 填入占位框或新建 shape
      if (fillHolderId) {
        const result = await store._fillHolder(snap, fillHolderId, asset.id, pageId)
        return { ...result, asset, model, prompt }
      }

      const shape = store._buildImageShape(snap, asset, pageId, { x: undefined, y: undefined, w: width, h: height })
      snap.shapes.push(shape)
      await store.saveSnapshot(snap)
      return { shape, asset, model, prompt }
    }
    default:
      throw new Error(`未知工具: ${name}`)
  }
}

// ---------------- MCP Server 启动 ----------------
const server = new Server(
  { name: 'timeverse-InfCanvas-mcp', version: '0.3.0' },
  { capabilities: { tools: {}, resources: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await executeTool(name, args)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `工具执行失败: ${err.message}` }],
    }
  }
})

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'canvas://snapshot', name: '画布快照', mimeType: 'application/json' },
    { uri: 'canvas://selection', name: '选区', mimeType: 'application/json' },
    { uri: 'canvas://view-state', name: '视口', mimeType: 'application/json' },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri
  let dir = resolveDir(undefined)
  if (!dir) throw new Error(ERROR_NO_DIR)
  const store = await getStore(undefined)
  if (uri === 'canvas://snapshot') {
    const snap = await store.getSnapshot()
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snap, null, 2) }],
    }
  }
  if (uri === 'canvas://selection') {
    const sel = await store.getSelection()
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(sel, null, 2) }] }
  }
  if (uri === 'canvas://view-state') {
    const vs = await store.getViewState()
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(vs, null, 2) }] }
  }
  throw new Error(`未知资源: ${uri}`)
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`[canvas-mcp] 已启动 v0.3.0(纯动态 projectDir)`)
  console.error(`[canvas-mcp] 环境变量 INF_CANVAS_DIR: ${ENV_DIR || '(未设置)'}`)
  console.error(`[canvas-mcp] 工具数: ${TOOLS.length}`)
  console.error(`[canvas-mcp] 调用方式: 每个 tool 参数都传 projectDir 字段`)
}

main().catch((err) => {
  console.error('[canvas-mcp] 致命错误:', err)
  process.exit(1)
})
