import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRow, normalizeCloudConfig, saveRow, signIn, withRetry } from './supabaseClient.js'

const config = normalizeCloudConfig({
  supabaseUrl: 'https://x.supabase.co',
  publishableKey: 'sb_publishable_test',
})
const session = {
  accessToken: 'token',
  refreshToken: 'r',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'u1', email: 'a@b.c' },
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('supabaseClient', () => {
  it('normalizes cloud config', () => {
    expect(config.supabaseUrl).toBe('https://x.supabase.co')
    expect(config.publishableKey).toBe('sb_publishable_test')
  })

  it('signs in with password grant and maps the session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const next = await signIn(config, 'a@b.c', 'pw')
    expect(next.accessToken).toBe('at')
    expect(fetchMock.mock.calls[0][0]).toContain('grant_type=password')
  })

  it('reports a clear login error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ msg: 'Invalid login credentials' }, 400)))
    await expect(signIn(config, 'a', 'b')).rejects.toThrow('登录失败')
  })

  it('returns revision 0 and exists=false when the row does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    const result = await loadRow(config, 'goofish_board_state', session)
    expect(result.revision).toBe(0)
    expect(result.exists).toBe(false)
    expect(result.payload).toBeNull()
  })

  it('clears the session and raises AUTH_EXPIRED on 401', async () => {
    const onSession = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'JWT expired' }, 401)))
    await expect(loadRow(config, 'goofish_board_state', session, { onSession })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    })
    expect(onSession).toHaveBeenCalledWith(null)
  })

  it('flags a revision conflict when the patch matches nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    await expect(saveRow(config, 'goofish_board_state', session, { a: 1 }, 2)).rejects.toMatchObject({
      code: 'CLOUD_REVISION_CONFLICT',
    })
  })

  it('inserts the first row with revision 1 and owner id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ payload: { a: 1 }, revision: 1 }], 201))
    vi.stubGlobal('fetch', fetchMock)
    const result = await saveRow(config, 'goofish_board_state', session, { a: 1 }, 0, { exists: false })
    expect(result.revision).toBe(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body[0].revision).toBe(1)
    expect(body[0].owner_id).toBe('u1')
  })

  it('patches an existing row using revision=eq.N and increments', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ payload: { a: 2 }, revision: 3 }]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await saveRow(config, 'goofish_board_state', session, { a: 2 }, 2)

    expect(result.revision).toBe(3)
    expect(fetchMock.mock.calls[0][0]).toContain('revision=eq.2')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.revision).toBe(3)
  })

  it('retries revision conflicts', async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts += 1
      if (attempts < 2) {
        const error = new Error('conflict')
        error.code = 'CLOUD_REVISION_CONFLICT'
        throw error
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
  })
})
