-- 创建文件夹表，支持主文件夹和副文件夹
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    is_primary BOOLEAN NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 将现有的 music_folder 设置迁移到 folders 表
INSERT OR IGNORE INTO folders (path, is_primary)
SELECT value, 1 FROM settings WHERE key = 'music_folder' AND value != '';

-- 为 songs 表添加 folder_id 字段
ALTER TABLE songs ADD COLUMN folder_id INTEGER REFERENCES folders(id);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_songs_folder_id ON songs(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_is_primary ON folders(is_primary);
