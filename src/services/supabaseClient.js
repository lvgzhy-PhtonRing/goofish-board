// Supabase REST 封装 —— 参照 ysp-app src/services/cloudStore.js 模式（无 SDK）。
const FETCH_TIMEOUT_MS = 30_000

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('云端请求超时，请检查网络后重试')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(url) {
  return trimString(url).replace(/\/+$/, '')
}

export function normalizeCloudConfig(raw = {}) {
  return {
    supabaseUrl: normalizeBaseUrl(raw.supabaseUrl || raw.url),
    publishableKey: trimString(raw.publishableKey || raw.supabaseAnonKey || raw.anonKey),
  }
}

export function isCloudConfigReady(raw = {}) {
  const config = normalizeCloudConfig(raw)
  return Boolean(config.supabaseUrl && config.publishableKey)
}

function buildHeaders(config, accessToken = '') {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${accessToken || config.publishableKey}`,
    'Content-Type': 'application/json',
  }
}

async function readJsonResponse(resp) {
  const text = await resp.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function buildApiError(prefix, status, data) {
  const raw =
    data?.msg || data?.message || data?.error_description || data?.hint || data?.error || data?.error_code || ''
  return new Error(`${prefix}${raw ? `: ${raw}` : ` (HTTP ${status})`}`)
}

function mapSession(data = {}, fallbackEmail = '') {
  const expiresIn = Number(data.expires_in || 0)
  const expiresAt = Number(data.expires_at || 0) || Math.floor(Date.now() / 1000) + expiresIn
  return {
    accessToken: data.access_token || '',
    refreshToken: data.refresh_token || '',
    expiresAt,
    user: {
      id: data.user?.id || '',
      email: data.user?.email || fallbackEmail || '',
    },
  }
}

export function hasValidSession(session, safeWindowSeconds = 60) {
  if (!session?.accessToken) return false
  const expiresAt = Number(session.expiresAt || 0)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return expiresAt - safeWindowSeconds > Math.floor(Date.now() / 1000)
}

function revisionConflict() {
  const error = new Error('云端数据已被其他设备更新，正在重新核对')
  error.code = 'CLOUD_REVISION_CONFLICT'
  return error
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('云端版本信息缺失或无效，已停止写入以保护数据')
  }
  return value
}

export async function readCloudConfig(basePath = '/') {
  const base = String(basePath || '/')
  const path = base.endsWith('/') ? base : `${base}/`
  const resp = await fetchWithTimeout(`${path}cloud-config.json?t=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
  })
  if (!resp.ok) throw new Error('未找到 cloud-config.json')
  const data = await readJsonResponse(resp)
  if (!data || typeof data !== 'object') throw new Error('cloud-config.json 格式错误')
  return normalizeCloudConfig(data)
}

export async function signIn(config, email, password) {
  if (!isCloudConfigReady(config)) throw new Error('云端配置不完整')
  const userEmail = trimString(email)
  const userPassword = String(password || '')
  if (!userEmail || !userPassword) throw new Error('请填写账号和密码')

  const resp = await fetchWithTimeout(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({ email: userEmail, password: userPassword }),
  })
  const data = await readJsonResponse(resp)
  if (!resp.ok) throw buildApiError('登录失败', resp.status, data)
  return mapSession(data, userEmail)
}

export async function refreshSession(config, session) {
  if (!isCloudConfigReady(config)) throw new Error('云端配置不完整')
  const refreshToken = trimString(session?.refreshToken)
  if (!refreshToken) throw new Error('登录已过期，请重新登录')

  const resp = await fetchWithTimeout(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const data = await readJsonResponse(resp)
  if (!resp.ok) throw buildApiError('刷新会话失败', resp.status, data)
  const next = mapSession(data, session?.user?.email || '')
  if (!next.user.id && session?.user?.id) next.user.id = session.user.id
  if (!next.user.email && session?.user?.email) next.user.email = session.user.email
  return next
}

export async function signOut(config, session) {
  if (!isCloudConfigReady(config)) return
  const token = trimString(session?.accessToken)
  if (!token) return
  try {
    await fetchWithTimeout(`${config.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: buildHeaders(config, token),
    })
  } catch {
    // 尽力而为
  }
}

async function ensureSession(config, session, onSession) {
  if (!session?.accessToken) return null
  if (hasValidSession(session)) return session
  try {
    const refreshed = await refreshSession(config, session)
    if (typeof onSession === 'function') onSession(refreshed)
    return refreshed
  } catch {
    if (typeof onSession === 'function') onSession(null)
    const error = new Error('登录已过期，请重新登录')
    error.code = 'AUTH_EXPIRED'
    throw error
  }
}

async function assertAuthorized(resp, data, onSession) {
  if (resp.status !== 401 && resp.status !== 403) return
  if (typeof onSession === 'function') onSession(null)
  const error = new Error('登录已失效，请重新登录')
  error.code = 'AUTH_EXPIRED'
  throw error
}

function selectQuery(base) {
  const params = new URLSearchParams()
  params.set('id', 'eq.main')
  params.set('select', 'payload,revision,updated_at')
  params.set('limit', '1')
  return `${base}?${params.toString()}`
}

/** 读取单行快照；无行时返回 revision=0 与空 payload。 */
export async function loadRow(config, table, session, { onSession } = {}) {
  if (!isCloudConfigReady(config)) throw new Error('云端配置不完整')
  const nextSession = await ensureSession(config, session, onSession)
  const resp = await fetchWithTimeout(selectQuery(`${config.supabaseUrl}/rest/v1/${table}`), {
    method: 'GET',
    headers: buildHeaders(config, nextSession?.accessToken),
    cache: 'no-store',
  })
  const data = await readJsonResponse(resp)
  if (!resp.ok) {
    await assertAuthorized(resp, data, onSession)
    throw buildApiError('读取云端数据失败', resp.status, data)
  }
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return { payload: null, revision: 0, exists: false, session: nextSession }
  const row = rows[0]
  return {
    payload: row?.payload ?? null,
    revision: requireRevision(row?.revision ?? 0),
    updatedAt: row?.updated_at || '',
    exists: true,
    session: nextSession,
  }
}

/** 乐观锁写入：存在则 PATCH revision=eq.N；0 行视为冲突；不存在则 INSERT。 */
export async function saveRow(config, table, session, payload, expectedRevision, { onSession, exists = true } = {}) {
  if (!isCloudConfigReady(config)) throw new Error('云端配置不完整')
  const nextSession = await ensureSession(config, session, onSession)
  if (!nextSession?.accessToken) throw new Error('请先登录账号')
  const headers = { ...buildHeaders(config, nextSession.accessToken), Prefer: 'return=representation' }

  if (exists) {
    const params = new URLSearchParams()
    params.set('id', 'eq.main')
    params.set('revision', `eq.${requireRevision(expectedRevision)}`)
    const resp = await fetchWithTimeout(`${config.supabaseUrl}/rest/v1/${table}?${params.toString()}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ payload, revision: expectedRevision + 1 }),
    })
    const data = await readJsonResponse(resp)
    if (!resp.ok) {
      await assertAuthorized(resp, data, onSession)
      throw buildApiError('写入云端数据失败', resp.status, data)
    }
    const rows = Array.isArray(data) ? data : []
    if (!rows.length) throw revisionConflict()
    return {
      payload: rows[0]?.payload ?? payload,
      revision: requireRevision(rows[0]?.revision),
      session: nextSession,
    }
  }

  if (!nextSession.user?.id) {
    throw new Error('登录会话缺少用户信息，请重新登录后再同步')
  }
  const insertRow = { id: 'main', payload, revision: 1, owner_id: nextSession.user.id }
  const resp = await fetchWithTimeout(`${config.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers,
    body: JSON.stringify([insertRow]),
  })
  const data = await readJsonResponse(resp)
  if (resp.status === 409) throw revisionConflict()
  if (!resp.ok) {
    await assertAuthorized(resp, data, onSession)
    throw buildApiError('创建云端数据行失败', resp.status, data)
  }
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) throw new Error('云端初始化未返回数据')
  return {
    payload: rows[0]?.payload ?? payload,
    revision: requireRevision(rows[0]?.revision),
    session: nextSession,
  }
}

/** 乐观锁重试包装：冲突时重新执行 fn（fn 内部需重新读取最新状态）。 */
export async function withRetry(fn, { maxRetries = 3 } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (error?.code === 'CLOUD_REVISION_CONFLICT') {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw lastError || revisionConflict()
}
