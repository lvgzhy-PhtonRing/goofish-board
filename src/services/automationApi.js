// 自动化数据通道：待确认项与生命周期事件（多行表查询）。
const FETCH_TIMEOUT_MS = 20_000

async function rest(config, session, path, options = {}, onSession) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${session?.accessToken || config.publishableKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    })
    if (resp.status === 401 || resp.status === 403) {
      if (typeof onSession === 'function') onSession(null)
      throw new Error('登录已失效，请重新登录')
    }
    const text = await resp.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { message: text }
    }
    if (!resp.ok) throw new Error(data?.message || `请求失败 (HTTP ${resp.status})`)
    return data
  } catch (error) {
    if (controller.signal.aborted) throw new Error('云端请求超时，请检查网络后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchPending(config, session, onSession) {
  return rest(
    config,
    session,
    'goofish_pending?status=eq.pending&order=created_at.asc&select=*',
    {},
    onSession,
  )
}

export async function resolvePending(config, session, id, resolution, onSession) {
  return rest(
    config,
    session,
    `goofish_pending?id=eq.${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'resolved',
        resolution,
        resolved_at: new Date().toISOString(),
      }),
    },
    onSession,
  )
}

export async function insertEvent(config, session, event, onSession) {
  return rest(
    config,
    session,
    'goofish_events',
    {
      method: 'POST',
      body: JSON.stringify([{ ...event, owner_id: session?.user?.id || undefined }]),
    },
    onSession,
  )
}

export async function fetchEvents(config, session, onSession, limit = 1000) {
  return rest(
    config,
    session,
    `goofish_events?order=occurred_at.desc&limit=${limit}&select=*`,
    {},
    onSession,
  )
}

export async function fetchShopMetrics(config, session, onSession, limit = 30) {
  return rest(
    config,
    session,
    `goofish_shop_metrics?order=created_at.desc&limit=${limit}&select=*`,
    {},
    onSession,
  )
}

export async function fetchShopStatus(config, session, onSession) {
  const rows = await rest(
    config,
    session,
    'goofish_shop_status?complete=eq.true&order=created_at.desc&limit=1&select=payload,captured_at,count',
    {},
    onSession,
  )
  return rows?.[0] || null
}
