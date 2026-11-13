-- =============================================================
-- 闲鱼自动化工作台 - 数据库结构 (SQLite, node:sqlite)
-- 依据 docs/01-功能清单与模块映射.md 的模块划分设计
-- 说明：
--   1. 不使用外键约束，数据关系由服务层维护（与上游项目做法一致，
--      见 docs/01 中 [GH-README] 数据库与初始化说明）。
--   2. 所有时间使用 TEXT 存本地时间 'YYYY-MM-DD HH:MM:SS'，
--      SQL 内统一用 datetime('now','localtime') 写入（与原 MySQL NOW() 语义一致）。
--   3. updated_at 自动更新通过 AFTER UPDATE 触发器实现
--      （等价 MySQL 的 ON UPDATE CURRENT_TIMESTAMP；显式写入 updated_at 时不覆盖）。
--   4. 原 MySQL 的 ENUM 列映射为 TEXT + CHECK 约束。
-- =============================================================

-- -------------------------------------------------------------
-- M0 工作台用户
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_users` (
  `id`            INTEGER PRIMARY KEY AUTOINCREMENT,
  `username`      TEXT NOT NULL,                -- 登录名
  `password_hash` TEXT NOT NULL,                -- scrypt 哈希 scrypt$salt$hash
  `display_name`  TEXT NOT NULL DEFAULT '',     -- 显示名
  `role`          TEXT NOT NULL DEFAULT 'operator' CHECK (`role` IN ('admin','operator')),
  `status`        TEXT NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','disabled')),
  `created_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`username`)
);

-- -------------------------------------------------------------
-- M1 账号与凭证管理
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_accounts` (
  `id`                    INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`            TEXT NOT NULL,        -- 平台账号唯一标识（模拟或扫码 unb）
  `nickname`              TEXT NOT NULL,        -- 账号昵称/店铺名
  `cookie`                TEXT NULL,            -- 登录凭证
  `cookie_expires_at`     TEXT NULL,            -- Cookie 预计过期时间
  `status`                TEXT NOT NULL DEFAULT 'offline' CHECK (`status` IN ('online','offline','error','disabled')),
  `auto_reply_enabled`    INTEGER NOT NULL DEFAULT 1,
  `auto_delivery_enabled` INTEGER NOT NULL DEFAULT 1,  -- 含自动确认发货
  `auto_rate_enabled`     INTEGER NOT NULL DEFAULT 0,
  `reply_delay_min_ms`    INTEGER NOT NULL DEFAULT 0,  -- 0=用全局设置
  `reply_delay_max_ms`    INTEGER NOT NULL DEFAULT 0,
  `last_active_at`        TEXT NULL,
  `remark`                TEXT NOT NULL DEFAULT '',
  `created_at`            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`account_id`)
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON `xy_accounts` (`status`);

-- -------------------------------------------------------------
-- M2 商品管理（含模板与发布日志）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_item_templates` (
  `id`             INTEGER PRIMARY KEY AUTOINCREMENT,
  `name`           TEXT NOT NULL,
  `title_pattern`  TEXT NOT NULL,               -- {n} 为序号占位
  `description`    TEXT NULL,
  `price`          REAL NOT NULL DEFAULT 0,
  `original_price` REAL NOT NULL DEFAULT 0,
  `is_virtual`     INTEGER NOT NULL DEFAULT 0,
  `quantity`       INTEGER NOT NULL DEFAULT 1,
  `address`        TEXT NOT NULL DEFAULT '',
  `created_at`     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS `xy_items` (
  `id`              INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`      INTEGER NOT NULL,           -- 所属账号 xy_accounts.id
  `item_id`         TEXT NOT NULL,              -- 平台商品ID（模拟生成）
  `title`           TEXT NOT NULL,
  `description`     TEXT NULL,
  `price`           REAL NOT NULL DEFAULT 0,
  `original_price`  REAL NOT NULL DEFAULT 0,
  `quantity`        INTEGER NOT NULL DEFAULT 1,
  `main_image`      TEXT NOT NULL DEFAULT '',
  `cost_price`      REAL NOT NULL DEFAULT 0,    -- 采购成本/件（利润分析）
  `shipping_cost`   REAL NOT NULL DEFAULT 0,    -- 运费+包装成本/件
  `goods_condition` TEXT NOT NULL DEFAULT '九成新' CHECK (`goods_condition` IN ('全新','九五新','九成新','八成新','有瑕疵')),
  `defect_note`     TEXT NOT NULL DEFAULT '',
  `is_virtual`      INTEGER NOT NULL DEFAULT 0, -- 是否虚拟商品（参与自动发货）
  `status`          TEXT NOT NULL DEFAULT 'on_sale' CHECK (`status` IN ('on_sale','off_sale')),
  `polish_enabled`  INTEGER NOT NULL DEFAULT 1,
  `last_polish_at`  TEXT NULL,
  `polish_count`    INTEGER NOT NULL DEFAULT 0,
  `template_id`     INTEGER NULL,
  `created_at`      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`item_id`)
);
CREATE INDEX IF NOT EXISTS idx_items_account ON `xy_items` (`account_id`);
CREATE INDEX IF NOT EXISTS idx_items_status ON `xy_items` (`status`);

CREATE TABLE IF NOT EXISTS `xy_publish_logs` (
  `id`          INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`  INTEGER NOT NULL,
  `item_id`     INTEGER NULL,                   -- 发布失败时为空
  `template_id` INTEGER NULL,
  `title`       TEXT NOT NULL,
  `status`      TEXT NOT NULL CHECK (`status` IN ('success','failed')),
  `message`     TEXT NOT NULL DEFAULT '',
  `created_at`  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_publish_logs_account ON `xy_publish_logs` (`account_id`, `created_at`);

-- -------------------------------------------------------------
-- M3 自动回复规则
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_reply_rules` (
  `id`               INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`       INTEGER NULL,              -- NULL=全局规则
  `item_id`          INTEGER NULL,              -- NULL=不限商品；商品专属规则优先
  `name`             TEXT NOT NULL DEFAULT '',
  `rule_type`        TEXT NOT NULL DEFAULT 'text_keyword' CHECK (`rule_type` IN ('text_keyword','image_keyword','default')),
  `match_type`       TEXT NOT NULL DEFAULT 'contains' CHECK (`match_type` IN ('contains','exact','regex')),
  `keywords`         TEXT NOT NULL DEFAULT '',  -- 关键词，逗号分隔；regex 时为正则
  `reply_text`       TEXT NOT NULL,             -- 支持 {买家昵称}/{商品标题}/{商品价格}/{店铺名}
  `reply_image_url`  TEXT NOT NULL DEFAULT '',
  `priority`         INTEGER NOT NULL DEFAULT 100,
  `once_per_session` INTEGER NOT NULL DEFAULT 0,
  `enabled`          INTEGER NOT NULL DEFAULT 1,
  `hit_count`        INTEGER NOT NULL DEFAULT 0,
  `created_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON `xy_reply_rules` (`account_id`, `item_id`, `enabled`, `priority`);

-- -------------------------------------------------------------
-- M4 卡券库存（虚拟商品自动发货）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_card_products` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `item_id`    INTEGER NOT NULL,                -- 关联虚拟商品 xy_items.id
  `name`       TEXT NOT NULL,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_card_products_item ON `xy_card_products` (`item_id`);

CREATE TABLE IF NOT EXISTS `xy_card_codes` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `product_id` INTEGER NOT NULL,                -- xy_card_products.id
  `content`    TEXT NOT NULL,
  `status`     TEXT NOT NULL DEFAULT 'available' CHECK (`status` IN ('available','locked','sold','disabled')),
  `order_no`   TEXT NULL,
  `buyer_nick` TEXT NULL,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `sold_at`    TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_product_status ON `xy_card_codes` (`product_id`, `status`);

-- -------------------------------------------------------------
-- M5 会话与消息
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_conversations` (
  `id`           INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`   INTEGER NOT NULL,
  `buyer_id`     TEXT NOT NULL,
  `buyer_nick`   TEXT NOT NULL,
  `item_id`      INTEGER NULL,
  `session_id`   TEXT NULL,                                 -- 闲鱼会话 ID（WS 推送 "5" 键，真实发送消息用作 cid）
  `last_message` TEXT NOT NULL DEFAULT '',
  `unread_count` INTEGER NOT NULL DEFAULT 0,
  `replied_once` INTEGER NOT NULL DEFAULT 0,    -- 配合 once_per_session
  `status`       TEXT NOT NULL DEFAULT 'open' CHECK (`status` IN ('open','closed')),
  `created_at`   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_conv_account ON `xy_conversations` (`account_id`, `updated_at`);

CREATE TABLE IF NOT EXISTS `xy_messages` (
  `id`              INTEGER PRIMARY KEY AUTOINCREMENT,
  `conversation_id` INTEGER NOT NULL,
  `account_id`      INTEGER NOT NULL,
  `direction`       TEXT NOT NULL CHECK (`direction` IN ('in','out')),  -- in=买家发来 out=发出
  `source`          TEXT NOT NULL DEFAULT 'manual' CHECK (`source` IN ('auto','manual','system')),
  `msg_type`        TEXT NOT NULL DEFAULT 'text' CHECK (`msg_type` IN ('text','image','system')),
  `content`         TEXT NOT NULL,
  `image_url`       TEXT NULL,
  `ext_id`          TEXT NULL,                                 -- 平台消息标识（真实通道去重）
  `item_id`         INTEGER NULL,
  `created_at`      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON `xy_messages` (`conversation_id`, `id`);
CREATE INDEX IF NOT EXISTS idx_msg_account_time ON `xy_messages` (`account_id`, `direction`, `created_at`);

-- -------------------------------------------------------------
-- M6 自动回复处理日志
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_reply_logs` (
  `id`              INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`      INTEGER NOT NULL,
  `conversation_id` INTEGER NULL,
  `item_id`         INTEGER NULL,
  `source_message`  TEXT NOT NULL DEFAULT '',
  `msg_type`        TEXT NOT NULL DEFAULT 'text' CHECK (`msg_type` IN ('text','image','system')),
  `process_status`  TEXT NOT NULL CHECK (`process_status` IN ('success','failed','filtered','skipped')),
  `decision_reason` TEXT NOT NULL DEFAULT '',   -- no_reply/sent/default_sent/filtered/risk_rate_limited/account_offline/rule_disabled
  `reply_strategy`  TEXT NOT NULL DEFAULT '',   -- keyword_item/keyword_account/keyword_global/default/default_item/default_account
  `matched_rule_id` INTEGER NULL,
  `matched_keyword` TEXT NOT NULL DEFAULT '',
  `reply_text`      TEXT NULL,
  `error_message`   TEXT NULL,
  `created_at`      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_reply_logs_time ON `xy_reply_logs` (`account_id`, `created_at`);
CREATE INDEX IF NOT EXISTS idx_reply_logs_status ON `xy_reply_logs` (`process_status`, `created_at`);

-- -------------------------------------------------------------
-- M7 订单与自动发货
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_orders` (
  `id`                  INTEGER PRIMARY KEY AUTOINCREMENT,
  `order_no`            TEXT NOT NULL,
  `account_id`          INTEGER NOT NULL,
  `item_id`             INTEGER NOT NULL,
  `buyer_id`            TEXT NOT NULL DEFAULT '',
  `buyer_nick`          TEXT NOT NULL DEFAULT '',
  `spec_name`           TEXT NOT NULL DEFAULT '',
  `spec_value`          TEXT NOT NULL DEFAULT '',
  `quantity`            INTEGER NOT NULL DEFAULT 1,
  `amount`              REAL NOT NULL DEFAULT 0,
  `status`              TEXT NOT NULL DEFAULT 'pending_paid' CHECK (`status` IN ('pending_paid','paid','delivered','completed','closed','refunding','refunded')),
  `is_virtual`          INTEGER NOT NULL DEFAULT 0,
  `is_bargain`          INTEGER NOT NULL DEFAULT 0,
  `delivery_status`     TEXT NOT NULL DEFAULT 'none' CHECK (`delivery_status` IN ('none','pending','sent','failed')),
  `delivery_content`    TEXT NULL,
  `delivery_fail_reason` TEXT NULL,
  `delivery_attempts`   INTEGER NOT NULL DEFAULT 0,
  `is_rated`            INTEGER NOT NULL DEFAULT 0,
  `rated_at`            TEXT NULL,
  `status_text`         TEXT NULL,              -- 平台侧订单状态原文（同步落库）
  `aftersale_note`      TEXT NOT NULL DEFAULT '',
  `aftersale_closed_at` TEXT NULL,
  `source`              TEXT NOT NULL DEFAULT 'simulated',
  `placed_at`           TEXT NULL,
  `paid_at`             TEXT NULL,
  `delivered_at`        TEXT NULL,
  `created_at`          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`order_no`)
);
CREATE INDEX IF NOT EXISTS idx_orders_account ON `xy_orders` (`account_id`, `created_at`);
CREATE INDEX IF NOT EXISTS idx_orders_delivery ON `xy_orders` (`delivery_status`, `status`);
CREATE INDEX IF NOT EXISTS idx_orders_status ON `xy_orders` (`status`);

CREATE TABLE IF NOT EXISTS `xy_delivery_logs` (
  `id`            INTEGER PRIMARY KEY AUTOINCREMENT,
  `order_no`      TEXT NOT NULL,
  `account_id`    INTEGER NOT NULL,
  `item_id`       INTEGER NOT NULL,
  `card_code_id`  INTEGER NULL,
  `content_sent`  TEXT NULL,
  `status`        TEXT NOT NULL CHECK (`status` IN ('success','failed')),
  `retry_count`   INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `created_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_order ON `xy_delivery_logs` (`order_no`, `created_at`);

-- -------------------------------------------------------------
-- M8 定时任务
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_tasks` (
  `id`               INTEGER PRIMARY KEY AUTOINCREMENT,
  `name`             TEXT NOT NULL,
  `task_type`        TEXT NOT NULL CHECK (`task_type` IN ('item_polish','order_sync','delivery_retry','auto_rate','cookie_check','crm_followup','market_scan','daily_brief')),
  `account_id`       INTEGER NULL,              -- NULL=全部账号
  `interval_seconds` INTEGER NOT NULL DEFAULT 300,
  `enabled`          INTEGER NOT NULL DEFAULT 1,
  `last_run_at`      TEXT NULL,
  `next_run_at`      TEXT NULL,
  `last_status`      TEXT NOT NULL DEFAULT 'never' CHECK (`last_status` IN ('never','running','success','failed')),
  `last_message`     TEXT NOT NULL DEFAULT '',
  `run_count`        INTEGER NOT NULL DEFAULT 0,
  `fail_count`       INTEGER NOT NULL DEFAULT 0,
  `created_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`task_type`, `account_id`)            -- MySQL 多个 NULL 不冲突，SQLite 语义一致
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON `xy_tasks` (`enabled`, `next_run_at`);

CREATE TABLE IF NOT EXISTS `xy_task_runs` (
  `id`          INTEGER PRIMARY KEY AUTOINCREMENT,
  `task_id`     INTEGER NOT NULL,
  `task_type`   TEXT NOT NULL,
  `status`      TEXT NOT NULL DEFAULT 'running' CHECK (`status` IN ('running','success','failed')),
  `message`     TEXT NOT NULL DEFAULT '',
  `affected`    INTEGER NOT NULL DEFAULT 0,
  `started_at`  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `finished_at` TEXT NULL,
  `duration_ms` INTEGER NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON `xy_task_runs` (`task_id`, `started_at`);

-- -------------------------------------------------------------
-- M9 通知中心
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_notify_channels` (
  `id`           INTEGER PRIMARY KEY AUTOINCREMENT,
  `name`         TEXT NOT NULL,
  `channel_type` TEXT NOT NULL DEFAULT 'webhook' CHECK (`channel_type` IN ('wecom','dingtalk','feishu','bark','webhook')),
  `webhook_url`  TEXT NOT NULL DEFAULT '',     -- mock:// 前缀表示仅记录不发送
  `secret`       TEXT NOT NULL DEFAULT '',
  `enabled`      INTEGER NOT NULL DEFAULT 1,
  `created_at`   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS `xy_notify_rules` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `channel_id` INTEGER NOT NULL,
  `event_type` TEXT NOT NULL CHECK (`event_type` IN ('new_order','delivery_failed','risk_intercept','auto_reply','task_failed','followup_due','risk_alert','competitor_alert')),
  `enabled`    INTEGER NOT NULL DEFAULT 1,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notify_rules_event ON `xy_notify_rules` (`event_type`, `enabled`);

CREATE TABLE IF NOT EXISTS `xy_notify_logs` (
  `id`            INTEGER PRIMARY KEY AUTOINCREMENT,
  `channel_id`    INTEGER NULL,
  `channel_name`  TEXT NOT NULL DEFAULT '',
  `event_type`    TEXT NOT NULL,
  `title`         TEXT NOT NULL DEFAULT '',
  `content`       TEXT NULL,
  `status`        TEXT NOT NULL CHECK (`status` IN ('success','failed','mock')),
  `error_message` TEXT NULL,
  `created_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notify_logs_time ON `xy_notify_logs` (`created_at`);

-- -------------------------------------------------------------
-- M10 风控与系统日志
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_risk_logs` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id` INTEGER NULL,
  `event_type` TEXT NOT NULL CHECK (`event_type` IN ('rate_limit','reply_delayed','cookie_expiring','cookie_expired','polish_limited','behavior_simulate')),
  `level`      TEXT NOT NULL DEFAULT 'info' CHECK (`level` IN ('info','warning','danger')),
  `detail`     TEXT NOT NULL DEFAULT '',
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_risk_logs_time ON `xy_risk_logs` (`level`, `created_at`);

CREATE TABLE IF NOT EXISTS `xy_system_logs` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `level`      TEXT NOT NULL DEFAULT 'info' CHECK (`level` IN ('debug','info','warn','error')),
  `module`     TEXT NOT NULL DEFAULT 'app',
  `message`    TEXT NOT NULL,
  `detail`     TEXT NULL,                       -- 原 MySQL JSON 列，字符串化 JSON
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_system_logs_time ON `xy_system_logs` (`level`, `created_at`);
CREATE INDEX IF NOT EXISTS idx_system_logs_module ON `xy_system_logs` (`module`, `created_at`);

-- -------------------------------------------------------------
-- M11 系统设置（键值对）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `xy_settings` (
  `setting_key`   TEXT PRIMARY KEY,
  `setting_value` TEXT NOT NULL DEFAULT '',
  `remark`        TEXT NOT NULL DEFAULT '',
  `updated_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- =============================================================
-- v2 扩展：流量分析 / 市场监控 / 商品优化 / 买家CRM / 利润分析 / 风险中心
-- =============================================================

-- M14 商品流量分析：按天统计商品曝光/浏览/收藏/咨询/成交
CREATE TABLE IF NOT EXISTS `xy_item_stats_daily` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `item_id`    INTEGER NOT NULL,
  `stat_date`  TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  `exposure`   INTEGER NOT NULL DEFAULT 0,
  `views`      INTEGER NOT NULL DEFAULT 0,
  `favorites`  INTEGER NOT NULL DEFAULT 0,
  `inquiries`  INTEGER NOT NULL DEFAULT 0,
  `orders`     INTEGER NOT NULL DEFAULT 0,
  `amount`     REAL NOT NULL DEFAULT 0,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`item_id`, `stat_date`)
);

-- M15 关键词与市场监控
CREATE TABLE IF NOT EXISTS `xy_search_keywords` (
  `id`               INTEGER PRIMARY KEY AUTOINCREMENT,
  `keyword`          TEXT NOT NULL,
  `search_count`     INTEGER NOT NULL DEFAULT 0,
  `buyer_count`      INTEGER NOT NULL DEFAULT 0,
  `avg_price`        REAL NULL,
  `trend`            TEXT NOT NULL DEFAULT 'flat' CHECK (`trend` IN ('up','flat','down')),
  `last_searched_at` TEXT NULL,
  `created_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`keyword`)
);

CREATE TABLE IF NOT EXISTS `xy_market_items` (
  `id`            INTEGER PRIMARY KEY AUTOINCREMENT,
  `kind`          TEXT NOT NULL CHECK (`kind` IN ('hot','competitor','demand')),
  `keyword`       TEXT NOT NULL,
  `title`         TEXT NOT NULL,
  `shop_name`     TEXT NOT NULL DEFAULT '',
  `price`         REAL NOT NULL DEFAULT 0,
  `prev_price`    REAL NULL,
  `monthly_sales` INTEGER NOT NULL DEFAULT 0,
  `status`        TEXT NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','price_up','price_down','gone')),
  `first_seen_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `last_seen_at`  TEXT NULL,
  `created_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_market_keyword ON `xy_market_items` (`keyword`, `kind`);
CREATE INDEX IF NOT EXISTS idx_market_kind ON `xy_market_items` (`kind`, `status`);

-- M16 商品优化素材库
CREATE TABLE IF NOT EXISTS `xy_materials` (
  `id`         INTEGER PRIMARY KEY AUTOINCREMENT,
  `name`       TEXT NOT NULL,
  `category`   TEXT NOT NULL DEFAULT 'title' CHECK (`category` IN ('title','description','image')),
  `content`    TEXT NOT NULL,
  `tags`       TEXT NOT NULL DEFAULT '',
  `use_count`  INTEGER NOT NULL DEFAULT 0,
  `created_at` TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at` TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- M17 买家 CRM
CREATE TABLE IF NOT EXISTS `xy_buyers` (
  `id`                 INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`         INTEGER NOT NULL,
  `buyer_id`           TEXT NOT NULL,
  `buyer_nick`         TEXT NOT NULL,
  `first_contact_at`   TEXT NULL,
  `last_contact_at`    TEXT NULL,
  `message_count_in`   INTEGER NOT NULL DEFAULT 0,
  `message_count_out`  INTEGER NOT NULL DEFAULT 0,
  `intention_score`    INTEGER NOT NULL DEFAULT 0,  -- 0-100
  `intention_level`    TEXT NOT NULL DEFAULT 'unknown' CHECK (`intention_level` IN ('unknown','low','medium','high')),
  `category`           TEXT NOT NULL DEFAULT '',
  `converted`          INTEGER NOT NULL DEFAULT 0,
  `converted_order_no` TEXT NULL,
  `follow_up_at`       TEXT NULL,
  `follow_up_note`     TEXT NOT NULL DEFAULT '',
  `followup_done_at`   TEXT NULL,
  `status`             TEXT NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','closed')),
  `created_at`         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`account_id`, `buyer_id`)
);
CREATE INDEX IF NOT EXISTS idx_buyers_followup ON `xy_buyers` (`converted`, `status`, `follow_up_at`);
CREATE INDEX IF NOT EXISTS idx_buyers_level ON `xy_buyers` (`intention_level`);

-- v3 扩展：大模型 AI 供应商（M30 AI 配置）
CREATE TABLE IF NOT EXISTS `xy_ai_providers` (
  `id`            INTEGER PRIMARY KEY AUTOINCREMENT,
  `name`          TEXT NOT NULL,
  `provider_type` TEXT NOT NULL DEFAULT 'openai_compatible' CHECK (`provider_type` IN ('openai_compatible','anthropic','gemini')),
  `base_url`      TEXT NOT NULL DEFAULT '',
  `api_key`       TEXT NOT NULL DEFAULT '',     -- 本机自托管，注意保密
  `model`         TEXT NOT NULL DEFAULT '',
  `temperature`   TEXT NOT NULL DEFAULT '0.7',
  `max_tokens`    INTEGER NOT NULL DEFAULT 1024,
  `enabled`       INTEGER NOT NULL DEFAULT 0,
  `is_default`    INTEGER NOT NULL DEFAULT 0,
  `last_test_at`  TEXT NULL,
  `last_test_ok`  INTEGER NULL,
  `last_test_message` TEXT NOT NULL DEFAULT '',
  `created_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- =============================================================
-- v4 扩展：闲鱼无忧卖（轻运营销售模式，状态跟踪）
-- 状态对齐官方：待报名/审核中/售卖中/报名失败/已结束/已退出/不支持
-- =============================================================
CREATE TABLE IF NOT EXISTS `xy_worry_free` (
  `id`             INTEGER PRIMARY KEY AUTOINCREMENT,
  `account_id`     INTEGER NOT NULL,
  `item_id`        INTEGER NOT NULL,              -- xy_items.id
  `item_title`     TEXT NOT NULL DEFAULT '',      -- 报名时的商品标题快照
  `status`         TEXT NOT NULL DEFAULT 'pending_signup' CHECK (`status` IN ('pending_signup','reviewing','selling','signup_failed','ended','exited','unsupported')),
  `commission_rate` REAL NULL,                    -- 平台服务费率(%)，可空=用默认
  `remark`         TEXT NOT NULL DEFAULT '',
  `enrolled_at`    TEXT NULL,                     -- 报名时间
  `review_at`      TEXT NULL,                     -- 进入审核时间
  `selling_at`     TEXT NULL,                     -- 开始售卖时间
  `ended_at`       TEXT NULL,                     -- 结束/退出/失败时间
  `created_at`     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  `updated_at`     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (`account_id`, `item_id`)
);
CREATE INDEX IF NOT EXISTS idx_worry_free_status ON `xy_worry_free` (`status`, `account_id`);

CREATE TRIGGER IF NOT EXISTS trg_xy_worry_free_updated AFTER UPDATE ON `xy_worry_free`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_worry_free` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

-- =============================================================
-- updated_at 自动更新触发器（等价 MySQL ON UPDATE CURRENT_TIMESTAMP：
-- UPDATE 未显式写 updated_at 时自动刷新；显式写入时不覆盖）
-- =============================================================
CREATE TRIGGER IF NOT EXISTS trg_xy_users_updated AFTER UPDATE ON `xy_users`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_users` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_accounts_updated AFTER UPDATE ON `xy_accounts`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_accounts` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_item_templates_updated AFTER UPDATE ON `xy_item_templates`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_item_templates` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_items_updated AFTER UPDATE ON `xy_items`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_items` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_reply_rules_updated AFTER UPDATE ON `xy_reply_rules`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_reply_rules` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_card_products_updated AFTER UPDATE ON `xy_card_products`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_card_products` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_conversations_updated AFTER UPDATE ON `xy_conversations`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_conversations` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_orders_updated AFTER UPDATE ON `xy_orders`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_orders` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_tasks_updated AFTER UPDATE ON `xy_tasks`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_tasks` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_notify_channels_updated AFTER UPDATE ON `xy_notify_channels`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_notify_channels` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_settings_updated AFTER UPDATE ON `xy_settings`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_settings` SET updated_at = datetime('now','localtime') WHERE setting_key = NEW.setting_key; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_item_stats_daily_updated AFTER UPDATE ON `xy_item_stats_daily`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_item_stats_daily` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_search_keywords_updated AFTER UPDATE ON `xy_search_keywords`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_search_keywords` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_market_items_updated AFTER UPDATE ON `xy_market_items`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_market_items` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_materials_updated AFTER UPDATE ON `xy_materials`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_materials` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_buyers_updated AFTER UPDATE ON `xy_buyers`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_buyers` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_xy_ai_providers_updated AFTER UPDATE ON `xy_ai_providers`
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE `xy_ai_providers` SET updated_at = datetime('now','localtime') WHERE id = NEW.id; END;
