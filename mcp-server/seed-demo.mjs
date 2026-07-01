import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const canvasDir = path.join(process.cwd(), 'canvas')
const shapesDir = path.join(canvasDir, 'shapes')
await fs.mkdir(shapesDir, { recursive: true })

const now = new Date().toISOString()

const idx = {
  version: 1,
  pages: [
    { id: 'page:default', name: '首页', index: 0 },
    { id: 'page:design', name: '设计参考', index: 1 },
  ],
  shapeIndex: [
    'shape:demo-holder-1',
    'shape:demo-image-1',
    'shape:demo-holder-2',
    'shape:demo-error',
  ],
  assets: [
    {
      id: 'asset:demo-sample',
      type: 'image',
      src: 'https://picsum.photos/seed/infcanvas/512/384',
      w: 512, h: 384,
    },
  ],
}

const shapes = [
  {
    id: 'shape:demo-holder-1', type: 'ai-image-holder', z: 'a0',
    x: 100, y: 100, rotation: 0, pageId: 'page:default',
    props: {
      w: 512, h: 512,
      prompt: 'A futuristic city at sunset, cyberpunk style',
      model: 'flux-schnell', status: 'idle',
      progress: 0, assetId: null, errorMessage: null,
    },
    createdAt: now, updatedAt: now,
  },
  {
    id: 'shape:demo-image-1', type: 'image', z: 'a1',
    x: 700, y: 100, rotation: 0, pageId: 'page:default',
    assetId: 'asset:demo-sample',
    props: { w: 512, h: 384 },
    createdAt: now, updatedAt: now,
  },
  {
    id: 'shape:demo-holder-2', type: 'ai-image-holder', z: 'a2',
    x: 100, y: 700, rotation: 0, pageId: 'page:default',
    props: {
      w: 400, h: 400,
      prompt: 'Cute cat playing with yarn',
      model: 'flux-schnell', status: 'generating',
      progress: 65, assetId: null, errorMessage: null,
    },
    createdAt: now, updatedAt: now,
  },
  {
    id: 'shape:demo-error', type: 'ai-image-holder', z: 'a3',
    x: 600, y: 700, rotation: 0, pageId: 'page:default',
    props: {
      w: 400, h: 400,
      prompt: 'Failed generation',
      model: 'flux-schnell', status: 'error',
      progress: 0, assetId: null,
      errorMessage: 'API timeout',
    },
    createdAt: now, updatedAt: now,
  },
]

// 写入索引
await fs.writeFile(path.join(canvasDir, 'canvas.json'), JSON.stringify(idx, null, 2), 'utf8')

// 写入每个 shape 独立文件
await Promise.all(shapes.map(s =>
  fs.writeFile(path.join(shapesDir, s.id + '.json'), JSON.stringify(s, null, 2), 'utf8')
))

// 选区
await fs.writeFile(
  path.join(canvasDir, 'selection.json'),
  JSON.stringify({ shapeIds: [], boundingBox: null, pageId: 'page:default' }),
  'utf8',
)

// 视口
await fs.writeFile(
  path.join(canvasDir, 'view-state.json'),
  JSON.stringify({ currentPageId: 'page:default', cameraX: 0, cameraY: 0, cameraZ: 1 }),
  'utf8',
)

console.log(`✅ 画布数据重建完成
   pages:  ${idx.pages.length}
   shapes: ${idx.shapeIndex.length}
   assets: ${idx.assets.length}`)
