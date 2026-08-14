/**
 * 飞书多维表格订单 → 聚水潭手工建单（一键发货同步）
 *
 * 使用方式：
 *   1. 复制 .env.example 为 .env 并填入真实凭证
 *   2. node jushuitan-feishu-sync.js          # 手动跑一次同步后退出
 *      SERVICE_MODE=true node jushuitan-feishu-sync.js   # 常驻服务 + 定时同步
 *      MODE=backfill node jushuitan-feishu-sync.js        # 补全内部单号/快递单号
 *
 * 触发字段：一键发货（打勾）
 * 回写字段：一键发货（写入结果）
 *
 * 安全说明：本文件不含任何真实凭证，所有密钥一律从环境变量 / .env 读取。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

// ==================== 零依赖 .env 加载器 ====================
// 若同目录存在 .env 文件则自动加载（仅填充未设置的环境变量）
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

// ==================== 聚水潭配置（环境变量） ====================
const JUSHUITAN_APP_KEY = process.env.JUSHUITAN_APP_KEY;
const JUSHUITAN_APP_SECRET = process.env.JUSHUITAN_APP_SECRET;
const JUSHUITAN_ACCESS_TOKEN = process.env.JUSHUITAN_ACCESS_TOKEN;
const JUSHUITAN_API_BASE = process.env.JUSHUITAN_API_BASE || 'https://openapi.jushuitan.com';

// 默认店铺ID（历史逻辑中的默认店铺）
const DEFAULT_SHOP_ID = Number(process.env.JUSHUITAN_SHOP_ID) || 0;

// 店铺ID映射（根据表格"店铺"字段自动匹配），JSON 格式：
//   SHOP_ID_MAP={"店铺选项ID1":12345,"店铺选项ID2":67890}
const SHOP_ID_MAP = (() => {
  try { return JSON.parse(process.env.SHOP_ID_MAP || '{}'); }
  catch { return {}; }
})();

// 固定买家账号
const BUYER_NICK = process.env.BUYER_NICK || '';

// 物流公司映射（快递公司名称 → {lc_id, logistics_company}）
const LOGISTICS_MAP = {
  '顺丰空运': { lc_id: 'SF', logistics_company: 'SF' },
  '顺丰陆运': { lc_id: 'SF.1', logistics_company: 'SF.1' },
  '中通': { lc_id: 'ZTO', logistics_company: '中通' },
};

// ==================== 飞书配置（环境变量） ====================
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_APP_TOKEN = process.env.FEISHU_APP_TOKEN;
const FEISHU_TABLE_ID = process.env.FEISHU_TABLE_ID;
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ==================== 业务字段名 ====================
// 触发和状态字段
const TRIGGER_FIELD = '确认发货';
const STATUS_FIELD = '确认发货';
// 上传状态字段（用于避免重复上传）
const UPLOAD_STATUS_FIELD = '上传状态';

// 是否打印 DEBUG 日志（可能包含订单详情）
const DEBUG = process.env.DEBUG === 'true';

// ==================== 工具函数 ====================
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function httpReq(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : querystring.stringify(body));
    req.end();
  });
}

// 聚水潭签名 v2.0
function sign(params, appSecret) {
  const filtered = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'sign' && v !== null && v !== '' && v !== undefined) filtered[k] = v;
  }
  const keys = Object.keys(filtered).sort();
  let str = appSecret;
  for (const k of keys) str += k + filtered[k];
  return crypto.createHash('md5').update(str).digest('hex');
}

// ==================== 聚水潭 API ====================

/**
 * 查询聚水潭订单详情（用于获取内部订单号和快递单号）
 * 接口：POST /open/orders/single/query
 * @param {Object} params - 查询参数
 * @param {string|number} params.o_id - 聚水潭内部订单号（o_id）
 * @param {number} params.shop_id - 店铺ID
 */
async function queryOrderDetail(params) {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const bizJson = JSON.stringify({
    o_id: String(params.o_id),
    shop_id: Number(params.shop_id),
  });

  const bodyParams = {
    app_key: JUSHUITAN_APP_KEY,
    charset: 'utf-8',
    access_token: JUSHUITAN_ACCESS_TOKEN,
    timestamp,
    biz: bizJson,
    version: '2',
  };
  bodyParams.sign = sign(bodyParams, JUSHUITAN_APP_SECRET);

  const result = await httpReq(
    'POST',
    `${JUSHUITAN_API_BASE}/open/orders/single/query`,
    { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    querystring.stringify(bodyParams)
  );

  if (result.code !== 0) {
    throw new Error(`查询订单详情失败: ${result.msg} (code: ${result.code})`);
  }
  return result.data?.orders?.[0] || null;
}

async function createOrder(params) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const orderData = {
    shop_id: Number(params.shop_id),
    so_id: params.so_id,
    order_date: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-'),
    shop_status: 'WAIT_SELLER_SEND_GOODS',
    shop_buyer_id: params.buyer_nick,
    receiver_name: params.receiver_name,
    receiver_mobile: params.receiver_mobile,
    receiver_address: params.receiver_address,
    pay_amount: params.amount || 0,
    freight: 0,
    items: [{
      sku_id: params.item_code,
      shop_sku_id: params.item_code,
      properties_value: params.sku_code || '',
      i_id: params.item_code,
      amount: params.amount || 0,
      base_price: params.base_price || 0,
      qty: Number(params.qty) || 1,
      name: params.name || '',
      outer_oi_id: params.outer_oi_id || params.so_id,
    }],
  };

  // 如果有物流信息，加上快递公司
  if (params.logistics) {
    orderData.lc_id = params.logistics.lc_id;
    orderData.logistics_company = params.logistics.logistics_company;
  }

  const bizJson = JSON.stringify([orderData]);

  const bodyParams = {
    app_key: JUSHUITAN_APP_KEY,
    charset: 'utf-8',
    access_token: JUSHUITAN_ACCESS_TOKEN,
    timestamp,
    biz: bizJson,
    version: '2',
  };
  bodyParams.sign = sign(bodyParams, JUSHUITAN_APP_SECRET);

  const result = await httpReq(
    'POST',
    `${JUSHUITAN_API_BASE}/open/jushuitan/orders/upload`,
    { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    querystring.stringify(bodyParams)
  );

  if (result.code !== 0) {
    throw new Error(`聚水潭错误: ${result.msg} (code: ${result.code})`);
  }
  return result;
}

// ==================== 飞书 API ====================
let feishuTokenCache = null;

async function getFeishuToken() {
  if (feishuTokenCache && Date.now() < feishuTokenCache.expires_at) {
    return feishuTokenCache.token;
  }
  const result = await httpReq('POST', `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    'Content-Type': 'application/json',
  }, JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }));
  if (result.code !== 0) throw new Error(`飞书Token失败: ${result.msg}`);
  feishuTokenCache = { token: result.tenant_access_token, expires_at: Date.now() + (result.expire - 300) * 1000 };
  return result.tenant_access_token;
}

async function feishuGet(path) {
  const token = await getFeishuToken();
  return httpReq('GET', `${FEISHU_BASE}${path}`, { Authorization: `Bearer ${token}` });
}

async function feishuPut(path, body) {
  const token = await getFeishuToken();
  return httpReq('PUT', `${FEISHU_BASE}${path}`, {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }, JSON.stringify(body));
}

async function getAllRecords() {
  let records = [];
  let pageToken = '';
  do {
    const params = pageToken ? `?page_token=${pageToken}&page_size=500` : '?page_size=500';
    const result = await feishuGet(`/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records${params}`);
    if (result.code !== 0) throw new Error(`获取记录失败: ${result.msg}`);
    records = records.concat(result.data.items);
    pageToken = result.data.has_more ? result.data.page_token : '';
  } while (pageToken);
  return records;
}

async function updateRecordField(recordId, fieldName, value) {
  return feishuPut(
    `/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records/${recordId}`,
    { fields: { [fieldName]: value } }
  );
}

// ==================== 字段解析工具 ====================
// 货号可能是 [{text:"...", type:"text"}] 格式
function parseTextField(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val[0]?.text || '';
  return String(val);
}

function parseSelectField(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    const first = val[0];
    // 如果是字符串（选项ID），直接返回
    if (typeof first === 'string') return first;
    // 如果是对象，取text或name
    return first?.text || first?.name || '';
  }
  return String(val);
}

// ==================== 核心同步逻辑 ====================
async function syncOrders() {
  log('========== 开始同步 ==========');

  const records = await getAllRecords();
  log(`共 ${records.length} 条记录`);

  const toSync = records.filter(rec => {
    const val = rec.fields[TRIGGER_FIELD];
    // 触发条件：一键发货 = true（checkbox打勾）
    const triggerOn = typeof val === 'boolean' && val === true;
    // 防重条件：上传状态为空（未处理过）
    const notYetUploaded = !rec.fields[UPLOAD_STATUS_FIELD];
    return triggerOn && notYetUploaded;
  });

  log(`待同步: ${toSync.length} 条`);

  for (const rec of toSync) {
    const f = rec.fields;

    // 优先使用店铺字段映射，未匹配时回退到默认店铺
    const shopField = parseSelectField(f['店铺']);
    const shopId = SHOP_ID_MAP[shopField] || DEFAULT_SHOP_ID;

    const itemCode = parseTextField(f['商品编码']);
    const name = parseTextField(f['款名']);
    const color = parseSelectField(f['颜色']);
    const size = parseTextField(f['码数']);
    const qty = Number(f['件数']) || 1;
    const receiverName = parseTextField(f['收货人']);
    const phone = parseTextField(f['手机号']);
    const mobile = parseTextField(f['手机号']);
    const address = parseTextField(f['详细地址']);
    const logisticsCompanyRaw = parseSelectField(f['快递公司']);
    const logistics = LOGISTICS_MAP[logisticsCompanyRaw] || null;
    const skuCode = [color, size].filter(Boolean).join(' ');
    const soId = parseTextField(f['线上订单号']);

    // 金额相关（文档要求 amount=成交总额，base_price=原价，至少传 0）
    const amount = 0;
    const basePrice = 0;

    log(`处理: ${itemCode} | ${name} | ${receiverName} | ${phone} | shopId:${shopId}`);

    if (!itemCode || !receiverName || !address || !soId) {
      log(`⚠️ 字段不完整，跳过: ${rec.record_id}`);
      await updateRecordField(rec.record_id, STATUS_FIELD, '⚠️ 字段不完整');
      continue;
    }

    try {
      const result = await createOrder({
        shop_id: shopId,
        buyer_nick: BUYER_NICK,
        receiver_name: receiverName,
        receiver_mobile: mobile,
        receiver_address: address,
        item_code: itemCode,
        sku_code: skuCode,
        name: name,
        qty: qty,
        so_id: soId,
        amount: amount,
        base_price: basePrice,
        logistics,
      });

      const o_id = result.data?.datas?.[0]?.o_id;
      log(`✅ 订单创建成功: o_id=${o_id}`);

      // 用内部单号 o_id 查询完整订单信息（含快递单号）并回写
      if (o_id) {
        try {
          const orderDetail = await queryOrderDetail({ o_id, shop_id: shopId });
          if (DEBUG) log(`DEBUG orderDetail: ${JSON.stringify(orderDetail)}`);
          const expressNo = orderDetail?.express_no || '';
          const lId = orderDetail?.l_id || '';
          const finalExpressNo = expressNo || lId || '';

          await updateRecordField(rec.record_id, '建单内部单号', String(o_id));
          if (finalExpressNo) {
            await updateRecordField(rec.record_id, '快递单号', String(finalExpressNo));
            log(`✅ 回填: 内部单号=${o_id}, 快递单号=${finalExpressNo}`);
          } else {
            log(`✅ 回填: 内部单号=${o_id}（快递单号暂无）`);
          }
        } catch (qErr) {
          log(`⚠️ 查询订单详情失败，退而写内部单号: ${qErr.message}`);
          await updateRecordField(rec.record_id, '建单内部单号', String(o_id));
        }
      } else {
        log(`⚠️ 建单未返回内部单号`);
      }

      // 回写状态 + 标记上传状态（防止重复上传）
      await updateRecordField(rec.record_id, STATUS_FIELD, `✅ 已同步 ${o_id || soId}`);
      await updateRecordField(rec.record_id, UPLOAD_STATUS_FIELD, `同步聚水潭`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`❌ 失败: ${msg}`);
      // 失败也标记上传状态，避免重复触发导致死循环
      await updateRecordField(rec.record_id, STATUS_FIELD, `❌ ${msg}`);
      await updateRecordField(rec.record_id, UPLOAD_STATUS_FIELD, `❌ ${msg}`);
    }
  }

  log('========== 同步完成 ==========');
}

// ==================== Express 服务 ====================
const express = require('express');
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// 触发订单同步
app.post('/sync-orders', async (_req, res) => {
  log('收到同步请求');
  res.json({ code: 0, msg: '开始同步' });
  try {
    await syncOrders();
  } catch (err) {
    log(`同步异常: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3003;

// 自动定时同步间隔（毫秒），默认每 60 秒跑一次
const AUTO_SYNC_INTERVAL = Number(process.env.SYNC_INTERVAL_MS) || 60000;

let syncTimer = null;

async function startAutoSync() {
  // 启动后立即跑一次
  await syncOrders();
  // 然后按间隔定时跑
  syncTimer = setInterval(syncOrders, AUTO_SYNC_INTERVAL);
  log(`自动同步已开启，间隔 ${AUTO_SYNC_INTERVAL / 1000} 秒`);
}

// ==================== 补全缺失的建单内部单号和快递单号 ====================
// 每30分钟跑一次：把所有"上传状态=同步聚水潭"的记录全部查一遍
// 缺内部单号的调用建单接口，缺快递单的反复查聚水潭直到有了为止
async function backfillOrderDetails() {
  log('========== 开始补全 ==========');

  const records = await getAllRecords();
  log(`共 ${records.length} 条记录`);

  // 情况1：缺内部单号（需要调建单接口获取 o_id）
  const toBackfillMissingOId = records.filter(rec => {
    const soId = parseTextField(rec.fields['线上订单号']);
    const internalId = parseTextField(rec.fields['建单内部单号']);
    const uploadStatus = rec.fields[UPLOAD_STATUS_FIELD];
    return soId && !internalId && uploadStatus && uploadStatus.includes('同步聚水潭');
  });

  // 情况2：已有内部单号但缺快递单号
  const toBackfillMissingExpress = records.filter(rec => {
    const soId = parseTextField(rec.fields['线上订单号']);
    const internalId = parseTextField(rec.fields['建单内部单号']);
    const expressNo = rec.fields['快递单号'];
    const uploadStatus = rec.fields[UPLOAD_STATUS_FIELD];
    return soId && internalId && !expressNo && uploadStatus && uploadStatus.includes('同步聚水潭');
  });

  log(`待补全（缺内部单号）: ${toBackfillMissingOId.length} 条`);
  log(`待补全（缺快递单号）: ${toBackfillMissingExpress.length} 条`);

  // 情况1：补内部单号
  for (const rec of toBackfillMissingOId) {
    const f = rec.fields;
    const soId = parseTextField(f['线上订单号']);
    const receiverName = parseTextField(f['收货人']);
    const phone = parseTextField(f['手机号']);
    const address = parseTextField(f['详细地址']);
    const itemCode = parseTextField(f['商品编码']);
    const name = parseTextField(f['款名']);
    const color = parseSelectField(f['颜色']);
    const size = parseTextField(f['码数']);
    const qty = Number(f['件数']) || 1;
    const skuCode = [color, size].filter(Boolean).join(' ');

    log(`补全（缺内部单号）: ${soId} | ${itemCode}`);

    try {
      const result = await createOrder({
        shop_id: DEFAULT_SHOP_ID,
        buyer_nick: BUYER_NICK,
        receiver_name: receiverName,
        receiver_mobile: phone,
        receiver_address: address,
        item_code: itemCode,
        sku_code: skuCode,
        name: name,
        qty: qty,
        so_id: soId,
        amount: 0,
        base_price: 0,
        logistics: null,
      });

      const oId = result.data?.datas?.[0]?.o_id;

      if (oId) {
        try {
          const orderDetail = await queryOrderDetail({ o_id: oId, shop_id: DEFAULT_SHOP_ID });
          const expressNo = orderDetail?.express_no || '';
          const lId = orderDetail?.l_id || '';
          const finalExpressNo = expressNo || lId || '';

          await updateRecordField(rec.record_id, '建单内部单号', String(oId));
          if (finalExpressNo) {
            await updateRecordField(rec.record_id, '快递单号', String(finalExpressNo));
            log(`✅ 补全: 内部单号=${oId}, 快递单号=${finalExpressNo}`);
          } else {
            log(`✅ 补全: 内部单号=${oId}（快递单号暂无）`);
          }
        } catch (qErr) {
          log(`⚠️ 查询详情失败，写内部单号: ${qErr.message}`);
          await updateRecordField(rec.record_id, '建单内部单号', String(oId));
          log(`✅ 补全内部单号: ${oId}`);
        }
      } else {
        log(`⚠️ 未返回内部单号: ${JSON.stringify(result.data?.datas?.[0])}`);
      }
    } catch (err) {
      log(`❌ 补全失败: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // 情况2：补快递单号（直接用已有的内部单号反复查询）
  for (const rec of toBackfillMissingExpress) {
    const f = rec.fields;
    const soId = parseTextField(f['线上订单号']);
    const internalId = parseTextField(f['建单内部单号']);

    log(`补全（缺快递单号）: ${soId} | 内部单号=${internalId}`);

    try {
      const orderDetail = await queryOrderDetail({ o_id: internalId, shop_id: DEFAULT_SHOP_ID });
      const expressNo = orderDetail?.express_no || '';
      const lId = orderDetail?.l_id || '';
      const finalExpressNo = expressNo || lId || '';

      if (finalExpressNo) {
        await updateRecordField(rec.record_id, '快递单号', String(finalExpressNo));
        log(`✅ 补全快递单号: ${finalExpressNo}`);
      } else {
        log(`⏳ 快递单号暂无（status=${orderDetail?.status}），下次仍会重试`);
      }
    } catch (qErr) {
      log(`❌ 查询失败: ${qErr.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  log('========== 补全完成 ==========');
}

// ==================== 启动入口 ====================
if (require.main === module) {
  // 启动前检查必填配置
  const required = [
    ['JUSHUITAN_APP_KEY', JUSHUITAN_APP_KEY],
    ['JUSHUITAN_APP_SECRET', JUSHUITAN_APP_SECRET],
    ['JUSHUITAN_ACCESS_TOKEN', JUSHUITAN_ACCESS_TOKEN],
    ['FEISHU_APP_ID', FEISHU_APP_ID],
    ['FEISHU_APP_SECRET', FEISHU_APP_SECRET],
    ['FEISHU_APP_TOKEN', FEISHU_APP_TOKEN],
    ['FEISHU_TABLE_ID', FEISHU_TABLE_ID],
  ];
  const missing = required.filter(([, v]) => !v);
  if (missing.length) {
    console.error(`❌ 缺少必填配置: ${missing.map(([n]) => n).join(', ')}`);
    console.error('   请复制 .env.example 为 .env 并填入真实凭证后重试');
    process.exit(1);
  }

  const isService = process.env.SERVICE_MODE === 'true';
  const autoSync = process.env.AUTO_SYNC === 'true';
  const mode = process.env.MODE || 'sync';
  // 补全内部单号和快递单号的自动间隔（毫秒），默认每30分钟
  const BACKFILL_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS) || 30 * 60 * 1000;

  if (mode === 'backfill') {
    // 一次性补全后退出（手动触发）
    backfillOrderDetails()
      .then(() => { log('执行完毕'); process.exit(0); })
      .catch(err => { log(`失败: ${err.message}`); process.exit(1); });
    setTimeout(() => { log('超时退出'); process.exit(0); }, 60000);

  } else if (mode === 'autofill') {
    // 自动补全模式：每30分钟跑一次，补全所有缺内部单号/快递单号的记录
    const startAutoFill = () => {
      backfillOrderDetails();
      setInterval(backfillOrderDetails, BACKFILL_INTERVAL_MS);
      log(`自动补全已开启，间隔 ${BACKFILL_INTERVAL_MS / 1000 / 60} 分钟`);
    };

    app.listen(Number(PORT), () => {
      log(`服务已启动: http://localhost:${PORT}`);
      log(`触发同步: POST http://localhost:${PORT}/sync-orders`);
      log(`触发补全: POST http://localhost:${PORT}/backfill`);
      startAutoFill();
    });

    app.post('/backfill', async (_req, res) => {
      log('收到补全请求');
      res.json({ code: 0, msg: '开始补全' });
      try { await backfillOrderDetails(); } catch (err) { log(`补全异常: ${err.message}`); }
    });

  } else if (isService || autoSync) {
    // 方式A/B：启动 HTTP 服务 + 定时自动同步（后台一直跑）
    app.listen(Number(PORT), () => {
      log(`服务已启动: http://localhost:${PORT}`);
      log(`触发同步: POST http://localhost:${PORT}/sync-orders`);
      log(`自动同步间隔: ${AUTO_SYNC_INTERVAL / 1000} 秒`);
      startAutoSync();
    });
  } else {
    // 方式C：手动跑一次同步后退出（不加定时）
    syncOrders()
      .then(() => { log('执行完毕'); process.exit(0); })
      .catch(err => { log(`失败: ${err.message}`); process.exit(1); });
    setTimeout(() => { log('超时退出'); process.exit(0); }, 30000);
  }
}

module.exports = { syncOrders };
