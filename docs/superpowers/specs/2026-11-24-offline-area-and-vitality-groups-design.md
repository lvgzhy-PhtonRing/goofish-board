# 下架区与商品活力下架组设计

## 目标

1. 商品活力能区分「CDP 仍在售」与「CDP 已无（下架/售出）」。
2. 重发看板允许用户手动下架任意商品，并进入独立的下架暂存区。
3. 下架动作同步写入店铺动态，动态页按所选日期展示。
4. 下架暂存区不占用 15 件重发排队池容量。
5. 补录已知历史下架记录与 Plymouth 重发谱系。

## 非目标

- 不改变 CDP 抓取逻辑与 YSP 售出判定逻辑。
- 不自动把「CDP 已无」判定为售出；只按已有事件标记。
- 不改变 Excel 导入与商品活力指标口径。

## 关键决策

| 决策 | 结论 |
|---|---|
| 在售判定 | 最新 `complete=true` 的 `goofish_shop_status.payload.items` |
| 下架/售出分组 | 商品活力增加「全部 / 在售 / 下架·售出」三个标签 |
| 状态徽章 | 在售、售出（`sold` 事件）、下架（`offline` 事件）、CDP 已无（无事件） |
| 手动下架入口 | 重发看板「手动下架」弹窗，搜索全部 Excel + CDP 商品 |
| 排队顺序 | 队列成员按分层规则入池；展示与优先动作按重发更新指数（权重）降序 |
| 下架日期 | 日期选择，默认今天；历史日期按当天 00:00 记录 |
| 下架区容量 | 独立于 15 件排队池，OFFLINED 不计入容量 |
| 下架区出口 | 「确认重发」（原有）或「移出暂存」（新，状态 CANCELED） |
| 动态写入 | 每次下架写 `goofish_events(type=offline, data.source=user, occurred_at=所选日期)` |
| 历史补录 | 5 件已知下架 + Plymouth 旧链接下架 + 新链接 repost 事件与谱系 |

## 数据与接口

### republishStore

- `manualOffline(item, { offlinedAt }, now)`：任意商品进入 OFFLINED；不校验候选资格、不占队列容量。
- `removeOffline(itemId, now)`：OFFLINED → CANCELED，记录 `OFFLINE_REMOVE` 日志。
- 容量语义：`QUEUING` + `RETESTING` 计数上限 15；`OFFLINED` 不计入。
- `syncCandidates` 遇到 OFFLINED 直接跳过，不重新入队、不进入候补。

### 前端

- `automationApi.fetchShopStatus(config, session, onSession)`：读取最新完整快照。
- `vitalityStatus.buildVitalityStatus(items, shopStatus, events)`：生成在售集合、缺失集合、每件商品状态徽章。
- 商品活力：三标签 + 状态列 + CDP/Excel 差异提示。
- 重发看板：手动下架弹窗、下架区标签、移出暂存按钮。

## 边界与失败处理

- CDP 快照不存在/不完整：商品活力只显示「全部」，提示尚未抓取；不把全部商品误判为下架。
- 手动下架事件写入失败：看板状态仍成功，动态缺失由用户刷新/补录处理（与现有一致）。
- 已 OFFLINED 商品重复下架：只更新下架日期，不重复写事件。
- 已 REPOSTED/CANCELED/ARCHIVED 商品：拒绝再次下架。
- 下架日期晚于当前时间：拒绝。
- 离线区条目不计入 15 件池，队列仍可保持 15 件。

## 历史补录

- 22 日下架：TLV 超级剪影 前期型 `1039553358909`、后期型 `1015669209411`。
- 23 日下架：保时捷 91 `1070282716069`、MINIGT 130 `1035388879423`、TOMICA `1013466268784`、Plymouth 旧链接 `1099075416769`。
- Plymouth 新链接 `1102427973542`：23 日 14:40 重新上架，旧→新谱系，轮次 1。
