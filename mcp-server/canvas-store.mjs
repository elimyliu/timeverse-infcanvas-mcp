// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// 画布状态管理模块
// 负责本地 JSON 持久化、所有 shape/page/selection/view-state 的 CRUD
//
// 存储目录结构(在用户项目目录下):
//   canvas/
//     canvas.json           # 画布索引(version, pages, assets, shapeIndex[])
//     shapes/               # shape 独立文件,每个 shape 一个 JSON
//       shape:{id}.json
//     selection.json        # 当前选区
//     view-state.json       # 视口状态
//     pages/
//       <page-id>/
//         assets/           # 该页的图片资源
//         page.json         # 页面元数据(可选)
//
// 优点: 操作单个 shape 时只需读写 1 个小文件,不碰其他数据
//       全量快照通过并行读取所有 shape 文件构建,利用多核 I/O

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { findNonOverlapPosition } from './overlap-detector.mjs'
import { generateKeyBetween } from './fractional-indexing.mjs'

// ---------------- 类型定义(以 JSDoc 描述) ----------------
/**
 * @typedef {Object} Shape
 * @property {string} id
 * @property {string} type - 'image' | 'ai-image-holder' | 'geo' | 'text' | 'arrow' | ...
 * @property {string} z - 分数索引 z-order 键
 * @property {number} x
 * @property {number} y
 * @property {number} rotation
 * @property {Object} props - 类型相关的属性(宽高、文本、URL 等)
 * @property {string} [parentId]
 * @property {string} [pageId]
 * @property {string} [assetId]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {Object} Page
 * @property {string} id
 * @property {string} name
 * @property {number} index
 */

/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {string} type - 'image' | 'video'
 * @property {string} src
 * @property {number} [w]
 * @property {number} [h]
 */

/**
 * @typedef {Object} Selection
 * @property {string[]} shapeIds
 * @property {{x:number,y:number,w:number,h:number}|null} boundingBox
 * @property {string} pageId
 */

/**
 * @typedef {Object} ViewState
 * @property {string} currentPageId
 * @property {number} cameraX
 * @property {number} cameraY
 * @property {number} cameraZ
 */

// ---------------- 默认值 ----------------
const DEFAULT_PAGE = { id: 'page:default', name: 'Page 1', index: 0 }

function emptySnapshot() {
  return {
    version: 1,
    pages: [DEFAULT_PAGE],
    shapes: /** @type {Shape[]} */ ([]),
    assets: /** @type {Asset[]} */ ([]),
  }
}

function emptySelection(pageId) {
  return { shapeIds: [], boundingBox: null, pageId }
}

function defaultViewState() {
  return { currentPageId: DEFAULT_PAGE.id, cameraX: 0, cameraY: 0, cameraZ: 1 }
}

// ---------------- 工具函数 ----------------
function newId(prefix) {
  return `${prefix}:${crypto.randomBytes(8).toString('hex')}`
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

async function readJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, 'utf8')
    return JSON.parse(txt)
  } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw e
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file))
  // 原子写:先写临时文件再 rename,避免中途崩溃导致 JSON 损坏
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

// ---------------- 画布存储类 ----------------
export class CanvasStore {
  /**
   * @param {string} projectDir - 用户项目根目录
   */
  constructor(projectDir) {
    this.projectDir = projectDir
    this.canvasDir = path.join(projectDir, 'canvas')
    this.shapesDir = path.join(this.canvasDir, 'shapes')
    this.snapshotFile = path.join(this.canvasDir, 'canvas.json')
    this.selectionFile = path.join(this.canvasDir, 'selection.json')
    this.viewStateFile = path.join(this.canvasDir, 'view-state.json')
  }

  async init() {
    await ensureDir(this.canvasDir)
    await ensureDir(this.shapesDir)
    // 首次启动初始化默认数据
    if (!(await this.fileExists(this.snapshotFile))) {
      await writeJson(this.snapshotFile, emptySnapshot())
    } else {
      // 兼容旧格式:检测是否有嵌入式 shapes,有则迁移到独立文件
      await this._migrateIfNeeded()
    }
    if (!(await this.fileExists(this.selectionFile))) {
      const snap = await this.getSnapshot()
      await writeJson(this.selectionFile, emptySelection(snap.pages[0].id))
    }
    if (!(await this.fileExists(this.viewStateFile))) {
      await writeJson(this.viewStateFile, defaultViewState())
    }
  }

  async fileExists(p) {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  // ---------------- 索引读写 ----------------
  async getSnapshot() {
    const idx = await readJson(this.snapshotFile, emptySnapshot())
    // 从独立文件读取所有 shapes(并行)
    if (idx.shapeIndex && idx.shapeIndex.length > 0) {
      const shapeFiles = idx.shapeIndex.map(id =>
        readJson(path.join(this.shapesDir, `shape:${id}.json`), null)
      )
      const shapes = await Promise.all(shapeFiles)
      idx.shapes = shapes.filter(Boolean)
    } else {
      idx.shapes = []
    }
    return idx
  }

  async saveSnapshot(snap) {
    // 抽出 shapes,独立保存
    const shapes = snap.shapes || []
    const idx = { ...snap, shapeIndex: shapes.map(s => s.id), shapes: undefined }
    delete idx.shapes
    // 并行写入索引 + 所有 shape 文件(为保持原子性,索引里可能产生脏指针,但 shape 文件不可变)
    await Promise.all([
      writeJson(this.snapshotFile, idx),
      ...shapes.map(s => this._writeShape(s)),
    ])
  }

  // ---------------- Shape 独立文件操作 ----------------
  _shapePath(id) {
    return path.join(this.shapesDir, `${id}.json`)
  }

  async _readShape(id) {
    return readJson(this._shapePath(id), null)
  }

  async _writeShape(shape) {
    await writeJson(this._shapePath(shape.id), shape)
  }

  async _deleteShapeFile(id) {
    try {
      await fs.unlink(this._shapePath(id))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }

  // ---------------- 旧格式迁移 ----------------
  async _migrateIfNeeded() {
    const raw = await readJson(this.snapshotFile, emptySnapshot())
    if (!raw.shapes || raw.shapes.length === 0) return // 无 shapes 或已迁移
    console.error(`[canvas-store] 迁移 ${raw.shapes.length} 个 shapes 到独立文件...`)
    const shapes = raw.shapes
    const idx = { ...raw, shapeIndex: shapes.map(s => s.id), shapes: undefined }
    delete idx.shapes
    await Promise.all([
      writeJson(this.snapshotFile, idx),
      ...shapes.map(s => this._writeShape(s)),
    ])
    console.error('[canvas-store] 迁移完成')
  }

  // ---------------- 选区读写 ----------------
  async getSelection() {
    return await readJson(this.selectionFile, emptySelection(DEFAULT_PAGE.id))
  }

  async saveSelection(sel) {
    await writeJson(this.selectionFile, sel)
  }

  // ---------------- 视口读写 ----------------
  async getViewState() {
    return await readJson(this.viewStateFile, defaultViewState())
  }

  async saveViewState(vs) {
    await writeJson(this.viewStateFile, vs)
  }

  // ---------------- 页面操作 ----------------
  async listPages() {
    const snap = await this.getSnapshot()
    return snap.pages
  }

  async createPage(name) {
    const snap = await this.getSnapshot()
    const page = { id: newId('page'), name: name || `Page ${snap.pages.length + 1}`, index: snap.pages.length }
    snap.pages.push(page)
    await writeJson(this.snapshotFile, snap)
    return page
  }

  async switchPage(pageId) {
    const idx = await this._readIndexOnly()
    if (!idx.pages.find((p) => p.id === pageId)) {
      throw new Error(`页面不存在: ${pageId}`)
    }
    const vs = await this.getViewState()
    vs.currentPageId = pageId
    await this.saveViewState(vs)
    // 清空选区
    await this.saveSelection(emptySelection(pageId))
  }

  // 仅读取索引(不含 shapes)
  async _readIndexOnly() {
    return readJson(this.snapshotFile, emptySnapshot())
  }

  // 追加一个 shape 到索引
  async _appendShapeToIndex(shapeId) {
    const idx = await this._readIndexOnly()
    if (!idx.shapeIndex) idx.shapeIndex = []
    idx.shapeIndex.push(shapeId)
    // 不保留 shapes 字段
    delete idx.shapes
    await writeJson(this.snapshotFile, idx)
  }

  // ---------------- Shape 查询 ----------------
  async getShapesByPage(pageId) {
    const idx = await this._readIndexOnly()
    // 读取所有 shape 文件,再按 pageId 过滤
    const allShapes = await this._readAllShapes(idx.shapeIndex || [])
    return allShapes.filter((s) => (s.pageId || idx.pages[0].id) === pageId)
  }

  async getShape(shapeId) {
    return this._readShape(shapeId)
  }

  async getShapesByIds(ids) {
    const results = await Promise.all(ids.map(id => this._readShape(id)))
    return results.filter(Boolean)
  }

  async _readAllShapes(ids) {
    if (ids.length === 0) return []
    const results = await Promise.all(ids.map(id => this._readShape(id)))
    return results.filter(Boolean)
  }

  // ---------------- 创建占位框 ----------------
  /**
   * 创建一个 AI 图片占位框(shape 类型: 'ai-image-holder')
   * @param {{ x?: number, y?: number, w?: number, h?: number, pageId?: string, prompt?: string, model?: string }} opts
   */
  async createAIImageHolder(opts = {}) {
    const idx = await this._readIndexOnly()
    const viewState = await this.getViewState()
    const pageId = opts.pageId || viewState.currentPageId
    const w = opts.w ?? 512
    const h = opts.h ?? 512

    // 读取已有 shapes 用于重叠检测
    const existingShapes = await this._readAllShapes(idx.shapeIndex || [])
    const existingBBoxes = existingShapes
      .filter((s) => (s.pageId || idx.pages[0].id) === pageId)
      .map((s) => ({ x: s.x, y: s.y, w: s.props?.w || 0, h: s.props?.h || 0 }))
    const pos = findNonOverlapPosition(existingBBoxes, { w, h }, {
      preferredX: opts.x ?? 100,
      preferredY: opts.y ?? 100,
    })

    // 计算 z-order
    const z = this._nextZ(existingShapes)

    const now = new Date().toISOString()
    const shape = {
      id: newId('shape'),
      type: 'ai-image-holder',
      z,
      x: pos.x,
      y: pos.y,
      rotation: 0,
      pageId,
      props: {
        w,
        h,
        prompt: opts.prompt || '',
        model: opts.model || 'flux-schnell',
        status: 'idle',
        progress: 0,
        assetId: null,
        errorMessage: null,
      },
      createdAt: now,
      updatedAt: now,
    }
    // 只写 1 个 shape 文件 + 更新索引
    await Promise.all([
      this._writeShape(shape),
      this._appendShapeToIndex(shape.id),
    ])
    return shape
  }

  // ---------------- 插入图片 ----------------
  /**
   * 把外部图片插入到画布
   * @param {{
   *   sourcePath: string,
   *   x?: number, y?: number, w?: number, h?: number,
   *   pageId?: string,
   *   fillHolderId?: string,
   * }} opts
   */
  async insertImage(opts) {
    if (!opts.sourcePath) throw new Error('sourcePath 必填')

    const idx = await this._readIndexOnly()
    const viewState = await this.getViewState()
    const pageId = opts.pageId || viewState.currentPageId

    const sourcePath = opts.sourcePath
    let ext = '.png'

    const addAssetAndShape = async (asset) => {
      if (!idx.assets) idx.assets = []
      idx.assets.push(asset)

      if (opts.fillHolderId) {
        // 填入占位框:只需要写 shape 文件和 assets
        const holder = await this._readShape(opts.fillHolderId)
        if (!holder) throw new Error(`占位框不存在: ${opts.fillHolderId}`)
        holder.type = 'image'
        holder.assetId = asset.id
        holder.props = {
          w: holder.props.w,
          h: holder.props.h,
          sourcePrompt: holder.props.prompt,
          sourceModel: holder.props.model,
        }
        holder.updatedAt = new Date().toISOString()
        await Promise.all([
          this._writeShape(holder),
          writeJson(this.snapshotFile, idx),
        ])
        return { shape: holder, asset, filled: true }
      }

      // 否则新建图片 shape
      const existingShapes = await this._readAllShapes(idx.shapeIndex || [])
      const w = opts.w ?? asset.w ?? 512
      const h = opts.h ?? asset.h ?? 512
      const existingBBoxes = existingShapes
        .filter((s) => (s.pageId || idx.pages[0].id) === pageId)
        .map((s) => ({ x: s.x, y: s.y, w: s.props?.w || 0, h: s.props?.h || 0 }))
      const pos = findNonOverlapPosition(existingBBoxes, { w, h }, {
        preferredX: opts.x ?? 100,
        preferredY: opts.y ?? 100,
      })
      const now = new Date().toISOString()
      const shape = {
        id: newId('shape'),
        type: 'image',
        z: this._nextZ(existingShapes),
        x: pos.x, y: pos.y, rotation: 0, pageId,
        assetId: asset.id,
        props: { w, h },
        createdAt: now, updatedAt: now,
      }
      // 写 shape 文件 + 更新索引 + 更新 assets
      await Promise.all([
        this._writeShape(shape),
        this._appendShapeToIndex(shape.id),
        writeJson(this.snapshotFile, idx),
      ])
      return { shape, asset }
    }

    if (sourcePath.startsWith('http://') || sourcePath.startsWith('https://')) {
      const asset = {
        id: newId('asset'),
        type: 'image',
        src: sourcePath,
        w: opts.w,
        h: opts.h,
      }
      return await addAssetAndShape(asset)
    } else {
      const localPath = sourcePath.replace(/^file:\/\//, '')
      const buffer = await fs.readFile(localPath)
      ext = path.extname(localPath) || '.png'
      const fileName = `${crypto.randomBytes(8).toString('hex')}${ext}`
      const targetDir = path.join(this.canvasDir, 'pages', pageId, 'assets')
      await ensureDir(targetDir)
      const targetPath = path.join(targetDir, fileName)
      await fs.writeFile(targetPath, buffer)
      const asset = {
        id: newId('asset'),
        type: 'image',
        src: `file://${targetPath.replace(/\\/g, '/')}`,
        w: opts.w,
        h: opts.h,
      }
      return await addAssetAndShape(asset)
    }
  }

  // ---------------- 状态流转 ----------------
  async updateShapeStatus(shapeId, status, extra = {}) {
    const shape = await this._readShape(shapeId)
    if (!shape) throw new Error(`shape 不存在: ${shapeId}`)
    shape.props = { ...shape.props, status, ...extra }
    shape.updatedAt = new Date().toISOString()
    await this._writeShape(shape)
    return shape
  }

  // ---------------- 更新 shape ----------------
  async updateShape(shapeId, partial) {
    const shape = await this._readShape(shapeId)
    if (!shape) throw new Error(`shape 不存在: ${shapeId}`)
    if (partial.x !== undefined) shape.x = partial.x
    if (partial.y !== undefined) shape.y = partial.y
    if (partial.props) shape.props = { ...shape.props, ...partial.props }
    shape.updatedAt = new Date().toISOString()
    await this._writeShape(shape)
    return shape
  }

  // ---------------- 删除 shape ----------------
  async deleteShapes(shapeIds) {
    // 删除 shape 文件
    await Promise.all(shapeIds.map(id => this._deleteShapeFile(id)))
    // 更新索引
    const idx = await this._readIndexOnly()
    if (idx.shapeIndex) {
      const idSet = new Set(shapeIds)
      const before = idx.shapeIndex.length
      idx.shapeIndex = idx.shapeIndex.filter(id => !idSet.has(id))
      delete idx.shapes
      await writeJson(this.snapshotFile, idx)
    }
    // 同步清空选区
    const sel = await this.getSelection()
    const idSet = new Set(shapeIds)
    sel.shapeIds = sel.shapeIds.filter((id) => !idSet.has(id))
    await this.saveSelection(sel)
    return { deleted: shapeIds.length }
  }

  // ---------------- 内部工具 ----------------
  _nextZ(shapes) {
    if (shapes.length === 0) return generateKeyBetween(null, null)
    const sorted = [...shapes].sort((a, b) => (a.z > b.z ? 1 : -1))
    return generateKeyBetween(sorted[sorted.length - 1].z, null)
  }
}
