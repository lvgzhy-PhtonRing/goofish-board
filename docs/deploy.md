# 部署指南

## 架构

```
本地 goofish（Python）                     云（专用 Supabase 项目）            GitHub Pages
Excel 导入 → state/vitality_data.json  ──▶  goofish_vitality (JSONB)     ──▶  goofish-board 站点
「同步到云」按钮 / POST /push-cloud          goofish_board_state (JSONB)        商品活力 / 重发看板
（凭据仅本地 .env）                         RLS: owner 限定                    登录后读写
```

- 仓库：`github.com/lvgzhy-PhtonRing/goofish-board`（公开，代码）+ 专用 Supabase 项目（数据私有）。
- 主程序：`github.com/lvgzhy-PhtonRing/Ysp-app`（已加「店铺管理」入口）。

---

## 一、日常发布（已部署环境，最常用）

```bash
cd D:\Projects\goofish-board

# 1) 本地验证（必须）
npm test          # 41 个测试应全绿
npm run build     # 构建通过

# 2) 提交并推送
git add -A
git commit -m "feat/fix: ..."
git push origin main
```

推送后 GitHub Actions 自动执行：

```
生成 public/cloud-config.json（仅 supabaseUrl + publishableKey，白名单）
→ npm ci → npm test → npm run build
→ 断言产物只含 publishableKey/supabaseUrl
→ 上传并部署到 GitHub Pages
```

验证：

```bash
gh run list --repo lvgzhy-PhtonRing/goofish-board --limit 3
# 打开 https://lvgzhy-phtonring.github.io/goofish-board/
```

> CI 中 `npm test` 不通过、或 `CLOUD_CONFIG_JSON` secret 缺失，部署会直接失败，不会发布坏站。

---

## 二、手动触发 / 回滚

**手动重新部署当前 main：**

```bash
gh workflow run deploy.yml --repo lvgzhy-PhtonRing/goofish-board
gh run list --repo lvgzhy-PhtonRing/goofish-board --limit 1
```

**回滚到上一个提交：**

```bash
git revert <bad-commit>
git push origin main   # 触发自动部署
```

---

## 三、从零部署（换电脑 / 灾备 / 新环境）

### 1. 创建 Supabase 专用项目

1. Supabase 控制台新建项目（建议与现有项目同区，如 `ap-northeast-1`）。
2. 在 SQL Editor 执行 `docs/supabase/001-goofish-tables.sql`（建两张表 + RLS + revoke anon + updated_at 触发器）。
3. 创建登录用户（二选一）：
   - Dashboard → Authentication → Users → Add user（邮箱 + 密码，勾选 email confirmed）；
   - 或用 service key 调 Admin API：
     ```
     POST https://<ref>.supabase.co/auth/v1/admin/users
     { "email": "...", "password": "...", "email_confirm": true }
     ```
4. 记录三项：项目 URL、publishable key（`sb_publishable_...`）、新建用户的 UUID。

### 2. 配置 GitHub 仓库

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**。
2. Settings → Secrets and variables → Actions → 新建 `CLOUD_CONFIG_JSON`：

```json
{"supabaseUrl":"https://<ref>.supabase.co","publishableKey":"sb_publishable_..."}
```

> 该 secret **绝不能**包含 service key；CI 会用白名单重建产物并在部署前断言。

### 3. 配置本地 goofish 推送

在 `D:\Projects\goofish\ai-goofish-monitor-master\.env` 追加：

```dotenv
GOOFISH_SUPABASE_URL=https://<ref>.supabase.co
GOOFISH_SUPABASE_SERVICE_KEY=<service-role-key>
GOOFISH_OWNER_ID=<auth-user-uuid>
```

> service key 只放本地 `.env`（已被 .gitignore）。缺少 `GOOFISH_OWNER_ID` 时推送会明确报错（避免"推送成功但站点永远看不见"）。

### 4. 启动本地服务并推数据

```bash
启动.bat   # 或 .venv\Scripts\python.exe -m src.app
```

打开 `http://127.0.0.1:8000` → 商品活力 → 导入 Excel → 点「同步到云」。

### 5. 主程序入口（YSP）

`ysp-app/src/components/AppSidebar.vue` 在采购组 `rushcar`（美淘记录）后渲染「店铺管理」外链：

```html
<a href="https://lvgzhy-phtonring.github.io/goofish-board/" target="_blank" rel="noopener">店铺管理</a>
```

### 6. 部署验收

按 [测试计划](superpowers/specs/2026-11-23-goofish-board-test-plan.md) 执行：

- L1：页面 200、`cloud-config.json` 无 service key、匿名读 401/空、登录成功
- L2：同步后云端条数正确
- L3：两模块渲染、打卡、刷新持久化
- L5：YSP 与本地 goofish 构建通过

---

## 四、凭据清单与轮换

| 凭据 | 存放位置 | 泄露应急 |
|------|----------|----------|
| service key | 本地 goofish `.env` | Supabase 控制台重置 → 更新 `.env` |
| publishable key | GitHub secret `CLOUD_CONFIG_JSON` + 线上 `cloud-config.json` | 同上 → 更新 secret → 重新部署 |
| 登录密码 | Supabase Auth | Admin API 改密或 Dashboard 重置 |
| Supabase PAT | 仅部署时一次性使用 | 控制台吊销 |
| 数据库密码 | 仅项目创建时使用 | 控制台 Reset password |

---

## 五、常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 站点显示「云端配置缺失」 | secret 未配置或产物生成失败 | 检查 Actions 日志与 `CLOUD_CONFIG_JSON` |
| 「同步到云」提示未配置 | 本地 `.env` 缺 `GOOFISH_*` | 补齐三项后重启服务 |
| 推送成功但站点无数据 | `GOOFISH_OWNER_ID` 与登录用户不一致 | 核对 .env 的 UUID = Auth 用户 id |
| 看板提示数据超过 36 小时 | 活力缓存过期 | 本地重新导入 Excel → 同步 |
| 登录后操作全失败 | 会话过期/被吊销 | 退出后重新登录（401 会自动回登录页） |
| 部署失败但代码无问题 | `npm test` 未通过 / secret 格式错 | 看失败日志，修复后重新 push |
