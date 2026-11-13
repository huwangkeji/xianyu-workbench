-- =============================================================
-- 闲鱼自动化工作台 - 生产模式种子（最小集，无任何演示数据）
-- 仅当 xy_users 为空时自动执行；内容：管理员账号 + 系统设置 + 定时任务
-- =============================================================

-- M0 工作台用户
INSERT INTO `xy_users` (`id`, `username`, `password_hash`, `display_name`, `role`) VALUES
(1, 'admin', 'scrypt$wb-admin-salt-v1$0edcc7a7d087b2615adecfbc432e383063c1a0200cc23901e67b01eed0de3ac3144d8d1653dd8ac2b627cd94497f4e61f866711e994e32cb2a6f73be1aca35e5', '管理员', 'admin');

-- M11 系统设置
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

-- M8 定时任务
INSERT INTO `xy_tasks` (`id`, `name`, `task_type`, `account_id`, `interval_seconds`, `enabled`, `next_run_at`) VALUES
(1, '商品定时擦亮',      'item_polish',    NULL, 600, 1, datetime('now','localtime','+5 minutes')),
(2, '订单拉取同步',      'order_sync',     NULL, 600, 1, datetime('now','localtime','+2 minutes')),
(3, '未发货订单补发',    'delivery_retry', NULL, 300, 1, datetime('now','localtime','+1 minutes')),
(4, '自动评价',          'auto_rate',      NULL, 900, 1, datetime('now','localtime','+8 minutes')),
(5, 'Cookie 有效性检查', 'cookie_check',   NULL, 1800, 1, datetime('now','localtime','+3 minutes')),
(6, '未成交客户跟进提醒', 'crm_followup',  NULL, 300, 1, datetime('now','localtime','+4 minutes')),
(7, '市场行情扫描',      'market_scan',    NULL, 600, 1, datetime('now','localtime','+6 minutes')),
(8, '每日运营简报',      'daily_brief',    NULL, 86400, 1, datetime('now','localtime','+10 minutes'));
