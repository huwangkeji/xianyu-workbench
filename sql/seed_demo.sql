-- =============================================================
-- 闲鱼自动化工作台 - 演示模式种子（丰富演示数据，仅演示库使用）
-- 覆盖各功能页面：账号/商品/规则/会话消息/订单发货/卡密/任务历史/
-- 通知/风控/流量统计/市场行情/素材/买家CRM/AI 供应商
-- 仅当 xy_users 为空时自动执行；与生产库完全隔离
-- =============================================================

-- M0 工作台用户
INSERT INTO `xy_users` (`id`, `username`, `password_hash`, `display_name`, `role`) VALUES
(1, 'admin', 'scrypt$wb-admin-salt-v1$0edcc7a7d087b2615adecfbc432e383063c1a0200cc23901e67b01eed0de3ac3144d8d1653dd8ac2b627cd94497f4e61f866711e994e32cb2a6f73be1aca35e5', '管理员', 'admin');

-- M11 系统设置（与生产一致的功能开关基线）
INSERT INTO `xy_settings` (`setting_key`, `setting_value`, `remark`) VALUES
('connector_mode', 'simulated', '连接器模式：simulated=模拟闲鱼连接器；live=真实对接（需自行实现，见接口约定）'),
('reply_delay_min_ms', '800', '风控：自动回复随机延迟下限(毫秒)'),
('reply_delay_max_ms', '2500', '风控：自动回复随机延迟上限(毫秒)'),
('reply_rate_limit_per_min', '20', '风控：单账号每分钟自动回复上限，超过则拦截并记录风控日志'),
('message_filter_words', '同行,竞品,广告', '消息过滤词，逗号分隔；命中的买家消息不自动回复'),
('delivery_retry_interval_minutes', '10', '发货重试最小间隔(分钟)'),
('polish_min_interval_minutes', '30', '擦亮最小间隔(分钟)，间隔内重复擦亮会记录风控日志'),
('auto_rate_delay_minutes', '30', '订单签收后延迟多少分钟才允许自动评价'),
('session_ttl_hours', '24', '工作台登录会话有效期(小时)'),
('ai_auto_reply', '0', 'AI 兜底回复：无关键词规则命中且已配置默认 AI 供应商时，由大模型生成回复（0=关闭）'),
('platform_fee_rate_pct', '1', '平台服务费率(%)，按订单金额计入利润分析'),
('follow_up_hours', '24', '未成交客户跟进提醒间隔(小时)'),
('after_sales_timeout_hours', '48', '售后处理超时阈值(小时)'),
('violation_words', '最,第一,顶级,国家级,绝杀,全网最低,秒杀', '违禁/风险词（商品优化与风险中心检查用），逗号分隔'),
('card_stock_threshold', '5', '卡密低库存阈值：可用数低于该值的卡券产品进入每日待办预警'),
('data_retention_days', '90', '数据保留天数：各类日志与任务历史超期自动清理（每日日结执行）');

-- M1 账号（含扫码真实账号的 unb 形态演示：可用性检查会走模拟判定）
INSERT INTO `xy_accounts` (`id`, `account_id`, `nickname`, `cookie`, `cookie_expires_at`, `status`, `auto_reply_enabled`, `auto_delivery_enabled`, `auto_rate_enabled`, `last_active_at`, `remark`) VALUES
(1, 'XY-DEMO-0001', '闲置好物小铺', 'unb=demo_unb_1; _m_h5_tk=demo_tk_1; demo=1', datetime('now','localtime','+7 days'), 'online',  1, 1, 1, datetime('now','localtime'), '演示账号A：虚拟商品+实物，全链路演示'),
(2, 'XY-DEMO-0002', '数码二店',     'unb=demo_unb_2; _m_h5_tk=demo_tk_2; demo=1', datetime('now','localtime','+20 hours'), 'offline', 1, 0, 0, NULL, '演示账号B：Cookie 即将过期（演示 Cookie 检查任务与风控日志）'),
(3, 'XY-DEMO-0003', '家常好物杂货', 'unb=demo_unb_3; _m_h5_tk=demo_tk_3; demo=1', datetime('now','localtime','-2 days'), 'error',   0, 0, 0, NULL, '演示账号C：Cookie 已过期（演示掉线状态与可用性检查结果）');

-- M2 商品模板与商品（覆盖：虚拟/实物/无首图/标题含违禁词/下架 等检测场景）
INSERT INTO `xy_item_templates` (`id`, `name`, `title_pattern`, `description`, `price`, `original_price`, `is_virtual`, `quantity`, `address`) VALUES
(1, '会员月卡模板', '视频会员月卡充值 第{n}件', '自动发货，拍下秒发兑换码', 12.80, 19.90, 1, 99, '浙江杭州');

INSERT INTO `xy_items` (`id`, `account_id`, `item_id`, `title`, `description`, `price`, `original_price`, `quantity`, `main_image`, `cost_price`, `shipping_cost`, `goods_condition`, `defect_note`, `is_virtual`, `status`, `polish_enabled`, `template_id`) VALUES
(1, 1, 'ITEM-DEMO-1001', '视频会员月卡充值 全网通用', '虚拟商品自动发货，拍下秒发兑换码，24小时在线秒发，包邮', 12.80, 19.90, 99, 'https://img.demo/vip-card-main.jpg', 8.00, 0.00, '全新', '', 1, 'on_sale', 1, 1),
(2, 1, 'ITEM-DEMO-1002', '九成新机械键盘 87键青轴', '自用一年，九成新，无拆修，配原装线，包邮', 129.00, 399.00, 1, '', 85.00, 12.00, '九成新', '键帽轻微打油，不影响手感', 0, 'on_sale', 1, NULL),
(3, 2, 'ITEM-DEMO-1003', '二手显卡 RX580 8G', '矿渣慎拍，跑分正常，九成新', 268.00, 899.00, 1, 'https://img.demo/rx580-main.jpg', 180.00, 15.00, '八成新', '风扇噪声偏大，游戏时明显', 0, 'on_sale', 1, NULL),
(4, 1, 'ITEM-DEMO-1004', '全网最低价蓝牙耳机 全新未拆', '全新正品，支持验货', 49.90, 129.00, 5, '', 30.00, 6.00, '全新', '', 0, 'on_sale', 1, NULL),
(5, 2, 'ITEM-DEMO-1005', '九五新Kindle 阅读器', '九五新，屏幕无划痕，原装充电线，仅自提', 199.00, 499.00, 1, 'https://img.demo/kindle-main.jpg', 120.00, 0.00, '九五新', '后盖轻微磨损', 0, 'off_sale', 0, NULL),
(6, 1, 'ITEM-DEMO-1006', '季度会员卡充值 90天', '虚拟商品自动发货，秒发兑换码', 29.90, 45.00, 50, 'https://img.demo/quarter-card.jpg', 18.00, 0.00, '全新', '', 1, 'on_sale', 1, NULL);

-- M4 卡券库存（挂载虚拟商品 1 与 6；0001/0005 已随种子订单售出）
INSERT INTO `xy_card_products` (`id`, `item_id`, `name`) VALUES
(1, 1, '视频会员月卡兑换码'),
(2, 6, '季度会员卡兑换码');

INSERT INTO `xy_card_codes` (`product_id`, `content`, `status`, `order_no`, `buyer_nick`, `sold_at`) VALUES
(1, 'VIP-CARD-SEED-0001', 'sold',      'XYD-SEED-0001', '老张',     datetime('now','localtime','-2 hours')),
(1, 'VIP-CARD-SEED-0002', 'available', NULL, NULL, NULL),
(1, 'VIP-CARD-SEED-0003', 'available', NULL, NULL, NULL),
(1, 'VIP-CARD-SEED-0004', 'sold',      'XYD-SEED-0004', '纠纷买家', datetime('now','localtime','-30 hours')),
(1, 'VIP-CARD-SEED-0005', 'sold',      'XYD-SEED-0003', '售后买家', datetime('now','localtime','-55 hours')),
(2, 'QTR-CARD-SEED-0001', 'available', NULL, NULL, NULL),
(2, 'QTR-CARD-SEED-0002', 'available', NULL, NULL, NULL),
(2, 'QTR-CARD-SEED-0003', 'available', NULL, NULL, NULL);

-- M3 自动回复规则（覆盖：商品专属/全局关键词/图片关键词/默认兜底）
INSERT INTO `xy_reply_rules` (`id`, `account_id`, `item_id`, `name`, `rule_type`, `match_type`, `keywords`, `reply_text`, `reply_image_url`, `priority`, `once_per_session`, `enabled`) VALUES
(1, NULL, 1,    '虚拟商品发货咨询', 'text_keyword', 'contains', '怎么发货,发货吗,卡密,兑换码', '亲，{商品标题}拍下后系统自动发送兑换码，请留意聊天消息哦~', '', 300, 1, 1),
(2, NULL, NULL, '默认回复-全局',   'default',      'contains', '',                            '您好，我是{店铺名}客服，请问有什么可以帮您？', '', 10, 1, 1),
(3, NULL, NULL, '在吗-全局',       'text_keyword', 'contains', '在吗,有人吗',                 '在的亲~ 请讲', '', 200, 0, 1),
(4, 2,    NULL, '议价-数码二店',   'text_keyword', 'contains', '便宜,少点,价格',              '价格已经很不错啦，诚心要可以小刀', '', 200, 0, 1),
(5, 1,    NULL, '实物看图-闲置好物小铺', 'image_keyword', 'contains', '实物图,细节图,实拍',   '实物实拍图已发送，成色如图，放心拍~', 'https://img.demo/real-shot.jpg', 250, 1, 1);

-- M5 演示会话与消息（三个会话：咨询中/已回复/已完结）
INSERT INTO `xy_conversations` (`id`, `account_id`, `buyer_id`, `buyer_nick`, `item_id`, `last_message`, `unread_count`, `replied_once`, `status`) VALUES
(1, 1, 'BUYER-DEMO-001', '小王', 2, '好的，那个键盘还在吗？', 1, 0, 'open'),
(2, 1, 'BUYER-DEMO-002', '发货咨询小李', 1, '已发货，请注意查收兑换码', 0, 1, 'open'),
(3, 2, 'BUYER-DEMO-003', '砍价小刘', 3, '最低多少钱？诚心要', 2, 0, 'open');

INSERT INTO `xy_messages` (`conversation_id`, `account_id`, `direction`, `source`, `msg_type`, `content`, `item_id`, `created_at`) VALUES
(1, 1, 'in',  'manual', 'text', '你好，这个键盘还在吗？', 2, datetime('now','localtime','-30 minutes')),
(1, 1, 'out', 'manual', 'text', '在的，九成新，可以小刀', 2, datetime('now','localtime','-29 minutes')),
(1, 1, 'in',  'manual', 'text', '好的，那个键盘还在吗？', 2, datetime('now','localtime','-5 minutes')),
(2, 1, 'in',  'auto',   'text', '怎么发货？拍下多久发？', 1, datetime('now','localtime','-3 hours')),
(2, 1, 'out', 'auto',   'text', '亲，视频会员月卡充值 全网通用拍下后系统自动发送兑换码，请留意聊天消息哦~', 1, datetime('now','localtime','-3 hours') ),
(2, 1, 'out', 'auto',   'text', '视频会员月卡兑换码：VIP-CARD-SEED-0001', 1, datetime('now','localtime','-3 hours')),
(2, 1, 'in',  'manual', 'text', '收到了，谢谢！', 1, datetime('now','localtime','-2 hours')),
(3, 2, 'in',  'manual', 'text', '显卡最低多少钱？诚心要', 3, datetime('now','localtime','-40 minutes')),
(3, 2, 'in',  'manual', 'text', '能包邮吗？', 3, datetime('now','localtime','-38 minutes'));

-- M7 演示订单（覆盖 delivered/paid/refunding/refunded/completed/pending_paid）
INSERT INTO `xy_orders` (`order_no`, `account_id`, `item_id`, `buyer_id`, `buyer_nick`, `quantity`, `amount`, `status`, `is_virtual`, `delivery_status`, `delivery_content`, `is_rated`, `rated_at`, `placed_at`, `paid_at`, `delivered_at`, `updated_at`, `aftersale_note`, `aftersale_closed_at`) VALUES
('XYD-SEED-0001', 1, 1, 'BUYER-DEMO-010', '老张',     1, 12.80, 'delivered', 1, 'sent', '视频会员月卡兑换码：VIP-CARD-SEED-0001', 1, datetime('now','localtime','-1 hours'), datetime('now','localtime','-3 hours'), datetime('now','localtime','-3 hours'), datetime('now','localtime','-2 hours'), datetime('now','localtime','-2 hours'), '', NULL),
('XYD-SEED-0002', 1, 1, 'BUYER-DEMO-011', '小李',     1, 12.80, 'paid', 1, 'pending', NULL, 0, NULL, datetime('now','localtime','-40 minutes'), datetime('now','localtime','-39 minutes'), NULL, datetime('now','localtime','-39 minutes'), '', NULL),
('XYD-SEED-0003', 1, 1, 'BUYER-DEMO-030', '售后买家', 1, 12.80, 'refunding', 1, 'sent', '视频会员月卡兑换码：VIP-CARD-SEED-0005', 0, NULL, datetime('now','localtime','-56 hours'), datetime('now','localtime','-56 hours'), datetime('now','localtime','-55 hours'), datetime('now','localtime','-50 hours'), '买家称兑换码无效，待核实', NULL),
('XYD-SEED-0004', 1, 1, 'BUYER-DEMO-031', '纠纷买家', 1, 12.80, 'refunded', 1, 'sent', '视频会员月卡兑换码：VIP-CARD-SEED-0004', 0, NULL, datetime('now','localtime','-32 hours'), datetime('now','localtime','-32 hours'), datetime('now','localtime','-31 hours'), datetime('now','localtime','-30 hours'), '核实后确认兑换码被重复使用，已同意退款', datetime('now','localtime','-28 hours')),
('XYD-SEED-0005', 1, 2, 'BUYER-DEMO-032', '键盘买家', 1, 129.00, 'completed', 0, 'none', NULL, 1, datetime('now','localtime','-20 hours'), datetime('now','localtime','-3 days'), datetime('now','localtime','-3 days'), NULL, datetime('now','localtime','-20 hours'), '', NULL),
('XYD-SEED-0006', 2, 3, 'BUYER-DEMO-033', '显卡妹子', 1, 268.00, 'pending_paid', 0, 'none', NULL, 0, NULL, datetime('now','localtime','-15 minutes'), NULL, NULL, datetime('now','localtime','-15 minutes'), '', NULL),
('XYD-SEED-0007', 1, 1, 'BUYER-DEMO-034', '月卡常客', 2, 25.60, 'completed', 1, 'sent', '视频会员月卡兑换码：VIP-CARD-SEED-0002', 1, datetime('now','localtime','-4 days'), datetime('now','localtime','-5 days'), datetime('now','localtime','-5 days'), datetime('now','localtime','-5 days'), datetime('now','localtime','-4 days'), '', NULL);

-- M2 发布日志
INSERT INTO `xy_publish_logs` (`account_id`, `item_id`, `template_id`, `title`, `status`, `message`, `created_at`) VALUES
(1, 6, 1, '季度会员卡充值 90天', 'success', '模拟发布成功', datetime('now','localtime','-2 days')),
(1, 4, NULL, '全网最低价蓝牙耳机 全新未拆', 'success', '模拟发布成功', datetime('now','localtime','-3 days')),
(1, NULL, 1, '季度会员卡充值 90天', 'failed', '模拟发布失败：类目不匹配', datetime('now','localtime','-3 days'));

-- M8 定时任务 + 执行历史
INSERT INTO `xy_tasks` (`id`, `name`, `task_type`, `account_id`, `interval_seconds`, `enabled`, `next_run_at`) VALUES
(1, '商品定时擦亮',      'item_polish',    NULL, 600, 1, datetime('now','localtime','+5 minutes')),
(2, '订单拉取同步',      'order_sync',     NULL, 600, 1, datetime('now','localtime','+2 minutes')),
(3, '未发货订单补发',    'delivery_retry', NULL, 300, 1, datetime('now','localtime','+1 minutes')),
(4, '自动评价',          'auto_rate',      NULL, 900, 1, datetime('now','localtime','+8 minutes')),
(5, 'Cookie 有效性检查', 'cookie_check',   NULL, 1800, 1, datetime('now','localtime','+3 minutes')),
(6, '未成交客户跟进提醒', 'crm_followup',  NULL, 300, 1, datetime('now','localtime','+4 minutes')),
(7, '市场行情扫描',      'market_scan',    NULL, 600, 1, datetime('now','localtime','+6 minutes')),
(8, '每日运营简报',      'daily_brief',    NULL, 86400, 1, datetime('now','localtime','+10 minutes'));

INSERT INTO `xy_task_runs` (`task_id`, `task_type`, `status`, `message`, `affected`, `started_at`, `finished_at`, `duration_ms`) VALUES
(1, 'item_polish',  'success', '擦亮 2 件，跳过(离线) 1 件', 2, datetime('now','localtime','-25 minutes'), datetime('now','localtime','-25 minutes'), 33),
(5, 'cookie_check', 'success', '检查 3 个账号：正常 1，即将过期 1，已过期 1', 2, datetime('now','localtime','-22 minutes'), datetime('now','localtime','-22 minutes'), 8),
(7, 'market_scan',  'success', '扫描 4 个关键词：更新 6，新增 1，价格变动 2', 7, datetime('now','localtime','-18 minutes'), datetime('now','localtime','-18 minutes'), 225),
(2, 'order_sync',   'success', '同步检查完成（1 个在线账号），新增订单 0', 0, datetime('now','localtime','-15 minutes'), datetime('now','localtime','-15 minutes'), 2),
(6, 'crm_followup', 'success', '发现 1 位待跟进客户，已记录提醒', 1, datetime('now','localtime','-10 minutes'), datetime('now','localtime','-10 minutes'), 6);

-- M9 通知渠道/规则/日志
INSERT INTO `xy_notify_channels` (`id`, `name`, `channel_type`, `webhook_url`, `enabled`) VALUES
(1, '演示通知-本地模拟', 'webhook', 'mock://console', 1);

INSERT INTO `xy_notify_rules` (`channel_id`, `event_type`, `enabled`) VALUES
(1, 'new_order', 1),
(1, 'delivery_failed', 1),
(1, 'task_failed', 1),
(1, 'risk_alert', 1),
(1, 'competitor_alert', 1);

INSERT INTO `xy_notify_logs` (`channel_id`, `channel_name`, `event_type`, `title`, `content`, `status`, `created_at`) VALUES
(1, '演示通知-本地模拟', 'new_order', '新订单 XYD-SEED-0002', '视频会员月卡充值 全网通用 x1，金额 ¥12.80，买家 小李', 'mock', datetime('now','localtime','-39 minutes')),
(1, '演示通知-本地模拟', 'competitor_alert', '竞品降价：青轴机械键盘 87键 自用九成新', '关键词「机械键盘」竞品「竞争店铺A」价格 ¥92.00 → ¥88.00', 'mock', datetime('now','localtime','-2 hours')),
(1, '演示通知-本地模拟', 'delivery_failed', '订单 XYD-SEED-0003 自动发货失败', '视频会员月卡充值 全网通用: 卡密库存不足：需要 1，可用 0', 'mock', datetime('now','localtime','-2 days'));

-- M10 风控与系统日志
INSERT INTO `xy_risk_logs` (`account_id`, `event_type`, `level`, `detail`, `created_at`) VALUES
(1, 'cookie_expiring', 'warning', '账号 闲置好物小铺 Cookie 将在 xx 小时后过期，请及时刷新', datetime('now','localtime','-22 minutes')),
(3, 'cookie_expired', 'danger', '账号 家常好物杂货 Cookie 已过期', datetime('now','localtime','-22 minutes')),
(1, 'rate_limit', 'danger', '账号 闲置好物小铺 每分钟自动回复超过上限（20/分钟），已拦截 1 条并记录', datetime('now','localtime','-5 hours')),
(2, 'reply_delayed', 'info', '回复已按随机延迟发出（间隔 1820ms，风控窗口内）', datetime('now','localtime','-3 hours'));

INSERT INTO `xy_system_logs` (`level`, `module`, `message`, `created_at`) VALUES
('info', 'app', '演示模式库已初始化（丰富演示数据）', datetime('now','localtime')),
('info', 'task', '任务「商品定时擦亮」执行成功: 擦亮 2 件，跳过(离线) 1 件', datetime('now','localtime','-25 minutes')),
('info', 'delivery', '订单 XYD-SEED-0001 自动发货成功（卡密 1 张）', datetime('now','localtime','-2 hours')),
('warn', 'connector', '账号 数码二店 Cookie 将在 20 小时后过期，请及时刷新', datetime('now','localtime','-1 hours'));

-- M30 AI 供应商（示例配置，默认停用；接入真实 Key 后在「AI 控制台」启用）
INSERT INTO `xy_ai_providers` (`id`, `name`, `provider_type`, `base_url`, `api_key`, `model`, `enabled`, `is_default`) VALUES
(1, 'DeepSeek（示例）', 'openai_compatible', 'https://api.deepseek.com', '', 'deepseek-chat', 0, 0);

-- =============================================================
-- v2 扩展种子：流量分析 / 市场监控 / 商品优化 / 买家CRM
-- =============================================================

-- M14 商品每日流量（7 天 × 3 商品，覆盖健康/下滑/高浏览低转化三类诊断场景）
INSERT INTO `xy_item_stats_daily` (`item_id`, `stat_date`, `exposure`, `views`, `favorites`, `inquiries`, `orders`, `amount`) VALUES
(1, date('now','localtime','-6 days'), 980,  78, 10, 18, 7,  89.60),
(1, date('now','localtime','-5 days'), 1050, 85, 12, 20, 8,  102.40),
(1, date('now','localtime','-4 days'), 1100, 90, 11, 22, 9,  115.20),
(1, date('now','localtime','-3 days'), 1020, 82, 10, 19, 8,  102.40),
(1, date('now','localtime','-2 days'), 1080, 88, 13, 21, 9,  115.20),
(1, date('now','localtime','-1 days'), 1120, 92, 12, 23, 9,  115.20),
(1, date('now','localtime'),           990,  80, 11, 18, 7,  89.60),
(2, date('now','localtime','-6 days'), 2200, 44, 2, 4, 0, 0.00),
(2, date('now','localtime','-5 days'), 2100, 42, 2, 4, 0, 0.00),
(2, date('now','localtime','-4 days'), 2000, 40, 1, 3, 0, 0.00),
(2, date('now','localtime','-3 days'), 1800, 36, 2, 3, 0, 0.00),
(2, date('now','localtime','-2 days'), 1600, 32, 1, 2, 0, 0.00),
(2, date('now','localtime','-1 days'), 1400, 28, 1, 2, 0, 0.00),
(2, date('now','localtime'),           1200, 24, 1, 2, 0, 0.00),
(3, date('now','localtime','-6 days'), 300, 120, 6, 3, 0, 0.00),
(3, date('now','localtime','-5 days'), 310, 124, 5, 3, 0, 0.00),
(3, date('now','localtime','-4 days'), 290, 116, 6, 3, 0, 0.00),
(3, date('now','localtime','-3 days'), 305, 122, 7, 4, 0, 0.00),
(3, date('now','localtime','-2 days'), 295, 118, 5, 3, 0, 0.00),
(3, date('now','localtime','-1 days'), 300, 120, 6, 3, 0, 0.00),
(3, date('now','localtime'),           310, 124, 6, 3, 0, 0.00),
(4, date('now','localtime','-2 days'), 520, 30, 3, 5, 1, 49.90),
(4, date('now','localtime','-1 days'), 610, 38, 4, 6, 1, 49.90),
(4, date('now','localtime'),           588, 35, 2, 4, 1, 49.90);

-- M15 搜索关键词
INSERT INTO `xy_search_keywords` (`id`, `keyword`, `search_count`, `buyer_count`, `avg_price`, `trend`, `last_searched_at`) VALUES
(1, '会员月卡', 5200, 3100, 10.50,  'up',   datetime('now','localtime','-1 hours')),
(2, '机械键盘', 1900, 1100, 95.00,  'flat', datetime('now','localtime','-2 hours')),
(3, '显卡',     2600, 1600, 320.00, 'flat', datetime('now','localtime','-3 hours')),
(4, '二手相机', 900,  520,  780.00, 'up',   datetime('now','localtime','-5 hours'));

-- M15 市场商品（热门/竞品/新需求）
INSERT INTO `xy_market_items` (`kind`, `keyword`, `title`, `shop_name`, `price`, `monthly_sales`, `status`, `last_seen_at`) VALUES
('hot', '会员月卡', '视频会员月卡 自动发货秒到账', '旗舰店卡券专营', 9.90,  3200, 'active', datetime('now','localtime','-1 hours')),
('hot', '会员月卡', '影视会员折扣充值 月卡',       '充值小站',       11.00, 2100, 'active', datetime('now','localtime','-1 hours')),
('hot', '机械键盘', '87键机械键盘 青轴 全新',      '外设仓库',       92.00, 450,  'active', datetime('now','localtime','-2 hours')),
('hot', '机械键盘', '国产机械键盘 红轴 量产',      '键盘大叔',       105.00, 380, 'active', datetime('now','localtime','-2 hours')),
('competitor', '机械键盘', '青轴机械键盘 87键 自用九成新', '竞争店铺A', 88.00, 120, 'active', datetime('now','localtime','-2 hours')),
('competitor', '机械键盘', '机械键盘 青轴 全新未拆封',     '竞争店铺B', 99.00, 95,  'active', datetime('now','localtime','-2 hours')),
('hot', '显卡', 'RX580 8G 游戏显卡',   '装机猿',   310.00, 260, 'active', datetime('now','localtime','-3 hours')),
('hot', '显卡', 'RX580 2048SP 拆机卡', '矿卡之家', 288.00, 190, 'active', datetime('now','localtime','-3 hours')),
('demand', '二手相机', '求购 二手胶片相机 成色好的私聊', '求购集合', 780.00, 66, 'active', datetime('now','localtime','-5 hours')),
('demand', '二手相机', 'CCD数码相机 回收 高价',          '潮流回收', 650.00, 48, 'active', datetime('now','localtime','-5 hours'));

-- M16 素材库
INSERT INTO `xy_materials` (`id`, `name`, `category`, `content`, `tags`) VALUES
(1, '标题-虚拟商品通用', 'title',       '【自动发货】{商品名} 秒发 兑换码 全天候在线', '虚拟,发货'),
(2, '描述-九成新实物模板', 'description', '自用数月，成色九成新，功能完好无拆修，配件齐全，随缘出可小刀，包裹邮', '实物,模板'),
(3, '首图-实拍规范', 'image',       '首图规范：白底实拍，商品占画面70%以上，无水印无拼接，光线充足', '图片,规范');

-- M17 买家档案
INSERT INTO `xy_buyers` (`id`, `account_id`, `buyer_id`, `buyer_nick`, `first_contact_at`, `last_contact_at`, `message_count_in`, `message_count_out`, `intention_score`, `intention_level`, `category`, `converted`, `converted_order_no`, `follow_up_at`, `follow_up_note`) VALUES
(1, 1, 'BUYER-DEMO-020', '跟进买家A', datetime('now','localtime','-30 hours'), datetime('now','localtime','-26 hours'), 4, 2, 75, 'high',   '议价',     0, NULL, datetime('now','localtime','-2 hours'),  '议价后犹豫，可发限时小赠品促成'),
(2, 1, 'BUYER-DEMO-021', '咨询买家B', datetime('now','localtime','-20 hours'), datetime('now','localtime','-8 hours'),  2, 1, 45, 'medium', '发货咨询', 0, NULL, datetime('now','localtime','+10 hours'), ''),
(3, 1, 'BUYER-DEMO-010', '老张',     datetime('now','localtime','-5 days'),  datetime('now','localtime','-3 hours'),  6, 4, 60, 'medium', '售前咨询', 1, 'XYD-SEED-0001', NULL, ''),
(4, 2, 'BUYER-DEMO-022', '围观买家C', datetime('now','localtime','-3 days'),  datetime('now','localtime','-2 days'),  1, 0, 8,  'low',    '闲聊',     0, NULL, datetime('now','localtime','+30 hours'), ''),
(5, 1, 'BUYER-DEMO-032', '键盘买家', datetime('now','localtime','-3 days'),  datetime('now','localtime','-20 hours'), 3, 2, 70, 'high',   '售前咨询', 1, 'XYD-SEED-0005', NULL, '');

-- M31 无忧卖（轻运营销售模式跟踪，状态对齐官方 7 态）
INSERT INTO `xy_worry_free` (`account_id`, `item_id`, `item_title`, `status`, `enrolled_at`, `review_at`, `selling_at`, `remark`) VALUES
(1, 1, '视频会员月卡充值 全网通用', 'selling',       datetime('now','localtime','-6 days'), datetime('now','localtime','-5 days'), datetime('now','localtime','-4 days'), '平台审核通过，已进入售卖'),
(1, 2, '九成新机械键盘 87键青轴', 'reviewing',      datetime('now','localtime','-1 days'), datetime('now','localtime','-12 hours'), NULL, '质检中，预计明日出结果'),
(2, 3, '二手显卡 RX580 8G', 'pending_signup',      datetime('now','localtime','-3 hours'), NULL, NULL, '矿卡类目需补充成色证明'),
(2, 5, '九五新Kindle 阅读器', 'signup_failed',    datetime('now','localtime','-4 days'), datetime('now','localtime','-3 days'), NULL, '商品描述不完整，报名失败（可完善后重新报名）');
