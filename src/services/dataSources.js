// 数据来源与可信度统一定义：所有页面共用，避免口径漂移。
export const SOURCE_META = {
  cdp: {
    label: 'CDP 实时抓取',
    detail: '商品管理页 · 在售清单',
    confidence: '高（实时）',
    tone: 'text-success',
    badge: 'bg-emerald-50 text-emerald-700',
  },
  excel: {
    label: '经营罗盘 Excel',
    detail: '近 7 天经营数据 · 本地导入',
    confidence: '中（导出可能滞后 1 天以上，且含已下架商品）',
    tone: 'text-warning',
    badge: 'bg-amber-50 text-amber-800',
  },
  ysp: {
    label: 'YSP 销售记录',
    detail: '店铺 PhtonRIng 销售记账',
    confidence: '100%',
    tone: 'text-primary',
    badge: 'bg-sky-50 text-sky-700',
  },
  user: {
    label: '用户操作',
    detail: '看板打卡',
    confidence: '100%',
    tone: 'text-primary',
    badge: 'bg-sky-50 text-sky-700',
  },
  'cdp+ysp': {
    label: 'CDP + YSP',
    detail: '在售清单消失 + 销售记录',
    confidence: '100%',
    tone: 'text-primary',
    badge: 'bg-sky-50 text-sky-700',
  },
}

export function sourceMeta(key) {
  return SOURCE_META[key] || SOURCE_META.excel
}

export function eventSourceKey(event) {
  const source = String(event?.data?.source || '')
  if (source) return source
  if (event?.type === 'sold') return 'ysp'
  return 'excel'
}

export function eventSourceMeta(event) {
  return sourceMeta(eventSourceKey(event))
}
