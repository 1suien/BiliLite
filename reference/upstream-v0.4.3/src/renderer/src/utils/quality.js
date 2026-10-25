export const QN_LABEL = {
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
  127: '8K'
}

export const QN_ORDER = [127, 126, 125, 120, 116, 112, 100, 80, 74, 64, 32, 16, 6]

export function qnLabel(qn, desc) {
  return QN_LABEL[qn] || desc || `qn${qn}`
}

/** 按清晰度从高到低排列可用档位 */
export function sortQuality(list = []) {
  return [...list].sort((a, b) => QN_ORDER.indexOf(a) - QN_ORDER.indexOf(b))
}
