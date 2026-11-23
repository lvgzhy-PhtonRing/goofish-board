# goofish-board（店铺管理）

闲鱼商品活力与重发看板的独立部署站（Vue 3 纯 JS + Vite + Tailwind + FontAwesome），与 [YSP App](https://lvgzhy-phthonring.github.io/Ysp-app/) 双向互链。

## 功能

- **商品活力**：本地 goofish 程序导入 Excel 后「同步到云」，本站只读展示（排序、指标口径、数据时间）。
- **重发看板**：纯本地确定性规则（否决规则、重发更新指数、15 件池、24h 静置、72h 复测、每日配额、lineage 谱系），打卡状态存云端 Supabase。

## 架构

- 前端：Vue 3（纯 JS）+ Vite + Tailwind + FontAwesome，无 vue-router。
- 数据：专用 Supabase 项目两张 JSONB 快照表（`goofish_vitality`、`goofish_board_state`），RLS owner 限定。
- 写操作：revision 乐观锁 + 冲突重试。
- 视觉：设计令牌完全复制 YSP（色板、18px 圆角、`.apple-card`/`.btn`）。

## 开发

```bash
npm install
npm run dev
```

本地开发需要 `public/cloud-config.json`（从 `cloud-config.example.json` 复制并填入项目 URL 与 publishable key）。

## 构建 / 测试

```bash
npm test
npm run build
```

## 部署

GitHub Pages（`.github/workflows/deploy.yml`）：push `main` 时从 `CLOUD_CONFIG_JSON` secret 生成 `public/cloud-config.json`，测试通过后构建发布。

## 数据推送

本地 `goofish` 程序（`D:\Projects\goofish\ai-goofish-monitor-master`）导入 Excel 后点击「同步到云」，经 `POST /api/myshop/push-cloud` 写入 `goofish_vitality`。凭据仅存本地 `.env`：

```
GOOFISH_SUPABASE_URL=https://<ref>.supabase.co
GOOFISH_SUPABASE_SERVICE_KEY=<service-role-key>
GOOFISH_OWNER_ID=<auth-user-uid>
```
