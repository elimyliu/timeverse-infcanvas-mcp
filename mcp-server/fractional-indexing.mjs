// MIT License
// Copyright © 2024-2026 TimeVerse Studio
// SPDX-License-Identifier: MIT
//
// 分数索引 (Fractional Indexing)
// 用于给 shape 生成可比较的字符串 z-order 键,新元素可插入到任意两个元素之间
// 参考: https://observablehq.com/@dgreensp/implementing-fractional-indexing
// 与 Figma / Linear 的实现思路一致

// 字符集:从 'a' 到 'z' 共 26 个位置,加之大小写与数字可扩展
// 这里使用 base-62 (0-9, a-z, A-Z) 以获得更细的粒度
const BASE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE_LEN = BigInt(BASE.length)
const MIN_CHAR = BASE[0] // '0'
const MAX_CHAR = BASE[BASE.length - 1] // 'z'
const FIRST = MIN_CHAR // 起始字符

// 在两个 key 之间生成新的 key
// - 如果 a 为空,生成大于 b 的最小 key
// - 如果 b 为空,生成大于 a 的最小 key
// - 如果都为空,返回初始 key
// - 如果 a 和 b 相邻,需要"进位"扩展
export function generateKeyBetween(a, b) {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`generateKeyBetween: a(${a}) 必须小于 b(${b})`)
  }
  return midpoint(a ?? '', b ?? '', 0)
}

function midpoint(a, b, depth) {
  // 边界:两边都为空,返回初始字符的中点
  if (a === '' && b === '') {
    return BASE[Math.floor(BASE.length / 2)]
  }
  // 找到 a 和 b 第一个不同的位置
  let i = 0
  while (true) {
    const ca = a[i] || ''
    const cb = b[i] || ''
    if (ca === cb) {
      i++
      continue
    }
    // ca 为空表示 a 较短,补 MIN_CHAR
    const caIdx = ca === '' ? -1 : BASE.indexOf(ca)
    const cbIdx = cb === '' ? -1 : BASE.indexOf(cb)

    if (caIdx === -1 && cbIdx >= 0) {
      // a 结束了,但 b 还有字符 -> 在 a 末尾追加 mid(0, cb)
      return a + midpointInner(BigInt(0), BigInt(cbIdx), depth)
    }
    if (caIdx >= 0 && cbIdx === -1) {
      // b 结束了,在 a[i] 之后追加 mid(ca, MAX)
      return a.slice(0, i) + midpointInner(BigInt(caIdx), BigInt(BASE_LEN - 1n), depth)
    }
    // 两边都有字符,取中间值
    return a.slice(0, i) + midpointInner(BigInt(caIdx), BigInt(cbIdx), depth)
  }
}

function midpointInner(lo, hi, depth) {
  if (lo + 1n < hi) {
    // 标准取中点
    const mid = (lo + hi) / 2n
    return BASE[Number(mid)]
  }
  if (lo + 1n === hi) {
    // 相邻:取 lo 的字符,并向下递归取 lo 和 MAX 的中点作为下一个字符
    if (depth >= 2) {
      // 太深了,直接返回 lo+1 触发新的更大范围
      return BASE[Number(lo)]
    }
    const loChar = BASE[Number(lo)]
    return loChar + midpointInner(BigInt(0), BigInt(BASE_LEN - 1n), depth + 1)
  }
  // lo === hi,理论不应发生
  return BASE[Number(lo)]
}

// 简单使用:
// const a = null  -> 'V'
// const b = null  -> 'l'
// const c = generateKeyBetween(a, b) -> 'i' (位于 V 和 l 之间)
// 链式插入示例:
// const k1 = generateKeyBetween(null, null) // 'V'
// const k2 = generateKeyBetween(k1, null)  // 'l'
// const k3 = generateKeyBetween(k1, k2)    // 'i' 插在 k1 和 k2 之间
