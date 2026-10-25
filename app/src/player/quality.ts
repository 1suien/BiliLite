/**
 * 清晰度表（qn -> 名称、排序）
 * 还原自 quality-gN7BsY4u.js（原 chunk 只有 23 行，导出 Q/a/q/s 四个符号）
 *
 * 用法：
 *   qualityName(80)               -> '1080P'
 *   qualityName(999)              -> 'qn999'   （第二参可给兜底文案）
 *   sortQualities([64, 127, 80])  -> [127, 80, 64]（按清晰度从高到低）
 */

/** qn -> 展示名（与 B 站 playurl 的 accept_quality 对齐） */
export const QUALITY_NAMES: Record<number, string> = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  100: '智能修复',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K',
}

/** 清晰度优先级（从高到低），用于排序 accept_quality */
export const QUALITY_ORDER: number[] = [127, 126, 125, 120, 116, 112, 100, 80, 74, 64, 32, 16, 6]

/** qn -> 名称；未知档位回退到 fallback，再回退到 `qn{id}` */
export function qualityName(qn: number | string, fallback?: string): string {
  const id = Number(qn)
  return QUALITY_NAMES[id] || fallback || `qn${qn}`
}

/** 按清晰度优先级排序（不修改入参） */
export function sortQualities(list: number[] = []): number[] {
  return [...list].sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
}
