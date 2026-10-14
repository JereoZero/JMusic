-- 清理死表与零使用索引。
--
-- 全部经代码核查确认零调用（2026-10-14 优化专项 O1/O2）：
--
-- 死表：
--   folders / songs.folder_id —— 迁移 9 引入的「主/副文件夹表」方案从未被代码使用，
--   音乐文件夹的唯一真源是 settings 表的 music_folder 键（paths.rs / common.rs）。
--   删除后 songs 表少一列、join 与 upsert 少一列。
--
-- 零使用索引（grep 全后端：无任何 WHERE/ORDER BY 命中）：
--   idx_songs_artist / idx_songs_album —— 歌曲查询不按歌手/专辑过滤
--   idx_songs_play_count —— 没有按播放次数排序的查询
--
-- 冗余索引：
--   idx_songs_path —— songs.path 本身是 UNIQUE，隐式索引已覆盖点查/冲突检测，
--   再建普通索引是同一列的第二份 B-tree（upsert ON CONFLICT(path) 每次写都双维护）
--
-- 保留：idx_songs_title（get_liked_songs ORDER BY title）、idx_songs_created_at
-- （get_songs ORDER BY created_at DESC）、liked/hidden/play_history/play_counts 索引。
--
-- ⚠️ 顺序：必须先 DROP INDEX（idx_songs_folder_id）再 ALTER TABLE DROP COLUMN，
-- 最后 DROP TABLE folders —— 经 sqlite3 实测（PRAGMA foreign_keys=ON）该顺序合法，
-- 且删除后 INSERT / foreign_key_check 均正常。
DROP INDEX IF EXISTS idx_songs_folder_id;
ALTER TABLE songs DROP COLUMN folder_id;

DROP INDEX IF EXISTS idx_songs_artist;
DROP INDEX IF EXISTS idx_songs_album;
DROP INDEX IF EXISTS idx_songs_play_count;
DROP INDEX IF EXISTS idx_songs_path;

DROP INDEX IF EXISTS idx_folders_is_primary;
DROP TABLE IF EXISTS folders;
