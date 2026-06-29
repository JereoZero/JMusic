-- 创建设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES ('music_folder', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('volume', '0.8');
INSERT OR IGNORE INTO settings (key, value) VALUES ('play_mode', 'order');
