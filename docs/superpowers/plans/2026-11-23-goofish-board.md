# 闲鱼店铺管理独立站（goofish-board）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 goofish 本地 web-ui 中的「商品活力」与「重发看板」剥离成独立 GitHub Pages 站（纯 JS，视觉完全对齐 YSP），数据走新建的专用 Supabase 项目，与 ysp-app 双向互链。

**Architecture:** Vue 3 纯 JS + Vite + Tailwind + FontAwesome（完全对齐 YSP 技术栈，无 router/Pinia/TS/shadcn-vue/lucide）。云端只有两张 JSONB 快照表（`goofish_vitality`、`goofish_board_state`），前端经 Supabase REST（手写 fetch 封装）登录读写；重发规则引擎由 Python 逐条移植为 JS，vitest 对照测试。写操作用 `revision` 乐观锁，冲突时重取重算重试。

**Tech Stack:** Vue 3.5 / Vite 8 / Tailwind 3.4 / @fortawesome/fontawesome-free 7 / vitest 2 / Supabase REST（无 SDK）

**Spec:** 对话中已批准的设计定稿（2026-11-23），规则语义以 `D:\Projects\goofish\ai-goofish-monitor-master\src\services\republish_service.py` 与其测试 `tests/test_republish_service.py` 为唯一基准；PRD 为 `docs/superpowers/specs/2026-11-23-republish-dashboard-design.md`。

## Global Constraints

- 纯 JavaScript：所有源文件无 TS、无 `lang="ts"`。
- 无 vue-router（`currentTab` ref + `v-if`）、无 Pinia、无 shadcn-vue/reka-ui/lucide。
- 视觉令牌完全复制 YSP：`appbg #F5F5F7`、`cardbg #FFFFFF`、`primary #0066CC`、`success #34C759`、`danger #FF3B30`、`warning #FF9500`、`apple 18px`、系统字体栈、`.apple-card`/`.apple-input`/`.btn-*`、FontAwesome solid 图标。
- 数据独立：新专用 Supabase 项目，与 ysp/Car/ETF 零共享。
- 公开仓库：仅 publishable/anon key 进 `cloud-config.json`；service key 只存本地 `.env`。
- 所有打卡写操作必须带 `revision` 乐观锁；前端串行队列保证单页面动作不交叉。
- 引擎语义以 Python 代码 + 测试为准（PRD 与代码冲突处以代码为准）。
- Vite `base: '/goofish-board/'`；界面全中文。

## Review Focus

- 缺失/空白指标（`""`、`"—"`、`"-"`、`"N/A"`、`"暂无"`、负数、`Infinity`）不得当作 0；这类商品进「数据不足」不参与诊断。
- 活力缓存过期（>36h）/不完整/非 7 天：可读但阻断新增诊断、复测开始、下架确认；已开始的静置倒计时保留，满 24h 的重发打卡仍允许。
- 双开标签写冲突：`revision` 不匹配时重取→重算→重试，禁止盲写覆盖。
- 时区：`fetched_at` 无时区字符串按浏览器本地时区解释；每日配额按本地日期计数。
- alicdn 图片防盗链：`referrerpolicy="no-referrer"` + 加载失败占位。
- 曝光为 0：CTR 按 0 参与评分（不得判为数据不足）；曝光缺失（`—`）才判数据不足。
- 池容量 15 与每日配额（上新+重发≥3 或重发≥2 锁定）在任何写路径都必须重新校验。

---

## 文件结构（新项目 D:\Projects\goofish-board）

```
index.html
package.json / vite.config.js / tailwind.config.js / postcss.config.js
.github/workflows/deploy.yml
public/cloud-config.example.json
src/main.js
src/style.css                      ← YSP 设计令牌（复制）
src/App.vue                        ← 侧边栏 + 登录门 + tab 内容区
src/components/AppSidebar.vue      ← 店铺管理侧边栏
src/components/LoginPanel.vue      ← YSP 风格登录卡片
src/services/supabaseClient.js     ← auth + REST + 乐观锁（照 cloudStore.js 模式）
src/services/cloudState.js         ← goofish_vitality / goofish_board_state 读写
src/engine/republish.js            ← 规则引擎（parseNumber/listingAgeDays/diagnoseItems/apiRow/常量）
src/engine/republishStore.js       ← 看板服务（getDashboard/startOptimization/recordNewListing/confirmOffline/confirmRepost/cancelItem）
src/engine/republish.test.js       ← vitest：逐条对照 Python 测试
src/modules/vitality/VitalityModule.vue
src/modules/republish/RepublishModule.vue
```

---

### Task 1: Supabase 专用项目 + 两表 + RLS + auth 用户

**Files:**
- Create: `docs/supabase/001-goofish-tables.sql`（本仓库存档，执行时用 MCP `apply_migration`）

**Interfaces:**
- Produces: 项目 ref / URL / publishable key / service key / owner auth uid；表 `goofish_vitality`、`goofish_board_state`（列 `id text pk`、`payload jsonb`、`owner_id uuid`、`revision bigint default 0`、`updated_at timestamptz default now()`）。

- [ ] **Step 1: 创建项目** — `tools.supabase_create_project`，organization `qeswrakhbrzytglsbkkz`（实际以 `supabase_list_organizations` 返回为准），name `goofish-board`，region `ap-northeast-1`。
- [ ] **Step 2: 建表+RLS** — `supabase.apply_migration` 执行：

```sql
create table if not exists public.goofish_vitality (
  id text primary key default 'main',
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.goofish_board_state (
  id text primary key default 'main',
  payload jsonb not null,
  owner_id uuid references auth.users(id),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.goofish_vitality enable row level security;
alter table public.goofish_board_state enable row level security;
create policy gv_owner_all on public.goofish_vitality for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy gb_owner_all on public.goofish_board_state for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.goofish_vitality, public.goofish_board_state to authenticated;
```

- [ ] **Step 3: 建登录用户** — Admin API `POST /auth/v1/admin/users`（service key）创建 `lvgzhy@gmail.com` 固定密码；记录 uid 为 `GOOFISH_OWNER_ID`。
- [ ] **Step 4: 验证** — 用 publishable key 匿名 SELECT 必须返回空数组（RLS 生效）；用登录 token SELECT 返回空但有权限。
- [ ] **Step 5: 记录凭据** — 项目 URL / publishable key 写入 `public/cloud-config.example.json`；URL / service key / owner uid / 登录密码 写入 goofish 本地 `.env`（绝不入库）。

### Task 2: 项目脚手架 + YSP 设计系统

**Files:**
- Create: `package.json`、`vite.config.js`、`tailwind.config.js`、`postcss.config.js`、`index.html`、`src/main.js`、`src/style.css`、`.gitignore`、`README.md`
- 复制 YSP：`src/style.css` 的 `.apple-card/.apple-input/.apple-select/.btn/.btn-primary/.btn-success/.btn-danger`、字体栈、滚动条；`tailwind.config.js` 色板。

**Interfaces:**
- Produces: `npm run dev/build/test` 可用；`base '/goofish-board/'`；FontAwesome 在 main.js 引入。

- [ ] **Step 1: package.json**（依赖：vue 3.5、@fortawesome/fontawesome-free 7、vite 8、@vitejs/plugin-vue 6、tailwindcss 3.4、postcss、autoprefixer、vitest 2）。
- [ ] **Step 2: 写配置与 style.css**（令牌逐值复制 YSP 并注明来源）。
- [ ] **Step 3: 验证** — `npm install && npm run build` 通过；`npm test` 输出 no tests（后续任务补上）。

### Task 3: Supabase 客户端（auth + 表读写 + 乐观锁）

**Files:**
- Create: `src/services/supabaseClient.js`、`src/services/cloudState.js`、`src/services/supabaseClient.test.js`
- 参考：`D:\Projects\ysp-app\src\services\cloudStore.js`

**Interfaces:**
- Produces:
  - `readCloudConfig(basePath='/'): Promise<{supabaseUrl, publishableKey}>`
  - `signIn(email, password): Promise<{accessToken, refreshToken, expiresAt, user:{id,email}}>`
  - `refreshSession(session)`、`signOut(session)`
  - `loadRow(table, session, {onSession}): Promise<{payload, revision}>`（无行返回 `{payload:null, revision:0}`）
  - `saveRow(table, session, payload, expectedRevision, {onSession}): Promise<{payload, revision}>`（PATCH `revision=eq.N`；0 行→抛 `CLOUD_REVISION_CONFLICT`；首次 INSERT）
  - `withRetry(fn, {maxRetries=3})`（冲突重取重算）

- [ ] **Step 1: 写失败测试**（fetch mock）：`saveRow` 冲突时抛 `CLOUD_REVISION_CONFLICT`；`signIn` 401 抛含"登录失败"；`loadRow` 空行返回 revision 0。
- [ ] **Step 2: 实现**（30s 超时、`apikey`+`Bearer` 双头、`Prefer: return=representation`、revision 校验）。
- [ ] **Step 3: 验证** `npm test` 通过。

### Task 4: 规则引擎 JS 移植 + vitest 对照测试

**Files:**
- Create: `src/engine/republish.js`、`src/engine/republish.test.js`
- 基准：`republish_service.py` L13-223（`MAX_CACHE_AGE`/`parse_vitality_cache`/`_number`/`_listing_age_days`/advice 常量/`diagnose_items`）。

**Interfaces:**
- Produces:
  - `parseVitalityCache(raw, now): {available, reason, range, complete, fetchedAt, ageHours, items}`
  - `parseNumber(value): number|null`、`listingAgeDays(createTime, now): number|null`
  - `diagnoseItems(items, now, roundById={}): {candidates, retest_eligible, protected, data_incomplete, observed}`
  - `apiRow(record, {recovered}): RepublishItem`（camelCase：itemId/lineageId/republishScore/ctr7d/…/repostAvailableAt/metricsMissing）
  - 常量 `VETO_REASONS`、`ADVICE_HIGH_EXPOSURE_LOW_CTR`、`ADVICE_MID_EXPOSURE_CTR`

移植要点（逐条对照）：
- `parseNumber`：空/`—`/`-`/`N/A`/`暂无`→null；非有限数或负数→null。
- `listingAgeDays`：本地日期差；未来时间→null；不可解析→null。
- 否决顺序：支付>0 → `PAYMENT_PROTECTION`；询单>0 → `INQUIRY_PROTECTION`；天数<7 → `NEW_LISTING`；轮次≥2 → `ROUND_LIMIT`。
- 指标任一缺失 → `METRICS_INCOMPLETE`（先否决后缺指标，顺序不可颠倒）。
- `ctrDecimal = exposure>0 ? views/exposure : 0`；`score = ageDays/(ctrDecimal+0.005)`；展示 `ctr7d = ctrDecimal*100`。
- P1：7≤天数<14 且 ctr<0.8；P2：天数≥14 且 ctr<1.5；仅展示标签。
- `retest_eligible`：7≤天数<14 且 0.8≤ctr<1.5。
- advice 顺序：`exposure>1000 && ctr<0.8` → 高曝光低 CTR 文案；`200≤exposure≤800 && 0.8≤ctr<1.5` → 中曝光文案；P1/默认文案。
- 无 itemId：`diagnosticKey = "missing-id-{index}"`，进 `data_incomplete`。

- [ ] **Step 1: 逐条移植 `test_diagnose_vetoes_and_priority_boundaries`**（含 `protected-sample`=P1、`zero-exposure`=P1 且 score=10/0.005、`p1-threshold` 进 retest、`non-finite` 进 incomplete）。
- [ ] **Step 2: 实现 `diagnoseItems` 等纯函数，跑通测试。**
- [ ] **Step 3: 移植 advice 测试**（3 条文案断言）。
- [ ] **Step 4: 移植 `parse_vitality_cache` 测试**（缺失/坏 JSON/坏时间戳/未来/过期/range=1/complete=false/legacy 无时区 +1h ≈ 1.0）。
- [ ] **Step 5: 验证** `npm test` 全绿。

### Task 5: 看板服务（republishStore）— 池同步/状态机/配额

**Files:**
- Create: `src/engine/republishStore.js`、`src/engine/republishStore.test.js`（内存 mock store，可注入 `now`/`readState`/`writeState`）

**Interfaces:**
- Produces:
  - `createRepublishStore({readState, writeState})` → `{getDashboard(now), startOptimization(itemId, now), recordNewListing(now), confirmOffline(itemId, checks, now), confirmRepost(itemId, newId, now), cancelItem(itemId, now)}`
  - 状态对象：`{pool: Record<itemId, Row>, logs: Log[], revision}`；Row camelCase 字段同 `apiRow` 输入。

移植要点：
- `getDashboard`：缓存可用才 `syncCandidates`（容量 15、PROTECTED/ARCHIVED 保护、`ITEM_NOT_IN_CACHE`、REENTRY 保留 lineage 轮次）；周日（`now.getDay()===6`）且 observed ctr≥1.5 → `recovered=true`（不自动移出）；quota 由 logs 按本地日期计数；`picUrl` 从缓存补齐。
- `startOptimization`：仅 retest_eligible 且状态允许；池满 15 拒绝；写 RETESTING + 基线 CTR + 72h 计时 + OPTIMIZE 日志。
- `confirmOffline`：双 checklist 必真；状态必须 QUEUING；日配额检查；写 OFFLINED + `offlinedAt` + OFFLINE 日志；**OFFLINED 即使新缓存触发保护也保留倒计时**。
- `confirmRepost`：状态必须 OFFLINED；满 24h；日配额；新 ID 非空/≤64/不等于旧 ID/不在 pool/不在当前缓存；轮次+1（>2 拒绝）；旧行 REPOSTED，新行 PROTECTED（轮次≥2 则 ARCHIVED）+ lineage 继承；REPOST+ARCHIVE 日志。
- `cancelItem`：仅周日；observed ctr≥1.5；QUEUING/RETESTING→CANCELED + CANCEL 日志。
- 每次写状态前重新读 revision 校验配额与容量（等价 BEGIN IMMEDIATE）；冲突抛 `CLOUD_REVISION_CONFLICT` 由 Task 3 `withRetry` 重试。
- 72h 复测：RETESTING 且已满 72h → ctr≥1.5 则 RETEST_PASS→PROTECTED；否则 RETEST_FAIL→QUEUING(P2)。71:59:59 仍留 RETESTING。

- [ ] **Step 1: 移植容量/终态/周复测测试**（15 队列 + 2 候补；CANCELED/ARCHIVED 不变；周 recovered flag）。
- [ ] **Step 2: 移植 reentry/过期缓存/缺 ID/OFFLINED 保护保持测试。**
- [ ] **Step 3: 移植 offline→24h→repost（lineage 轮次、新 ID 冲突拒绝、metricsMissing）测试。**
- [ ] **Step 4: 移植复测 72h 边界/通过/失败测试；配额 2/3 锁定与本地午夜重置测试。**
- [ ] **Step 5: 实现并全绿。**

### Task 6: 应用外壳（侧边栏/登录/路由 tab）

**Files:**
- Create: `index.html`、`src/main.js`、`src/App.vue`、`src/components/AppSidebar.vue`、`src/components/LoginPanel.vue`、`src/style.css`
- 参考：`D:\Projects\ysp-app\src\App.vue`（tabs 模式）、`AppSidebar.vue`（视觉）

**Interfaces:**
- Produces: 登录门（未登录显示 LoginPanel）；登录后侧边栏「商品活力 / 重发看板」两项 + 底部「返回主程序」外链；tab 内容区挂两个模块；会话 localStorage 持久化（独立 key `goofish_session`）。

- [ ] **Step 1: 布局与视觉**（w-56 白侧边栏、分组竖条、`.apple-card` 内容区、`#F5F5F7` 背景、FontAwesome 图标）。
- [ ] **Step 2: 登录流程**（读 cloud-config → signIn → 存 session → 过期 refresh → 401 清会话回登录）。
- [ ] **Step 3: 验证** `npm run build` 通过；dev 下未登录见登录卡，登录后见两 tab。

### Task 7: 商品活力模块

**Files:**
- Create: `src/modules/vitality/VitalityModule.vue`
- 参考：`web-ui/src/views/ProductVitalityView.vue`（11 列、排序、来源提示）

**Interfaces:**
- Consumes: `loadRow('goofish_vitality')`；字段 `itemId/title/price/stock/sales/createTime/picUrl/exposure/viewCount/inquiry/payCount/conversion/metricsMissing`。
- Produces: 表格（列排序）、数据时间/范围提示、空态、错误态；只读（导入仍在本地 goofish 程序）。

- [ ] **Step 1: 表格 + 排序 + 指标"—"显示（metricsMissing）**。
- [ ] **Step 2: 数据状态横幅**（fetched_at、range、complete、条数）。
- [ ] **Step 3: 验证** mock 数据渲染与排序断言（vitest 组件测试或手测构建）。

### Task 8: 重发看板模块

**Files:**
- Create: `src/modules/republish/RepublishModule.vue`
- 参考：`web-ui/src/views/RepublishView.vue`（Top3 卡、三 Tab、配额卡、打卡弹窗、倒计时）

**Interfaces:**
- Consumes: `getDashboard` + 5 个动作；`RepublishItem` 字段同 `apiRow` 输出。
- Produces: 完整交互（记录上新/优化复测/下架静置/确认重发/周日移出）、loading/empty/error/locked 状态、每分钟刷新倒计时、YSP 视觉（rose/amber/emerald 语义色保留）。

- [ ] **Step 1: 配额卡 + Top3 动作卡（含图片 no-referrer + 占位）**。
- [ ] **Step 2: 三 Tab（队列/静置/保护）+ 复测区 + 候补列表**。
- [ ] **Step 3: 打卡动作与弹窗（新 ID 输入）+ toast**。
- [ ] **Step 4: 验证** `npm run build`；动作路径用 store 单测覆盖（UI 手测）。

### Task 9: 本地 Python 推送链路（goofish 项目内）

**Files:**
- Create: `D:\Projects\goofish\ai-goofish-monitor-master\src\services\cloud_push.py`
- Modify: `src/api/routes/myshop.py`（新增 `POST /push-cloud`）、`web-ui/src/api/myshop.ts`（`pushVitalityToCloud`）、`web-ui/src/views/ProductVitalityView.vue`（「同步到云」按钮）、`.env.example`（3 个变量）
- Test: `tests/test_cloud_push.py`

**Interfaces:**
- `push_vitality(payload: dict, *, url, service_key, owner_id, session=None) -> dict`：POST/PATCH `goofish_vitality`，revision 重试 3 次；缺配置抛 `CloudPushError`。
- 环境变量：`GOOFISH_SUPABASE_URL`、`GOOFISH_SUPABASE_SERVICE_KEY`、`GOOFISH_OWNER_ID`。

- [ ] **Step 1: 写测试**（mock `urllib.request`）：成功推送返回 `{ok, count, pushed_at}`；未配置抛错；409 冲突重试后成功。
- [ ] **Step 2: 实现 + 路由 + 按钮**（读 `state/vitality_data.json` 原样 payload 推送）。
- [ ] **Step 3: 验证** `pytest tests/test_cloud_push.py -v` 通过；本地启动后点按钮，Supabase 行出现。

### Task 10: YSP 侧边栏入口（唯一改动）

**Files:**
- Modify: `D:\Projects\ysp-app\src\components\AppSidebar.vue`（采购组 rushcar 按钮下方插入外链）

**Interfaces:**
- Produces: `<a href="https://lvgzhy-phtonring.github.io/goofish-board/" target="_blank" rel="noopener">`，样式与侧边栏按钮同款（`px-4 py-3 rounded-xl text-base font-bold flex items-center gap-3`，`fa-store` 图标），文案「店铺管理」。

- [ ] **Step 1: 模板插入**（`v-if="tab.id === 'rushcar'"` 同级渲染外链）。
- [ ] **Step 2: 验证** `npm run build` 通过；视觉与「美淘记录」对齐；其余不动。

### Task 11: 部署 + 互链 + 端到端验证

**Files:**
- Create: `.github/workflows/deploy.yml`（照抄 ysp-app，`CLOUD_CONFIG_JSON` secret 校验仅 publishable key）、`public/cloud-config.example.json`、`README.md`
- Modify: `src/App.vue` 底部「返回主程序」→ `https://lvgzhy-phtonring.github.io/Ysp-app/`

- [ ] **Step 1: workflow + 示例配置**。
- [ ] **Step 2: `gh repo create`（public）+ push + 设置 Pages（GitHub Actions 源）+ 配置 secret `CLOUD_CONFIG_JSON`**。
- [ ] **Step 3: 端到端**：本地 Excel 导入 → 推送云端 → Pages 站登录 → 商品活力 100 件 → 重发看板 Top3/配额 → 打卡一次 → 刷新持久化 → ysp-app 侧边栏入口可跳转。
- [ ] **Step 4: 冒烟断言**：RLS 匿名读为空；错误密码登录失败；双标签同时打卡其一冲突重试成功。

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 规则引擎移植语义漂移 | 逐条移植 Python 测试用例；Review Focus 专项断言 |
| 浏览器/主机时区差异 | 统一按浏览器本地时区；测试注入固定 now |
| alicdn 图片 403 | `referrerpolicy="no-referrer"` + onerror 占位 |
| Supabase 免费层限制 | 仅 2 表、整块 JSONB，远低于配额 |
| 公开仓库泄露凭据 | service key 仅本地 .env；workflow 校验仅 publishable key |
| 前端双写覆盖 | revision 乐观锁 + withRetry + 动作串行队列 |

## 执行方式

用户已指定：继续直至实施（Native 方式，本会话直接实施）。
