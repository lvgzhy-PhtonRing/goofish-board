# 下架区与商品活力下架组实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 商品活力增加「下架/售出」分组；重发看板支持任意商品手动下架，并提供不占 15 件池的下架暂存区；下架动作同步店铺动态。

**Architecture:** 前端读取最新 CDP 在售快照与事件，计算商品状态；重发看板通过 store 的新 `manualOffline`/`removeOffline` 方法维护 OFFLINED 行；容量计算只统计 QUEUING + RETESTING。

**Tech Stack:** Vue 3 + Vitest + Supabase REST + JSONB board state。

**Spec:** `docs/superpowers/specs/2026-11-24-offline-area-and-vitality-groups-design.md`

## Global Constraints

- 不改变 CDP 抓取、YSP 售出判定、Excel 指标口径。
- OFFLINED 不占 15 件排队池。
- 下架事件必须写 `goofish_events`，来源 `user`。
- 历史补录日期：22 日、23 日；Plymouth 新 ID `1102427973542`。

## Review Focus

- CDP 快照缺失时不能把所有商品误判为下架。
- 已 OFFLINED 的商品刷新后不能被自动重新入队。
- 手动下架不得受 15 件池满限制。
- 下架区「确认重发」仍必须满 24 小时。
- 历史补录不得重复插入事件或覆盖 revision。

---

### Task 1: Store 下架区与容量语义

**Files:**
- Modify: `src/engine/republishStore.js`
- Test: `src/engine/republishStore.test.js`

**Interfaces:**
- Produces: `manualOffline(item, { offlinedAt }, now)`, `removeOffline(itemId, now)`
- Produces: `dashboard.offlined` 包含所有 OFFLINED，且不计入 `queueCapacity`

- [ ] **Step 1: 写失败测试**
  - 15 件排队 + 2 件 OFFLINED 时，`dashboard.queue.length === 15`。
  - `manualOffline` 把非池商品加入 `dashboard.offlined`，且不改变队列长度。
  - 刷新后 OFFLINED 商品仍在 `dashboard.offlined`，不在 `queue`。
  - `removeOffline` 后状态为 `CANCELED`，`dashboard.offlined` 不再包含。
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现容量语义与方法**
  - `QUEUE_STATUSES = new Set(['QUEUING', 'RETESTING'])`
  - `syncCandidates` 跳过 OFFLINED；候补与入池都跳过 OFFLINED。
  - `manualOffline` 接受任意 item，写 OFFLINED + OFFLINE 日志。
  - `removeOffline` 写 CANCELED + OFFLINE_REMOVE 日志。
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交**

### Task 2: 商品活力状态计算 helper

**Files:**
- Create: `src/services/vitalityStatus.js`
- Test: `src/services/vitalityStatus.test.js`

**Interfaces:**
- Produces: `buildVitalityStatus(items, shopStatus, events) -> { cdpAvailable, onSaleIds, statusById, cdpCount, missingCount, newCdpCount }`
- `statusById` 值：`{ key: 'onsale'|'sold'|'offline'|'missing'|'unknown', label, event? }`

- [ ] **Step 1: 写失败测试**
  - 在售/缺失/售出/下架/无事件/无快照六种状态。
  - `sold` 优先于 `offline`。
  - CDP 新品（不在 Excel）计入 `newCdpCount`。
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 实现 helper**
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交**

### Task 3: 商品活力 UI

**Files:**
- Modify: `src/services/automationApi.js`
- Modify: `src/modules/vitality/VitalityModule.vue`

**Interfaces:**
- Consumes: `buildVitalityStatus`
- Produces: `fetchShopStatus(config, session, onSession)`

- [ ] **Step 1: 加 API** `fetchShopStatus` 读取最新完整快照。
- [ ] **Step 2: 页面并行加载** vitality + shopStatus + events。
- [ ] **Step 3: 加标签** 全部 / 在售 / 下架·售出，显示数量。
- [ ] **Step 4: 加状态列与徽章** 在售、售出、下架、CDP 已无。
- [ ] **Step 5: 加差异提示** CDP 在售 N、Excel M、CDP 新品 K。
- [ ] **Step 6: 运行前端测试与构建**
- [ ] **Step 7: 提交**

### Task 4: 重发看板手动下架与下架区

**Files:**
- Modify: `src/modules/republish/RepublishModule.vue`

**Interfaces:**
- Consumes: `store.manualOffline`, `store.removeOffline`, `fetchShopStatus`, `loadRow`, `insertEvent`

- [ ] **Step 1: 手动下架弹窗**
  - 搜索全部 Excel + CDP 商品，排除已在 `dashboard.offlined` 的 ID。
  - 日期输入默认今天。
  - 每行显示缩略图、标题、ID、价格、当前状态。
- [ ] **Step 2: 提交流程**
  - 今日：`offlinedAt = now`；历史日期：`offlinedAt = ${date}T00:00:00+08:00`，事件加 `dateOnly: true`。
  - 调 `manualOffline`，成功后写 `offline` 事件，刷新看板。
- [ ] **Step 3: 下架区**
  - 标签改为「下架区（暂存）」，显示数量。
  - 卡片显示下架时间、倒计时、确认重发、移出暂存。
- [ ] **Step 4: 现有队列下架事件** 使用返回的 `offlinedAt` 写事件。
- [ ] **Step 5: 运行测试与构建**
- [ ] **Step 6: 提交**

### Task 5: 动态页日期补录展示

**Files:**
- Modify: `src/modules/archive/ArchiveModule.vue`

- [ ] **Step 1: `formatTime` 支持事件对象；`data.dateOnly` 显示「日期补录」。**
- [ ] **Step 2: 构建验证。**
- [ ] **Step 3: 提交。**

### Task 6: 部署与历史补录

- [ ] **Step 1: 测试 + 构建 + 推送 + 等 GitHub Pages。**
- [ ] **Step 2: 备份 board_state。**
- [ ] **Step 3: 写入 5 件 OFFLINED 行与事件；Plymouth 旧/新谱系与事件。**
- [ ] **Step 4: 浏览器验证**
  - 商品活力：全部 98 / 在售 92 / 下架·售出 6。
  - 重发看板：下架区 5 件，排队仍 15 件。
  - 店铺动态：22 日下架 2 件；23 日下架 4 件 + 重新上新 1 件。
- [ ] **Step 5: 提交收尾文档。**
