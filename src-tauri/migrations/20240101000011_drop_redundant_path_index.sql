-- 删除冗余索引：songs.path 是 PRIMARY KEY，SQLite 自动为其创建索引
-- idx_songs_path 重复占用磁盘空间且增加写入开销
DROP INDEX IF EXISTS idx_songs_path;
