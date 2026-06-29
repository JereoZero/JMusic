-- 创建喜欢的歌曲表
CREATE TABLE IF NOT EXISTS liked_songs (
    path TEXT PRIMARY KEY,
    liked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (path) REFERENCES songs(path) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_liked_songs_liked_at ON liked_songs(liked_at);
