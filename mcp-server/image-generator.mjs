// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// 多模型图片生成模块
// 支持: flux-schnell (Replicate) / sdxl (Replicate) / dall-e-3 (OpenAI) / custom
//
// 环境变量:
//   REPLICATE_API_KEY    - Replicate API Token
//   OPENAI_API_KEY       - OpenAI API Key
//   OPENAI_API_ENDPOINT  - OpenAI 端点(默认 https://api.openai.com/v1)
//   CUSTOM_API_ENDPOINT  - 自研模型 HTTP 端点
//   CUSTOM_API_KEY       - 自研模型 API Key

const REPLICATE_API = 'https://api.replicate.com/v1'
const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1'

const REPLICATE_MODEL_MAP = {
  'flux-schnell': 'black-forest-labs/flux-schnell',
  sdxl: 'stability-ai/sdxl',
}

/**
 * 生成图片,返回图片 buffer 和扩展名
 * @param {Object} opts
 * @param {string}  opts.prompt   - 图片描述
 * @param {string}  [opts.model='flux-schnell'] - 模型
 * @param {number}  [opts.width=1024]
 * @param {number}  [opts.height=768]
 * @param {string}  [opts.apiKey]    - 临时覆盖 API Key
 * @param {string}  [opts.endpoint]  - 临时覆盖 API 端点(仅 custom 模型有效)
 * @returns {Promise<{buffer: Buffer, ext: string}>}
 */
export async function generateImage({
  prompt,
  model = 'flux-schnell',
  width = 1024,
  height = 768,
  apiKey,
  endpoint,
} = {}) {
  if (!prompt) throw new Error('prompt 必填')

  switch (model) {
    case 'flux-schnell':
    case 'sdxl':
      return await replicateGenerate({ prompt, model, width, height, apiKey })
    case 'dall-e-3':
      return await openaiGenerate({ prompt, width, height, apiKey, endpoint })
    case 'custom':
      return await customGenerate({ prompt, width, height, apiKey, endpoint })
    default:
      throw new Error(`不支持的模型: ${model}`)
  }
}

// ---------------- Replicate (flux-schnel / sdxl) ----------------

async function replicateGenerate({ prompt, model, width, height, apiKey }) {
  const key = apiKey || process.env.REPLICATE_API_KEY
  if (!key) throw new Error('Replicate 需要设置 REPLICATE_API_KEY 或者在参数中传入 apiKey')

  const modelId = REPLICATE_MODEL_MAP[model]
  const input = { prompt }
  // flux-schnell 支持宽高参数
  if (model === 'flux-schnell') {
    input.width = width
    input.height = height
    input.num_outputs = 1
  }

  // 1. 创建预测
  const createRes = await fetch(`${REPLICATE_API}/models/${modelId}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'timeverse-infcanvas-mcp/0.3.0',
    },
    body: JSON.stringify({ input }),
  })
  if (!createRes.ok) {
    const err = await createRes.text()
    throw new Error(`Replicate 创建预测失败 (${createRes.status}): ${err}`)
  }
  const prediction = await createRes.json()

  // 2. 轮询直到完成
  const result = await pollPrediction(prediction.urls.get, key)
  if (result.status !== 'succeeded') {
    throw new Error(`Replicate 生图失败: ${result.error || result.status}`)
  }

  // 3. 下载图片
  const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output
  if (!outputUrl) throw new Error('Replicate 返回了空输出')
  return await downloadImage(outputUrl, '.png')
}

async function pollPrediction(url, key, maxAttempts = 60, intervalMs = 1500) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    })
    const data = await res.json()
    if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
      return data
    }
    await sleep(intervalMs)
  }
  throw new Error('Replicate 生图超时')
}

// ---------------- OpenAI DALL-E 3 ----------------

async function openaiGenerate({ prompt, width, height, apiKey, endpoint }) {
  const key = apiKey || process.env.OPENAI_API_KEY
  if (!key) throw new Error('OpenAI 需要设置 OPENAI_API_KEY 或者在参数中传入 apiKey')

  const base = endpoint || process.env.OPENAI_API_ENDPOINT || DEFAULT_OPENAI_ENDPOINT

  // DALL-E 3 只支持 1024x1024 / 1792x1024 / 1024x1792
  const size = normalizeDalleSize(width, height)

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality: 'standard',
      response_format: 'url',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI 生图失败 (${res.status}): ${err}`)
  }
  const data = await res.json()
  const imageUrl = data.data?.[0]?.url
  if (!imageUrl) throw new Error('OpenAI 返回中无图片 URL')
  return await downloadImage(imageUrl, '.png')
}

function normalizeDalleSize(width, height) {
  // DALL-E 3 仅支持三种尺寸
  if (width >= height * 1.5) return '1792x1024'
  if (height >= width * 1.5) return '1024x1792'
  return '1024x1024'
}

// ---------------- 自定义端点 ----------------

async function customGenerate({ prompt, width, height, apiKey, endpoint }) {
  const ep = endpoint || process.env.CUSTOM_API_ENDPOINT
  if (!ep) throw new Error('custom 模型需要设置 CUSTOM_API_ENDPOINT 或者在参数中传入 endpoint')

  const key = apiKey || process.env.CUSTOM_API_KEY || ''

  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['Authorization'] = `Bearer ${key}`

  const res = await fetch(ep, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, width, height }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`自定义端点生图失败 (${res.status}): ${err}`)
  }

  // 尝试按 JSON 解析,如果返回的是图片二进制则直接返回
  const contentType = res.headers.get('content-type') || ''
  if (contentType.startsWith('image/')) {
    const ext = contentType === 'image/png' ? '.png' : '.jpg'
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, ext }
  }

  // JSON 响应:期望 { image_url } 或 { image }(base64) 或 { output }
  const data = await res.json()
  const imageUrl = data.image_url || data.image || data.output
  if (typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
    return await downloadImage(imageUrl, '.png')
  }
  if (typeof imageUrl === 'string' && imageUrl.length > 100) {
    // 可能是 base64
    const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (matches) {
      const ext = matches[1] === 'png' ? '.png' : '.jpg'
      return { buffer: Buffer.from(matches[2], 'base64'), ext }
    }
    return { buffer: Buffer.from(imageUrl, 'base64'), ext: '.png' }
  }
  throw new Error('自定义端点返回格式无法识别,需要 image_url 或二进制图片')
}

// ---------------- 通用工具 ----------------

async function downloadImage(url, defaultExt) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载图片失败 (${res.status}): ${url}`)
  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // 尝试从 content-type 推断扩展名
  const ct = res.headers.get('content-type') || ''
  const ext = ct === 'image/png' ? '.png'
    : ct === 'image/jpeg' || ct === 'image/jpg' ? '.jpg'
    : ct === 'image/webp' ? '.webp'
    : defaultExt

  return { buffer, ext }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
