# 飞书多维表格订单 → 聚水潭建单（一键发货同步）

将飞书多维表格中勾选「确认发货」的订单，自动在聚水潭手工建单，并把内部单号、快递单号回写到飞书表格。

适用于电商仓储发货场景：运营在飞书多维表格维护订单信息，勾选确认发货后，脚本自动在聚水潭创建手工订单并回填结果，全程无需登录聚水潭后台。

## 功能特性

- **一键触发**：飞书表格中勾选「确认发货」即触发建单
- **自动建单**：调用聚水潭 `/open/jushuitan/orders/upload` 接口创建手工订单
- **自动回写**：建单后查询订单详情，回写内部单号和快递单号
- **店铺映射**：根据表格中「店铺」字段自动匹配聚水潭店铺 ID
- **防重复**：通过「上传状态」字段标记已处理订单，避免重复建单
- **补全模式**：为历史记录补全缺失的内部单号 / 快递单号（支持定时自动补全）
- **常驻服务**：内置 Express HTTP 服务，支持定时轮询和手动触发
- **零依赖 .env**：内置极简 .env 加载器，无需 dotenv 等额外依赖

## 工作流程

```
飞书多维表格                本脚本                聚水潭开放平台
     │                          │                        │
     │  勾选「确认发货」         │                        │
     │ ─────────────────────►  │                        │
     │                          │  创建手工建单           │
     │                          │ ────────────────────►  │
     │                          │  返回内部单号 o_id     │
     │                          │ ◄────────────────────  │
     │                          │  查询订单详情           │
     │                          │ ────────────────────►  │
     │                          │  返回快递单号           │
     │                          │ ◄────────────────────  │
     │  回写内部单号、快递单号   │                        │
     │ ◄─────────────────────  │                        │
```

## 目录结构

```
jushuitan-feishu-sync/
├── jushuitan-feishu-sync.js   # 主脚本（全部逻辑在单文件中）
├── .env.example               # 环境变量模板（复制为 .env 使用）
├── .gitignore                 # Git 忽略规则
├── package.json
└── README.md
```

## 快速开始

### 前置要求

- Node.js >= 14
- 聚水潭开放平台应用（需有建单和查单权限）
- 飞书开放平台自建应用（需有多维表格读写权限）
- 飞书多维表格中已配置好以下字段（名称需一致）：

| 字段名       | 类型   | 说明                         |
| ------------ | ------ | ---------------------------- |
| 确认发货     | 复选框 | 触发建单的开关，同时回写结果 |
| 上传状态     | 文本   | 防重复标记，自动维护         |
| 建单内部单号 | 文本   | 自动回写聚水潭 o_id          |
| 快递单号     | 文本   | 自动回写物流单号             |
| 线上订单号   | 文本   | 商家订单号 so_id             |
| 商品编码     | 文本   | SKU 编码                     |
| 款名         | 文本   | 商品名称                     |
| 颜色         | 单选   | SKU 属性                     |
| 码数         | 文本   | SKU 属性                     |
| 件数         | 数字   | 购买数量                     |
| 收货人       | 文本   | 收件人姓名                   |
| 手机号       | 文本   | 收件人手机号                 |
| 详细地址     | 文本   | 收件人地址                   |
| 店铺         | 单选   | 用于匹配聚水潭店铺 ID        |
| 快递公司     | 单选   | 顺丰空运 / 顺丰陆运 / 中通   |

### 安装与配置

```bash
# 1. 克隆项目
git clone https://github.com/jiangjiang-linglong/jushuitan-feishu-sync.git
cd jushuitan-feishu-sync

# 2. 安装依赖（常驻服务模式需要 express）
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入真实的聚水潭 / 飞书凭证
```

### 运行模式

| 模式       | 命令                                                            | 说明                     |
| ---------- | --------------------------------------------------------------- | ------------------------ |
| 手动同步   | `node jushuitan-feishu-sync.js`                                 | 同步一次后退出           |
| 常驻服务   | `SERVICE_MODE=true node jushuitan-feishu-sync.js`              | HTTP 服务 + 每 60 秒自动同步 |
| 补全单号   | `MODE=backfill node jushuitan-feishu-sync.js`                  | 一次性补全历史记录后退出 |
| 自动补全   | `MODE=autofill node jushuitan-feishu-sync.js`                  | HTTP 服务 + 每 30 分钟自动补全 |

### npm scripts

```bash
npm start       # 手动同步一次
npm run sync    # 同 npm start
npm run backfill # 补全内部单号/快递单号
npm run autofill # 自动补全模式
```

## HTTP 接口

常驻服务模式下提供以下接口（默认端口 3003）：

| 方法   | 路径             | 说明                     |
| ------ | ---------------- | ------------------------ |
| GET    | `/health`        | 健康检查，返回 `{status: "ok"}` |
| POST   | `/sync-orders`   | 手动触发一次订单同步     |
| POST   | `/backfill`      | 手动触发一次补全（仅 autofill 模式） |

## 环境变量

| 变量                    | 必填 | 说明                                               |
| ----------------------- | ---- | -------------------------------------------------- |
| `JUSHUITAN_APP_KEY`     | ✅   | 聚水潭开放平台应用 Key                             |
| `JUSHUITAN_APP_SECRET`  | ✅   | 聚水潭开放平台应用 Secret                          |
| `JUSHUITAN_ACCESS_TOKEN`| ✅   | 聚水潭 Access Token                                 |
| `JUSHUITAN_API_BASE`    | -    | API 地址，默认 `https://openapi.jushuitan.com`    |
| `JUSHUITAN_SHOP_ID`     | ⚠️   | 默认店铺 ID（无店铺映射时使用）                    |
| `SHOP_ID_MAP`            | -    | JSON 店铺映射，如 `{"选项ID":12345}`              |
| `BUYER_NICK`            | ⚠️   | 建单买家账号（shop_buyer_id）                       |
| `FEISHU_APP_ID`         | ✅   | 飞书应用 App ID（`cli_` 开头）                     |
| `FEISHU_APP_SECRET`     | ✅   | 飞书应用 Secret                                    |
| `FEISHU_APP_TOKEN`      | ✅   | 飞书多维表格 App Token（URL 中 `/base/` 后部分） |
| `FEISHU_TABLE_ID`       | ✅   | 飞书多维表格数据表 ID（`tbl` 开头）               |
| `PORT`                  | -    | HTTP 服务端口，默认 `3003`                         |
| `SYNC_INTERVAL_MS`      | -    | 自动同步间隔（毫秒），默认 `60000`                 |
| `BACKFILL_INTERVAL_MS`  | -    | 自动补全间隔（毫秒），默认 `1800000`（30 分钟）   |
| `DEBUG`                 | -    | 打印详细日志（可能包含订单详情），默认 `false`     |

完整配置项见 [.env.example](./.env.example)。

## 部署建议

### 使用 PM2 常驻运行

```bash
# 安装 PM2
npm install -g pm2

# 启动常驻服务模式
SERVICE_MODE=true pm2 start jushuitan-feishu-sync.js --name jushuitan-sync

# 查看日志
pm2 logs jushuitan-sync

# 开机自启
pm2 startup
pm2 save
```

### 配合定时任务（cron）

如果不需要常驻服务，也可以用 cron 定时跑手动同步：

```bash
# 每 5 分钟同步一次
*/5 * * * * cd /path/to/jushuitan-feishu-sync && node jushuitan-feishu-sync.js >> /var/log/jushuitan-sync.log 2>&1
```

## 安全说明

- 本仓库**不含任何真实凭证**，所有密钥通过环境变量 / `.env` 注入
- `.env` 已被 `.gitignore` 忽略，**严禁提交到 Git**
- 飞书应用需配置好权限范围：多维表格读写（`bitable:app`）
- 聚水潭应用需开通：手工建单、订单查询接口权限
- 若曾把含凭证的旧脚本提交到过仓库，请立即：
  1. 删除仓库中的旧版本
  2. 到对应开放平台**重置密钥**（旧密钥一旦泄露必须作废）

## 技术栈

- **Node.js** - 运行环境（仅依赖 `express` 一个第三方包）
- **聚水潭开放平台 API** - 建单 + 订单查询
- **飞书开放平台 API** - 多维表格记录读写
- **Express** - HTTP 服务（可选，仅常驻模式使用）

## License

[MIT](./LICENSE)
