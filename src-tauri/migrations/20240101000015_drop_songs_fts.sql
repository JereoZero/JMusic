-- 移除 songs_fts 全文搜索索引（死基建）。
--
-- 背景：迁移 13 建立的 FTS5 外部内容表 + 3 个同步触发器，原本服务
-- `Database::search_songs`（后端搜索命令）。但前端搜索实际走的是
-- `filterSongs`（内存过滤 + 300ms 防抖），后端命令与 `search_songs`
-- 早已成为零调用的死代码，并在 2026-10-14 的代码整理中被删除。
--
-- 留着它的代价不是「多占一点空间」：songs_fts 的三个触发器挂在
-- songs 表的 INSERT / DELETE / UPDATE OF title,artist,album 上，
-- 每次扫描落库与元数据更新都要额外维护一份没人查询的倒排索引。
--
-- 安全性：FTS5 外部内容表（content='songs'）本身**不存歌曲数据**，
-- 只存索引，songs 才是唯一数据源 —— drop 不会丢失任何用户数据。
DROP TRIGGER IF EXISTS songs_fts_ai;
DROP TRIGGER IF EXISTS songs_fts_ad;
DROP TRIGGER IF EXISTS songs_fts_au;
DROP TABLE IF EXISTS songs_fts;
