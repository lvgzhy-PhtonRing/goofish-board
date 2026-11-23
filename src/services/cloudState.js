// 看板数据通道：把 Supabase 两张快照表适配成 republishStore 需要的读写接口。
import { loadRow, saveRow } from './supabaseClient.js'

export const VITALITY_TABLE = 'goofish_vitality'
export const BOARD_TABLE = 'goofish_board_state'

/**
 * @param {object} options
 * @param {object} options.config  normalizeCloudConfig 结果
 * @param {() => object|null} options.getSession  当前会话（可能被 refresh 替换）
 * @param {(session: object) => void} options.onSession  会话更新回调
 */
export function createCloudStore({ config, getSession, onSession }) {
  return {
    async readState() {
      const { payload, revision } = await loadRow(config, BOARD_TABLE, getSession(), { onSession })
      return { payload, revision }
    },
    async writeState(state, revision) {
      const { payload, revision: nextRevision } = await saveRow(
        config,
        BOARD_TABLE,
        getSession(),
        state,
        revision,
        { onSession },
      )
      return { payload, revision: nextRevision }
    },
    async readVitality() {
      const { payload } = await loadRow(config, VITALITY_TABLE, getSession(), { onSession })
      return payload
    },
  }
}
