-- 创建隐藏歌曲表
CREATE TABLE IF NOT EXISTS hidden_songs (
    path TEXT PRIMARY KEY,
    hidden_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_auto_hidden INTEGER DEFAULT 0
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_hidden_songs_hidden_at ON hidden_songs(hidden_at);
