-- 「用户手动取消过隐藏」的路径覆盖表。
--
-- 背景：加密歌曲（ncm/qmc）每次扫描后都会被自动隐藏（hide_songs_batch(paths, true)）。
-- 原实现里用户取消隐藏 = 直接 DELETE hidden_songs 的行，没有任何地方记录
-- 「用户取消过」，因此下次扫描会把同一首歌重新隐藏 —— 用户的操作被静默撤销，
-- 而 is_auto_hidden 列全程无人读取，手动/自动标记形同虚设。
--
-- 语义：hide_songs_batch(_, is_auto = true) 跳过本表中的路径。
-- 用户若重新**手动**隐藏同一首歌，则从本表移除该条目（用户改主意了）。
--
-- 外键 ON DELETE CASCADE：歌曲被移出曲库（删除记录）时自动清理，避免孤儿行累积。
CREATE TABLE IF NOT EXISTS unhidden_overrides (
    path TEXT PRIMARY KEY REFERENCES songs(path) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);