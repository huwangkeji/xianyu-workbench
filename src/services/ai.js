'use strict';
// M30 大模型 AI 服务：
// - 供应商配置 CRUD（协议适配：openai_compatible / anthropic / gemini）
//   openai_compatible 覆盖国内外主流厂家：DeepSeek、通义千问(百炼)、Kimi、智谱GLM、豆包(方舟)、MiniMax、OpenAI 等
// - chat()：统一对话入口（默认供应商），供自动回复兜底/每日简报/标题生成/诊断处方/估价点评调用
// - testProvider()：连通性测试（记录最近测试结果）
const { query, queryOne } = require('../db');
const { ApiError, CODE, str, int, enumOf, bool } = require('../http/respond');
const { sysLog } = require('./logs');
const { getSettings, updateSettings } = require('./settings');

const PROVIDER_TYPES = ['openai_compatible', 'anthropic', 'gemini'];

/** 厂家预设：选择后自动填充 base_url 与推荐模型（均可修改）；models 为当前主流模型清单 */
const PRESETS = [
  { key: 'deepseek',  label: 'DeepSeek 深度求索',     provider_type: 'openai_compatible', base_url: 'https://api.deepseek.com',                        models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'qwen',      label: '阿里通义千问（百炼）',   provider_type: 'openai_compatible', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus'] },
  { key: 'moonshot',  label: '月之暗面 Kimi',          provider_type: 'openai_compatible', base_url: 'https://api.moonshot.cn/v1',                      models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'] },
  { key: 'zhipu',     label: '智谱 GLM',               provider_type: 'openai_compatible', base_url: 'https://open.bigmodel.cn/api/paas/v4',            models: ['glm-4.6', 'glm-4.5-air', 'glm-4-flash'] },
  { key: 'doubao',    label: '字节豆包（火山方舟）',   provider_type: 'openai_compatible', base_url: 'https://ark.cn-beijing.volces.com/api/v3',        models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115', 'doubao-pro-32k（或填接入点ID）'] },
  { key: 'minimax',   label: 'MiniMax',                provider_type: 'openai_compatible', base_url: 'https://api.minimax.chat/v1',                     models: ['MiniMax-M2', 'MiniMax-Text-01', 'abab6.5s-chat'] },
  { key: 'openai',    label: 'OpenAI',                 provider_type: 'openai_compatible', base_url: 'https://api.openai.com/v1',                       models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o4-mini'] },
  { key: 'grok',      label: 'xAI Grok',               provider_type: 'openai_compatible', base_url: 'https://api.x.ai/v1',                             models: ['grok-4', 'grok-3', 'grok-3-mini'] },
  { key: 'openrouter', label: 'OpenRouter（聚合）',    provider_type: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1',                    models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'] },
  { key: 'anthropic', label: 'Anthropic Claude',       provider_type: 'anthropic',         base_url: 'https://api.anthropic.com',                       models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'] },
  { key: 'gemini',    label: 'Google Gemini',          provider_type: 'gemini',            base_url: 'https://generativelanguage.googleapis.com',       models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'] },
];

/** 对话测试内置系统提示词预设（前端下拉使用） */
const CHAT_SYSTEM_PRESETS = [
  { name: '通用助手', prompt: '你是一个乐于助人的 AI 助手，回答准确、简洁、条理清晰。' },
  { name: '闲鱼客服', prompt: '你是闲鱼二手店铺的资深客服。语气亲切自然，回复不超过 60 字；不承诺平台外交易，不使用绝对化用语；无法确定的信息引导买家查看商品描述。' },
  { name: '运营顾问', prompt: '你是闲鱼店铺运营专家。基于给出的经营数据输出可执行建议，每条以「动作（预期效果）」格式表述，不超过 5 条。' },
  { name: '商品文案', prompt: '你是电商文案专家，为二手商品撰写标题与描述：突出卖点与成色，避免「最/第一/顶级」等违禁词，风格口语化、真实可信。' },
  { name: '估价师', prompt: '你是二手商品估价师。基于品牌/型号/成色/附件与市场行情，给出估价区间、定价建议与依据，谨慎保守。' },
  { name: '翻译', prompt: '你是专业翻译，中英互译，保留原意与语气，专业术语准确，直接输出译文。' },
];

// ---------------- 供应商 CRUD ----------------

async function listProviders() {
  const rows = await query('SELECT * FROM xy_ai_providers ORDER BY is_default DESC, id ASC');
  return rows.map(maskKey);
}

function maskKey(row) {
  const k = String(row.api_key || '');
  return { ...row, api_key: k ? k.slice(0, 4) + '****' + (k.length > 8 ? k.slice(-4) : '') : '', has_key: k.length > 0 };
}

async function getProvider(id) {
  const row = await queryOne('SELECT * FROM xy_ai_providers WHERE id = ?', [id]);
  if (!row) throw new ApiError(CODE.NOT_FOUND, 'AI 供应商不存在');
  return row;
}

async function createProvider(body) {
  const r = await query(
    'INSERT INTO xy_ai_providers (name, provider_type, base_url, api_key, model, temperature, max_tokens, enabled, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      str(body.name, 'name', { required: true, max: 128 }),
      enumOf(body.provider_type, 'provider_type', PROVIDER_TYPES, { default: 'openai_compatible' }),
      str(body.base_url, 'base_url', { required: true, max: 255 }),
      str(body.api_key, 'api_key', { max: 255 }),
      str(body.model, 'model', { required: true, max: 128 }),
      str(body.temperature || '0.7', 'temperature', { max: 10 }),
      Math.min(8192, Math.max(64, Number(body.max_tokens) || 1024)),
      bool(body.enabled, 'enabled', false) ? 1 : 0,
      bool(body.is_default, 'is_default', false) ? 1 : 0,
    ]
  );
  if (body.is_default) await setDefaultInternal(r.insertId);
  await sysLog('info', 'app', `新增 AI 供应商「${body.name}」`);
  return maskKey(await getProvider(r.insertId));
}

async function updateProvider(id, body) {
  const p = await getProvider(id);
  const next = {
    name: body.name !== undefined ? str(body.name, 'name', { required: true, max: 128 }) : p.name,
    provider_type: body.provider_type !== undefined ? enumOf(body.provider_type, 'provider_type', PROVIDER_TYPES) : p.provider_type,
    base_url: body.base_url !== undefined ? str(body.base_url, 'base_url', { required: true, max: 255 }) : p.base_url,
    api_key: (body.api_key !== undefined && body.api_key !== '') ? str(body.api_key, 'api_key', { max: 255 }) : p.api_key, // 留空=不修改
    model: body.model !== undefined ? str(body.model, 'model', { required: true, max: 128 }) : p.model,
    temperature: body.temperature !== undefined ? str(body.temperature, 'temperature', { max: 10 }) : p.temperature,
    max_tokens: body.max_tokens !== undefined ? Math.min(8192, Math.max(64, Number(body.max_tokens) || 1024)) : p.max_tokens,
    enabled: body.enabled !== undefined ? (bool(body.enabled, 'enabled') ? 1 : 0) : p.enabled,
    is_default: body.is_default !== undefined ? (bool(body.is_default, 'is_default') ? 1 : 0) : p.is_default,
  };
  await query(
    "UPDATE xy_ai_providers SET name=?, provider_type=?, base_url=?, api_key=?, model=?, temperature=?, max_tokens=?, enabled=?, is_default=?, updated_at=datetime('now','localtime') WHERE id=?",
    [next.name, next.provider_type, next.base_url, next.api_key, next.model, next.temperature, next.max_tokens, next.enabled, next.is_default, id]
  );
  if (next.is_default) await setDefaultInternal(id);
  await sysLog('info', 'app', `更新 AI 供应商「${next.name}」`);
  return maskKey(await getProvider(id));
}

async function setDefaultInternal(id) {
  await query('UPDATE xy_ai_providers SET is_default = 0 WHERE id <> ?', [id]);
  await query('UPDATE xy_ai_providers SET is_default = 1, enabled = 1 WHERE id = ?', [id]);
}

async function deleteProvider(id) {
  const p = await getProvider(id);
  if (p.is_default) {
    throw new ApiError(CODE.BIZ_FAIL, '该供应商是当前默认供应商，请先把默认供应商切换到其它已启用的供应商，再删除');
  }
  await query('DELETE FROM xy_ai_providers WHERE id = ?', [id]);
  return { id: Number(id) };
}

async function listPresets() {
  return PRESETS;
}

/** 批量创建供应商：按名称去重，重复的跳过 */
async function createProvidersBatch(body, user) {
  const arr = Array.isArray(body.providers) ? body.providers : null;
  if (!arr) throw new ApiError(CODE.BAD_REQUEST, 'providers 必须是数组');
  const created = [];
  const skipped = [];
  for (const item of arr.slice(0, 30)) {
    try {
      const name = str(item.name, 'name', { required: true, max: 128 });
      const exists = await queryOne('SELECT id FROM xy_ai_providers WHERE name = ?', [name]);
      if (exists) { skipped.push(name); continue; }
      const r = await query(
        'INSERT INTO xy_ai_providers (name, provider_type, base_url, api_key, model, temperature, max_tokens, enabled, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [
          name,
          enumOf(item.provider_type, 'provider_type', PROVIDER_TYPES, { default: 'openai_compatible' }),
          str(item.base_url, 'base_url', { required: true, max: 255 }),
          str(item.api_key, 'api_key', { max: 255 }),
          str(item.model, 'model', { required: true, max: 128 }),
          str(item.temperature || '0.7', 'temperature', { max: 10 }),
          Math.min(8192, Math.max(64, Number(item.max_tokens) || 1024)),
          bool(item.enabled, 'enabled', true) ? 1 : 0,
        ]
      );
      created.push({ id: r.insertId, name });
    } catch (e) {
      skipped.push(`${item.name || '?'}（${e.message}）`);
    }
  }
  await sysLog('info', 'app', `批量添加 AI 供应商：新建 ${created.length}，跳过 ${skipped.length}（操作员 ${user.username}）`);
  return { created_count: created.length, skipped, created };
}

/** 对话测试系统提示词：内置预设 + 自定义（存于系统设置 ai_chat_prompts） */
function parseChatCustom(raw) {
  let arr = [];
  try { arr = JSON.parse(raw || '[]'); } catch (_) { /* ignore */ }
  return Array.isArray(arr)
    ? arr.filter((x) => x && typeof x.name === 'string' && typeof x.prompt === 'string').slice(0, 50)
    : [];
}

async function getChatPresets() {
  const s = await getSettings();
  return { builtin: CHAT_SYSTEM_PRESETS, custom: parseChatCustom(s.ai_chat_prompts) };
}

async function saveChatPrompts(custom, user) {
  const arr = Array.isArray(custom) ? custom : null;
  if (!arr) throw new ApiError(CODE.BAD_REQUEST, 'custom 必须是数组');
  const clean = arr
    .map((x) => ({ name: String(x && x.name || '').trim().slice(0, 40), prompt: String(x && x.prompt || '').trim().slice(0, 2000) }))
    .filter((x) => x.name && x.prompt)
    .slice(0, 50);
  await updateSettings({ ai_chat_prompts: JSON.stringify(clean) });
  await sysLog('info', 'app', `更新 AI 对话系统提示词预设（${clean.length} 条，操作员 ${user.username}）`);
  return clean;
}

// ---------------- 对话调度 ----------------

async function callOpenAICompatible(p, system, userText) {
  const url = p.base_url.replace(/\/+$/, '') + '/chat/completions';
  const resp = await postJson(url, {
    model: p.model,
    messages: system ? [{ role: 'system', content: system }, { role: 'user', content: userText }] : [{ role: 'user', content: userText }],
    temperature: Number(p.temperature) || 0.7,
    max_tokens: Number(p.max_tokens) || 1024,
  }, { Authorization: 'Bearer ' + p.api_key });
  const content = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  if (!content) throw new Error('响应缺少 choices[0].message.content');
  return content;
}

async function callAnthropic(p, system, userText) {
  const url = p.base_url.replace(/\/+$/, '') + '/v1/messages';
  const resp = await postJson(url, {
    model: p.model,
    max_tokens: Number(p.max_tokens) || 1024,
    system: system || undefined,
    messages: [{ role: 'user', content: userText }],
  }, { 'x-api-key': p.api_key, 'anthropic-version': '2023-06-01' });
  const content = resp.content && resp.content[0] && resp.content[0].text;
  if (!content) throw new Error('响应缺少 content[0].text');
  return content;
}

async function callGemini(p, system, userText) {
  const base = p.base_url.replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.api_key)}`;
  const body = { contents: [{ parts: [{ text: userText }] }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const resp = await postJson(url, body, {});
  const cands = resp.candidates && resp.candidates[0];
  const content = cands && cands.content && cands.content.parts && cands.content.parts.map((x) => x.text || '').join('');
  if (!content) throw new Error('响应缺少 candidates[0].content');
  return content;
}

async function postJson(url, body, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '请求超时（30s）' : '网络错误：' + e.message);
  } finally {
    clearTimeout(timer);
  }
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* non-json */ }
  if (!resp.ok) {
    const msg = (data && (data.error && (data.error.message || data.error.msg)) || data && data.message) || text.slice(0, 200);
    throw new Error(`HTTP ${resp.status}: ${msg}`);
  }
  return data;
}

/** 统一对话：使用默认启用供应商 */
async function chat({ system, prompt }) {
  const p = await queryOne('SELECT * FROM xy_ai_providers WHERE is_default = 1 AND enabled = 1');
  if (!p) throw new ApiError(CODE.BIZ_FAIL, '未配置可用的默认 AI 供应商，请到「AI 控制台」配置并启用');
  if (!p.api_key) throw new ApiError(CODE.BIZ_FAIL, `供应商「${p.name}」未填写 API Key`);
  const dispatch = { openai_compatible: callOpenAICompatible, anthropic: callAnthropic, gemini: callGemini };
  const fn = dispatch[p.provider_type];
  if (!fn) throw new ApiError(CODE.BIZ_FAIL, `未知协议类型: ${p.provider_type}`);
  try {
    const content = await fn(p, system || '', String(prompt || ''));
    return { provider: p.name, model: p.model, content };
  } catch (e) {
    throw new ApiError(CODE.INTERNAL, `AI 调用失败（${p.name} / ${p.model}）：${e.message}`);
  }
}

/** 默认供应商是否可用（供 AI 增强功能判断） */
async function hasDefaultProvider() {
  const p = await queryOne("SELECT id, name FROM xy_ai_providers WHERE is_default = 1 AND enabled = 1 AND api_key <> ''");
  return !!p;
}

/** 连通性测试 */
async function testProvider(id) {
  const p = await getProvider(id);
  let ok = 0;
  let message = '';
  const dispatch = { openai_compatible: callOpenAICompatible, anthropic: callAnthropic, gemini: callGemini };
  try {
    if (!p.api_key) throw new Error('未填写 API Key');
    const content = await dispatch[p.provider_type](p, '', '请只回复两个字：正常');
    ok = 1;
    message = '连通成功，模型返回：' + String(content).slice(0, 50);
  } catch (e) {
    ok = 0;
    message = e.message;
  }
  await query("UPDATE xy_ai_providers SET last_test_at = datetime('now','localtime'), last_test_ok = ?, last_test_message = ? WHERE id = ?", [ok, String(message).slice(0, 500), id]);
  await sysLog(ok ? 'info' : 'warn', 'app', `AI 供应商「${p.name}」连通性测试${ok ? '成功' : '失败'}: ${message}`);
  return { ok: !!ok, message, tested_at: new Date().toISOString() };
}

module.exports = {
  PROVIDER_TYPES, PRESETS, CHAT_SYSTEM_PRESETS,
  listProviders, createProvider, createProvidersBatch, updateProvider, deleteProvider, listPresets,
  getChatPresets, saveChatPrompts,
  chat, hasDefaultProvider, testProvider,
};
