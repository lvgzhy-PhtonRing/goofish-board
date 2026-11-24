const EVENT_RANK = { offline: 1, sold: 2 }

function eventKey(event) {
  return String(event?.item_id || event?.itemId || '')
}

/**
 * 合并商品活力、最新 CDP 在售快照与生命周期事件。
 * 只有完整快照才用于判断「下架/售出」；无快照时全部标为未知，避免误判。
 */
export function buildVitalityStatus(items = [], shopStatus = null, events = []) {
  const cdpItems = Array.isArray(shopStatus?.payload?.items) ? shopStatus.payload.items : null
  const cdpAvailable = Boolean(cdpItems && shopStatus?.payload?.complete !== false)
  const onSaleIds = new Set((cdpItems || []).map((item) => String(item?.itemId || '')).filter(Boolean))
  const vitalityIds = new Set((items || []).map((item) => String(item?.itemId || '')).filter(Boolean))

  const eventById = new Map()
  for (const event of events || []) {
    if (event?.type !== 'sold' && event?.type !== 'offline') continue
    const key = eventKey(event)
    if (!key) continue
    const prev = eventById.get(key)
    const rank = EVENT_RANK[event.type] || 0
    const prevRank = prev ? EVENT_RANK[prev.type] || 0 : 0
    const newer = !prev || String(event.occurred_at || '') > String(prev.occurred_at || '')
    if (!prev || rank > prevRank || (rank === prevRank && newer)) {
      eventById.set(key, event)
    }
  }

  const statusById = new Map()
  for (const item of items || []) {
    const itemId = String(item?.itemId || '')
    if (!itemId) continue
    if (!cdpAvailable) {
      statusById.set(itemId, { key: 'unknown', label: '—' })
      continue
    }
    if (onSaleIds.has(itemId)) {
      statusById.set(itemId, { key: 'onsale', label: '在售' })
      continue
    }
    const event = eventById.get(itemId)
    if (event?.type === 'sold') {
      statusById.set(itemId, { key: 'sold', label: '售出', event })
      continue
    }
    if (event?.type === 'offline') {
      statusById.set(itemId, { key: 'offline', label: '下架', event })
      continue
    }
    statusById.set(itemId, { key: 'missing', label: 'CDP 已无' })
  }

  const missingCount = cdpAvailable
    ? (items || []).filter((item) => !onSaleIds.has(String(item?.itemId || ''))).length
    : 0

  return {
    cdpAvailable,
    onSaleIds,
    statusById,
    cdpCount: onSaleIds.size,
    missingCount,
    newCdpCount: cdpItems
      ? (cdpItems || []).filter((item) => !vitalityIds.has(String(item?.itemId || ''))).length
      : 0,
  }
}
