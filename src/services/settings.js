'use strict';
// 系统设置（xy_settings 键值对）
const { query, queryOne } = require('../db');
const { ApiError, CODE, str } = require('../http/respond');
const { sysLog } = require('./logs');

const DEFINITIONS = [
  { key: 'connector_mode', type: 'enum', values: ['simulated', 'live'], default: 'simulated', remark: '连接器模式：simulated=模拟连接器；live=真实对接（预留）' },
  { key: 'reply_delay_min_ms', type: 'int', min: 0, max: 60000, default: 800, remark: '风控：自动回复随机延迟下限(毫秒)' },
  { key: 'reply_delay_max_ms', type: 'int', min: 0, max: 60000, default: 2500, remark: '风控：自动回复随机延迟上限(毫秒)' },
  { key: 'reply_rate_limit_per_min', type: 'int', min: 1, max: 600, default: 20, remark: '风控：单账号每分钟自动回复上限' },
  { key: 'message_filter_words', type: 'string', max: 1000, default: '', remark: '消息过滤词，逗号分隔，命中不自动回复' },
  { key: 'delivery_retry_interval_minutes', type: 'int', min: 1, max: 1440, default: 10, remark: '未发货订单补发最小间隔(分钟)' },
  { key: 'polish_min_interval_minutes', type: 'int', min: 1, max: 1440, default: 30, remark: '擦亮最小间隔(分钟)' },
  { key: 'auto_rate_delay_minutes', type: 'int', min: 0, max: 10080, default: 30, remark: '发货后延迟多少分钟才自动评价' },
  { key: 'session_ttl_hours', type: 'int', min: 1, max: 720, default: 24, remark: '工作台登录会话有效期(小时)' },
  { key: 'platform_fee_rate_pct', type: 'float', min: 0, max: 50, default: 1, remark: '平台服务费率(%)，按订单金额计入利润分析' },
  { key: 'follow_up_hours', type: 'int', min: 1, max: 720, default: 24, remark: '未成交客户跟进提醒间隔(小时)' },
  { key: 'after_sales_timeout_hours', type: 'int', min: 1, max: 720, default: 48, remark: '售后处理超时阈值(小时)' },
  { key: 'violation_words', type: 'string', max: 500, default: '最,第一,顶级,国家级,绝杀,全网最低,秒杀', remark: '违禁/风险词（商品优化与风险中心检查用），逗号分隔' },
  { key: 'ai_auto_reply', type: 'enum', values: ['0', '1'], default: '0', remark: 'AI 兜底回复：无规则命中时由大模型生成回复（需在 AI 控制台配置默认供应商）' },
  { key: 'card_stock_threshold', type: 'int', min: 1, max: 1000, default: 5, remark: '卡密低库存阈值：可用数低于该值的卡券产品进入每日待办预警' },
  { key: 'data_retention_days', type: 'int', min: 7, max: 3650, default: 90, remark: '数据保留天数：回复/系统/风控/通知日志与任务历史超期自动清理（每日日结执行）；文件日志同策略' },
  { key: 'auto_close_conv_days', type: 'int', min: 0, max: 365, default: 0, remark: '会话自动关闭：超过 N 天无互动自动置为已关闭（0=关闭此功能，日结执行）' },
  { key: 'default_account_id', type: 'int', min: 0, max: 999999, default: 0, remark: '工作台默认选中的账号 ID（0=全部账号）' },
  { key: 'quick_phrases', type: 'string', max: 4000, default: '[]', hidden: true, remark: '快捷回复短语（JSON 数组，消息会话页管理）' },
  { key: 'ai_chat_prompts', type: 'string', max: 8000, default: '[]', hidden: true, remark: 'AI 对话测试自定义系统提示词（JSON 数组 [{name,prompt}]）' },
];

const DEF_MAP = new Map(DEFINITIONS.map((d) => [d.key, d]));

async function getSettings() {
  const rows = await query('SELECT setting_key, setting_value FROM xy_settings');
  const map = {};
  for (const d of DEFINITIONS) map[d.key] = d.default;
  for (const r of rows) {
    const d = DEF_MAP.get(r.setting_key);
    if (!d) { map[r.setting_key] = r.setting_value; continue; }
    if (d.type === 'int') {
      const n = parseInt(r.setting_value, 10);
      map[r.setting_key] = Number.isFinite(n) ? n : d.default;
    } else if (d.type === 'float') {
      const n = parseFloat(r.setting_value);
      map[r.setting_key] = Number.isFinite(n) ? n : d.default;
    } else if (d.type === 'enum') {
      map[r.setting_key] = d.values.includes(r.setting_value) ? r.setting_value : d.default;
    } else {
      map[r.setting_key] = r.setting_value;
    }
  }
  return map;
}

async function listSettings() {
  const map = await getSettings();
  return DEFINITIONS.filter((d) => !d.hidden).map((d) => ({
    key: d.key,
    value: map[d.key],
    default: d.default,
    type: d.type,
    values: d.values || undefined,
    remark: d.remark,
  }));
}

async function updateSettings(input) {
  const changes = [];
  for (const [key, rawValue] of Object.entries(input || {})) {
    const d = DEF_MAP.get(key);
    if (!d) throw new ApiError(CODE.BAD_REQUEST, `未知设置项: ${key}`);
    let value;
    if (d.type === 'int') {
      const n = Number(rawValue);
      if (!Number.isFinite(n) || Math.floor(n) !== n) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 必须是整数`);
      if (d.min !== undefined && n < d.min) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 不能小于 ${d.min}`);
      if (d.max !== undefined && n > d.max) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 不能大于 ${d.max}`);
      value = String(n);
    } else if (d.type === 'float') {
      const n = Number(rawValue);
      if (!Number.isFinite(n) || n < 0) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 必须是非负数字`);
      if (d.min !== undefined && n < d.min) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 不能小于 ${d.min}`);
      if (d.max !== undefined && n > d.max) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 不能大于 ${d.max}`);
      value = String(n);
    } else if (d.type === 'enum') {
      if (!d.values.includes(rawValue)) throw new ApiError(CODE.BAD_REQUEST, `设置 ${key} 必须是 ${d.values.join('/')}`);
      value = String(rawValue);
    } else {
      value = str(rawValue, key, { max: d.max });
    }
    await query(
      'INSERT INTO xy_settings (setting_key, setting_value, remark) VALUES (?, ?, ?) '
      + 'ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value',
      [key, value, d.remark]
    );
    changes.push(`${key}=${value}`);
  }
  if (changes.length) await sysLog('info', 'app', `更新系统设置: ${changes.join(', ')}`);
  return getSettings();
}

module.exports = { getSettings, listSettings, updateSettings, DEFINITIONS };
