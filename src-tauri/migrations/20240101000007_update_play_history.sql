-- 更新播放历史表，添加 duration 和 completed 字段
ALTER TABLE play_history ADD COLUMN duration INTEGER;
ALTER TABLE play_history ADD COLUMN completed INTEGER DEFAULT 0;

-- 创建播放次数统计表
CREATE TABLE IF NOT EXISTS play_counts (
    path TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    last_played TIMESTAMP,
    FOREIGN KEY (path) REFERENCES songs(path) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_play_counts_count ON play_counts(count);
CREATE INDEX IF NOT EXISTS idx_play_counts_last_played ON play_counts(last_played);
