# Excel 驱动自动看板 + 商品档案 实施计划

> 2026-11-24 批准执行。设计见对话与 `docs/superpowers/specs/2026-11-24-excel-automation-design.md`（本计划为准）。

**Goal:** 导入经营罗盘 Excel 后自动识别商品上下架/售出/改价/成交/重发关联，生成待确认项；新增「商品档案」tab 查询历史。

**Tech Stack:** Python（本地唯一写入方）+ Vue 3 纯 JS（只读展示 + 点选确认）+ Supabase JSONB/关系表。

## Global Constraints
- 高置信（≥0.8）自动处理；0.5–0.8 生成待确认；<0.5 忽略。
- 待确认项一律点选（2–3 个按钮），默认建议高亮。
- 池状态由本地 Python 统一写入（服务端唯一真源）；前端点选只写确认结果。
- YSP 只读、仅 PhtonRIng；凭据只存本地 .env。
- 现有 41+11 测试必须保持全绿。

## Task 1: 云端新表
- `goofish_snapshots`（id bigserial, fetched_at, count, payload jsonb, created_at）
- `goofish_events`（id bigserial, item_id, lineage_id, type, occurred_at, data jsonb）
- `goofish_pending`（id uuid, item_id, kind, question, options jsonb, suggestion, status, resolution, created_at, resolved_at）
- RLS owner 限定 + revoke anon + grant authenticated。

## Task 2: 本地管线 `src/services/vitality_pipeline.py`
1. 读上次快照（云端 goofish_snapshots 最新，或本地 state 缓存兜底）
2. 解析新 Excel
3. diff → events：`discovered` / `price_change` / `title_change` / `image_change` / `pay_increment` / `refund_increment` / `offline`
4. YSP 只读匹配（可配置，未配置则跳过）→ `sold` 高置信或 `pending` Q3
5. AI 关联：新增 × 最近 30 天 offline 商品 → 规则分 + LLM → ≥0.8 自动 `repost`，0.5–0.8 `pending` Q4
6. 生成 pending：Q1 消失、Q2 售出仍在、Q3 未记账成交、Q4 低置信关联、Q5 退款
7. 推送：vitality 快照、snapshots、events、pending、board_state 同步（幂等）

## Task 3: 前端「待确认」中心
- 看板顶部角标「待确认 N 项」，导入后自动展开
- 点选清单：每项文字 + 2–3 按钮（默认高亮）+ 「全部按建议处理」
- 点选后 PATCH `goofish_pending`（status/resolution）

## Task 4: 「商品档案」tab
- 列表：标题/ID/谱系/上架次数/下架次数/成交次数/最近状态
- 点开时间线：discovered → sold → offline → repost → price_change

## Task 5: YSP 只读适配器
- `.env`: `YSP_SUPABASE_URL` / `YSP_SUPABASE_ANON_KEY` / `YSP_ACCOUNT_EMAIL` / `YSP_ACCOUNT_PASSWORD`
- 登录 YSP → 读 `ysp_state.main` → items 中 `status=sold` 且 `saleDetails.shop=PhtonRIng`
- 匹配：日期+金额 → 关键词 → AI 兜底

## Task 6: 部署与验证
- SQL 执行、测试全绿、构建、部署、E2E（导入 → 待确认 → 点选 → 档案时间线）
