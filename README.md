# 飞书多维表格订单 → 聚水潭建单（一键发货同步）

将飞书多维表格中勾选"确认发货"的订单，自动在聚水潭手工建单，并把内部单号、快递单号回写到飞书表格。

## 功能

- 定时扫描飞书表格中「确认发货 = 勾选」的记录
- 调用聚水潭开放平台接口手工建单（`/open/jushuitan/orders/upload`）
- 建单成功后查询订单详情，回写「建单内部单号」和「快递单号」
- 支持补全模式：为历史记录补全缺失的内部单号 / 快递单号
- 防重复机制：通过「上传状态」字段避免重复建单

## 目录结构

```
jushuitan-feishu-sync/
├── jushuitan-feishu-sync.js   # 主脚本
├── .env.example               # 环境变量模板（复制为 .env 使用）
├── package.json
└── README.md
```

## 快速开始

```bash
# 1. 安装依赖（服务模式需要 express）
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入真实的聚水潭 / 飞书凭证

# 3. 运行
node jushuitan-feishu-sync.js            # 手动同步一次后退出
SERVICE_MODE=true node jushuitan-feishu-sync.js   # 常驻服务 + 定时同步（默认每60秒）
MODE=backfill node jushuitan-feishu-sync.js       # 一次性补全历史记录
```

### 运行模式

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| 手动同步 | `node jushuitan-feishu-sync.js` | 同步一次后退出 |
| 常驻服务 | `SERVICE_MODE=true node jushuitan-feishu-sync.js` | HTTP 服务（`/sync-orders`）+ 定时同步 |
| 补全内部单号 | `MODE=backfill node jushuitan-feishu-sync.js` | 补全一次后退出 |
| 自动补全 | `MODE=autofill node jushuitan-feishu-sync.js` | 每 30 分钟补全一次 |

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `JUSHUITAN_APP_KEY` | ✅ | 聚水潭开放平台应用 Key |
| `JUSHUITAN_APP_SECRET` | ✅ | 聚水潭开放平台应用 Secret |
| `JUSHUITAN_ACCESS_TOKEN` | ✅ | 聚水潭 Access Token |
| `JUSHUITAN_SHOP_ID` | ⚠️ | 默认店铺 ID（无店铺映射时使用） |
| `SHOP_ID_MAP` | - | JSON 店铺映射，如 `{"店铺选项ID":店铺ID}` |
| `BUYER_NICK` | ⚠️ | 建单买家账号 |
| `FEISHU_APP_ID` | ✅ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书应用 Secret |
| `FEISHU_APP_TOKEN` | ✅ | 飞书多维表格 App Token |
| `FEISHU_TABLE_ID` | ✅ | 飞书多维表格数据表 ID |

完整配置项见 [.env.example](./.env.example)。

## 安全说明

- 本仓库**不含任何真实凭证**，所有密钥通过环境变量 / `.env` 注入
- `.env` 已被 `.gitignore` 忽略，**严禁提交到 Git**
- 若曾把含凭证的旧脚本提交到过仓库，请立即：
  1. 删除仓库中的旧版本
  2. 到对应开放平台**重置密钥**（旧密钥一旦泄露必须作废）

## License

MIT
