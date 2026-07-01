// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// 碰撞检测 (Overlap Detection)
// 给定一组现有 shape 的边界框,和一个目标候选位置/尺寸,计算不重叠的最佳放置坐标
// 算法:贪心扫描 + 网格启发式

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} BBox
 */

/**
 * 计算两个矩形是否重叠
 */
export function isOverlap(a, b) {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  )
}

/**
 * 给定现有 shape 列表,寻找一个不与任何 shape 重叠的放置位置
 * @param {BBox[]} existingBBoxes - 现有边界框
 * @param {BBox} target - 待放置的尺寸
 * @param {{ preferredX?: number, preferredY?: number, padding?: number }} opts
 * @returns {{ x: number, y: number }}
 */
export function findNonOverlapPosition(existingBBoxes, target, opts = {}) {
  const padding = opts.padding ?? 16
  const preferredX = opts.preferredX ?? 100
  const preferredY = opts.preferredY ?? 100

  // 把所有 bbox 按 (y, x) 排序
  const sorted = [...existingBBoxes].sort((a, b) => a.y - b.y || a.x - b.x)

  // 候选位置策略:
  // 1. 优先尝试 preferredX, preferredY
  // 2. 尝试每个现有 shape 的右侧(避让 padding)
  // 3. 尝试每个现有 shape 的下方
  // 4. 实在不行放最右下角

  const candidates = [
    { x: preferredX, y: preferredY },
    ...sorted.map((b) => ({ x: b.x + b.w + padding, y: b.y })),
    ...sorted.map((b) => ({ x: b.x, y: b.y + b.h + padding })),
  ]

  for (const c of candidates) {
    const test = { x: c.x, y: c.y, w: target.w, h: target.h }
    if (!existingBBoxes.some((b) => isOverlap(b, test))) {
      return { x: c.x, y: c.y }
    }
  }

  // 兜底:放在所有 shape 的最右下角
  if (sorted.length === 0) {
    return { x: preferredX, y: preferredY }
  }
  const maxX = Math.max(...sorted.map((b) => b.x + b.w))
  const maxY = Math.max(...sorted.map((b) => b.y + b.h))
  return { x: maxX + padding, y: maxY + padding }
}
