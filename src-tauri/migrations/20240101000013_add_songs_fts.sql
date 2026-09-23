-- 全文搜索索引（SQLite FTS5）
--
-- 背景：search_songs 原先用
--   title LIKE '%x%' OR artist LIKE '%x%' OR album LIKE '%x%'
-- 前导通配符使 idx_songs_title / idx_songs_artist / idx_songs_album 全部失效，
-- 每次搜索都退化为全表扫描 + 全量反序列化。
--
-- 方案：外部内容表（content='songs'）——不复制歌曲数据，只维护倒排索引，
-- songs 始终是唯一数据源，不存在两份数据不一致的问题。
--
-- tokenize='trigram'：按「连续 3 个字符」建索引，使 FTS5 支持子串匹配语义，
-- 与原先 LIKE '%x%' 的行为一致；且按字符（而非按词）切分，中文曲库无需
-- 额外分词器即可检索（默认的 unicode61 不切分中文，会退化成整串匹配）。
--
-- 已知限制：trigram 至少要 3 个字符才能生成 token，1~2 字符的查询无法命中，
-- 由 search_songs 回退到 LIKE 路径处理（见 database.rs）。
CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
    title,
    artist,
    album,
    content='songs',
    tokenize='trigram'
);

-- 回填已有数据：外部内容表刚建好时索引是空的，必须显式 rebuild 才会读取 songs。
INSERT INTO songs_fts(songs_fts) VALUES('rebuild');

-- 同步触发器：保持索引与 songs 一致。
-- 用 UPDATE OF 限定列，避免 play_count（每次播放都写）和 cover 的更新
-- 触发无谓的索引重写。
CREATE TRIGGER IF NOT EXISTS songs_fts_ai AFTER INSERT ON songs BEGIN
    INSERT INTO songs_fts(rowid, title, artist, album)
    VALUES (new.rowid, new.title, new.artist, new.album);
END;

CREATE TRIGGER IF NOT EXISTS songs_fts_ad AFTER DELETE ON songs BEGIN
    INSERT INTO songs_fts(songs_fts, rowid, title, artist, album)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album);
END;

CREATE TRIGGER IF NOT EXISTS songs_fts_au AFTER UPDATE OF title, artist, album ON songs BEGIN
    INSERT INTO songs_fts(songs_fts, rowid, title, artist, album)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album);
    INSERT INTO songs_fts(rowid, title, artist, album)
    VALUES (new.rowid, new.title, new.artist, new.album);
END;
