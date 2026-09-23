use chrono::{DateTime, Utc};
use rayon::prelude::*;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Pool, Sqlite,
};
use std::str::FromStr;
use tauri::AppHandle;
use tracing::{debug, error, info, warn};
use ts_rs::TS;

/// 判断一个「文件不存在」的路径是否可以**确定**为已被删除，从而安全地清理其 DB 记录。
///
/// 仅当文件缺失且其**父目录仍然存在**时才返回 `true`。
///
/// 为什么需要这个判断：外接盘/网络盘未挂载、或二级文件夹的符号链接目标临时
/// 不可达时，该区域下**所有**歌曲的 `Path::exists()` 都会返回 `false`。若据此
/// 清理，会把整盘歌曲连同 `liked_songs` / `play_counts` / `play_history`
/// （经 FK ON DELETE CASCADE）一并永久删除，而源文件其实并未删除——属于不可恢复
/// 的数据丢失。父目录也缺失时说明整片区域不可判定，一律跳过。
fn is_path_confirmably_deleted(path: &str) -> bool {
    match std::path::Path::new(path).parent() {
        // 父目录存在 → 该文件确实从存在的目录中消失了，可安全清理
        Some(parent) => parent.exists(),
        // 无父目录（如路径异常）→ 无法判定，保守跳过
        None => false,
    }
}

/// 在 blocking 线程池中筛出「文件缺失且可确认已删除」的路径。
///
/// 存在性检查是同步 IO，放在 rayon 并行池里执行，避免阻塞 tokio 执行器；
/// 判定规则见 `is_path_confirmably_deleted`。
async fn filter_confirmably_deleted(paths: Vec<String>) -> Result<Vec<String>, DatabaseError> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_par_iter()
            .filter(|path| !std::path::Path::new(path).exists())
            .filter(|path| is_path_confirmably_deleted(path))
            .collect()
    })
    .await
    .map_err(|e| DatabaseError::Io(std::io::Error::other(e.to_string())))
}

/// 歌曲数据结构
#[derive(Debug, Clone, Serialize, sqlx::FromRow, TS)]
#[ts(export)]
pub struct Song {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub path: String,
    pub cover: Option<String>,
    pub play_count: i32,
    pub created_at: DateTime<Utc>,
    #[sqlx(default)]
    pub is_liked: Option<bool>,
    /// 源文件 mtime（UNIX 毫秒），用于增量扫描跳过未变文件。不序列化到前端。
    #[serde(skip)]
    #[sqlx(default)]
    pub file_mtime: Option<i64>,
    /// 源文件大小（字节），与 file_mtime 配合做增量扫描：
    /// mtime 相同但 size 不同也判定为文件已变（覆盖 cp -p / rsync -t / 恢复备份）。
    /// 不序列化到前端。
    #[serde(skip)]
    #[sqlx(default)]
    pub file_size: Option<i64>,
}

/// 数据库错误类型
#[derive(thiserror::Error, Debug)]
pub enum DatabaseError {
    #[error("SQL 错误: {0}")]
    Sql(#[from] sqlx::Error),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("迁移错误: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("歌曲不存在: {0}")]
    SongNotFound(String),
}

/// 数据库管理器
#[derive(Clone)]
pub struct Database {
    pool: Pool<Sqlite>,
}

/// FTS5 trigram 分词器生成 token 所需的最少字符数。
/// 少于 3 个字符的查询无法在 songs_fts 中命中，需回退到 LIKE 路径。
const FTS_MIN_QUERY_CHARS: usize = 3;

/// 把用户输入包装成 FTS5 短语查询。
///
/// MATCH 的操作数是 FTS5 查询语法（`-`、`:`、`*`、`(`、`^` 等均为元字符），
/// 直接拼接用户输入会因语法错误而报错。用双引号包裹成短语后，内部的双引号
/// 按 FTS5 规则转义为两个双引号。
///
/// trigram 索引下，短语查询等价于子串匹配（短语要求各 trigram 位置相邻）。
fn fts_phrase_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

impl Database {
    /// 初始化数据库
    pub async fn init(app_handle: &AppHandle) -> Result<Self, DatabaseError> {
        // 使用应用数据目录
        let db_path = crate::paths::ensure_database_dir_exists(app_handle)
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, e)))?;

        info!("Initializing database at: {:?}", db_path);

        // 创建连接字符串
        let db_url = format!("sqlite:{}?mode=rwc", db_path.to_string_lossy());
        info!("Database URL: {}", db_url);

        // 配置连接选项：启用外键约束（确保 ON DELETE CASCADE 生效）+ WAL 模式
        // busy_timeout: 遇到锁时等待 5s 而非立即报错
        // synchronous=Normal: WAL 模式下推荐配置，性能与安全兼顾
        // cache_size: 负值=KB，-65536=64MB 内存缓存
        let connect_options = SqliteConnectOptions::from_str(&db_url)
            .map_err(DatabaseError::from)?
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5))
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .pragma("cache_size", "-65536")
            .pragma("temp_store", "MEMORY");

        // M1 优化：SQLite 单写入模型，5 连接足够；减少内存占用与锁等待
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .min_connections(1)
            .connect_with(connect_options)
            .await?;

        // 运行迁移
        info!("Running database migrations...");
        sqlx::migrate!("./migrations").run(&pool).await?;

        info!("Database initialized successfully (foreign_keys + WAL enabled)");

        Ok(Self { pool })
    }

    /// 获取所有歌曲（不含封面）
    pub async fn get_songs(&self) -> Result<Vec<Song>, DatabaseError> {
        let songs = sqlx::query_as::<_, Song>(
            r#"
            SELECT 
                s.id,
                s.title,
                s.artist,
                s.album,
                s.duration,
                s.path,
                NULL as cover,
                s.play_count,
                s.created_at,
                CASE WHEN l.path IS NOT NULL THEN 1 ELSE 0 END as is_liked
            FROM songs s
            LEFT JOIN liked_songs l ON s.path = l.path
            ORDER BY s.created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(songs)
    }

    /// 获取歌曲封面
    pub async fn get_song_cover(&self, path: &str) -> Result<Option<String>, DatabaseError> {
        let cover: Option<String> = sqlx::query_scalar("SELECT cover FROM songs WHERE path = ?")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;

        Ok(cover)
    }

    /// 批量获取歌曲封面（单次 IN 查询替代 N 次 get_song_cover）
    /// 返回的 HashMap 包含 paths 中所有路径：DB 有记录则映射到 cover（可能为 None），DB 无记录则不包含该 key
    pub async fn get_song_covers_batch(
        &self,
        paths: &[String],
    ) -> Result<std::collections::HashMap<String, Option<String>>, DatabaseError> {
        if paths.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        // SQLite 默认参数上限 999，MAX_BATCH_SIZE=100 远低于此
        let placeholders = (0..paths.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT path, cover FROM songs WHERE path IN ({})",
            placeholders
        );
        let mut query = sqlx::query_as::<_, (String, Option<String>)>(&sql);
        for path in paths {
            query = query.bind(path);
        }
        let rows = query.fetch_all(&self.pool).await?;
        Ok(rows.into_iter().collect())
    }

    /// 更新歌曲封面
    pub async fn update_song_cover(&self, path: &str, cover: &str) -> Result<(), DatabaseError> {
        sqlx::query("UPDATE songs SET cover = ? WHERE path = ?")
            .bind(cover)
            .bind(path)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    /// 获取喜欢的歌曲路径
    pub async fn get_liked_paths(&self) -> Result<Vec<String>, DatabaseError> {
        let paths = sqlx::query_scalar::<_, String>("SELECT path FROM liked_songs")
            .fetch_all(&self.pool)
            .await?;

        Ok(paths)
    }

    /// 获取喜欢的歌曲（通过 JOIN 查询）
    pub async fn get_liked_songs(&self) -> Result<Vec<Song>, DatabaseError> {
        let songs = sqlx::query_as::<_, Song>(
            r#"
            SELECT
                s.id,
                s.title,
                s.artist,
                s.album,
                s.duration,
                s.path,
                NULL as cover,
                s.play_count,
                s.created_at,
                1 as is_liked
            FROM songs s
            INNER JOIN liked_songs l ON s.path = l.path
            ORDER BY s.title
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(songs)
    }

    /// 切换喜欢状态
    ///
    /// liked_songs.path 有外键指向 songs(path)（ON DELETE CASCADE），
    /// 且连接启用了 `foreign_keys(true)`。直接 INSERT 一个不在 songs 中的路径
    /// 会抛 `FOREIGN KEY constraint failed`。因此用 EXISTS 子查询把「歌曲必须已入库」
    /// 这一条件交给 SQL 原子处理：未入库时插入 0 行（静默忽略）而非报错。
    pub async fn toggle_like(&self, path: &str, liked: bool) -> Result<(), DatabaseError> {
        if liked {
            sqlx::query(
                r#"
                INSERT OR IGNORE INTO liked_songs (path)
                SELECT ? WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?)
                "#,
            )
            .bind(path)
            .bind(path)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query("DELETE FROM liked_songs WHERE path = ?")
                .bind(path)
                .execute(&self.pool)
                .await?;
        }

        Ok(())
    }

    /// 清空所有喜欢
    pub async fn clear_liked_songs(&self) -> Result<usize, DatabaseError> {
        let result = sqlx::query("DELETE FROM liked_songs")
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() as usize)
    }

    /// 插入或更新歌曲 - 返回 (成功数, 失败数)
    /// 使用 QueryBuilder 分批批量插入，避免 N+1 逐条写入
    ///
    /// 按 `&[Song]` 接收而非 `Vec<Song>`：调用方（扫描落库）需要把 `ScanResult`
    /// 原样返回给前端展示「发现/更新 N 首」，若按值接收就必须 `mem::take` 搬空
    /// Vec（前端会看到 0 首）或整体 clone（Song 含 base64 封面，可达 MB 级）。
    pub async fn upsert_songs(&self, songs: &[Song]) -> Result<(usize, usize), DatabaseError> {
        if songs.is_empty() {
            return Ok((0, 0));
        }

        let total = songs.len();
        let mut count = 0usize;
        let mut errors = 0usize;

        // 分批处理：每批 100 首（8 列 × 100 = 800 变量，远低于 SQLite SQLITE_MAX_VARIABLE_NUMBER 限制）
        for chunk in songs.chunks(100) {
            let mut tx = self.pool.begin().await?;

            let mut query_builder = sqlx::QueryBuilder::new(
                "INSERT INTO songs (id, title, artist, album, duration, path, cover, file_mtime, file_size) ",
            );
            query_builder.push_values(chunk, |mut b, song| {
                b.push_bind(&song.id)
                    .push_bind(&song.title)
                    .push_bind(&song.artist)
                    .push_bind(&song.album)
                    .push_bind(song.duration)
                    .push_bind(&song.path)
                    .push_bind(&song.cover)
                    .push_bind(song.file_mtime)
                    .push_bind(song.file_size);
            });
            query_builder.push(
                " ON CONFLICT(path) DO UPDATE SET \
                 title = excluded.title, \
                 artist = excluded.artist, \
                 album = excluded.album, \
                 duration = excluded.duration, \
                 cover = COALESCE(excluded.cover, songs.cover), \
                 file_mtime = COALESCE(excluded.file_mtime, songs.file_mtime), \
                 file_size = COALESCE(excluded.file_size, songs.file_size)",
            );

            match query_builder.build().execute(&mut *tx).await {
                Ok(result) => {
                    count += result.rows_affected() as usize;
                    tx.commit().await?;
                }
                Err(e) => {
                    error!("Batch upsert failed ({} songs): {}", chunk.len(), e);
                    // 回退到逐条插入以保证部分成功
                    if let Err(rb_err) = tx.rollback().await {
                        warn!(
                            "Failed to rollback transaction after batch upsert failure: {}",
                            rb_err
                        );
                    }
                    for song in chunk {
                        match sqlx::query(
                            r#"INSERT INTO songs (id, title, artist, album, duration, path, cover, file_mtime, file_size)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                            ON CONFLICT(path) DO UPDATE SET
                                title = excluded.title,
                                artist = excluded.artist,
                                album = excluded.album,
                                duration = excluded.duration,
                                cover = COALESCE(excluded.cover, songs.cover),
                                file_mtime = COALESCE(excluded.file_mtime, songs.file_mtime),
                                file_size = COALESCE(excluded.file_size, songs.file_size)"#,
                        )
                        .bind(&song.id)
                        .bind(&song.title)
                        .bind(&song.artist)
                        .bind(&song.album)
                        .bind(song.duration)
                        .bind(&song.path)
                        .bind(&song.cover)
                        .bind(song.file_mtime)
                        .bind(song.file_size)
                        .execute(&self.pool)
                        .await
                        {
                            Ok(_) => count += 1,
                            Err(e) => {
                                errors += 1;
                                error!("Failed to insert song {}: {}", song.path, e);
                            }
                        }
                    }
                }
            }
        }

        info!(
            "Inserted/Updated {} songs (total {}), {} errors",
            count, total, errors
        );

        Ok((count, errors))
    }

    /// 获取所有歌曲的 file_mtime 与 file_size，用于增量扫描。
    ///
    /// 返回 `path -> (mtime, size)`；两者都参与「文件是否变更」的判定：
    /// 仅比 mtime 会在 cp -p / rsync -t / 恢复备份等「内容变但 mtime 不变」的场景漏判。
    pub async fn get_all_song_mtimes(
        &self,
    ) -> Result<std::collections::HashMap<String, (i64, Option<i64>)>, DatabaseError> {
        let rows = sqlx::query_as::<_, (String, Option<i64>, Option<i64>)>(
            "SELECT path, file_mtime, file_size FROM songs WHERE file_mtime IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;

        let map = rows
            .into_iter()
            .filter_map(|(path, mtime, size)| mtime.map(|m| (path, (m, size))))
            .collect();
        Ok(map)
    }

    /// 获取库中**全部**歌曲路径。
    ///
    /// 与 [`Self::get_all_song_mtimes`] 的区别：那个带 `WHERE file_mtime IS NOT NULL`
    /// 且返回 mtime/size，供增量扫描比对用；本函数返回无过滤的完整路径集。
    ///
    /// 用途：缩略图回收需要「当前曲库的全部路径」作为有效集。
    /// 复用 mtime 版本会把 `file_mtime IS NULL` 的歌曲（旧版本升级、或 stat 失败的历史
    /// 记录）误判为「不在曲库」，导致其缩略图被当作孤儿删除。
    pub async fn get_all_song_paths(&self) -> Result<Vec<String>, DatabaseError> {
        let paths = sqlx::query_scalar::<_, String>("SELECT path FROM songs")
            .fetch_all(&self.pool)
            .await?;
        Ok(paths)
    }

    /// 增加播放次数
    ///
    /// play_counts.path 有外键指向 songs(path)（ON DELETE CASCADE），
    /// 播放未入库文件时直接 INSERT 会抛 `FOREIGN KEY constraint failed`，
    /// 使整个事务回滚、播放次数静默丢失。用 EXISTS 子查询守卫，
    /// 未入库时跳过 play_counts 写入（songs 的 UPDATE 本身也是 0 行）。
    pub async fn increment_play_count(&self, path: &str) -> Result<(), DatabaseError> {
        let mut tx = self.pool.begin().await?;

        sqlx::query("UPDATE songs SET play_count = play_count + 1 WHERE path = ?")
            .bind(path)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO play_counts (path, count, last_played)
            SELECT ?, 1, CURRENT_TIMESTAMP
            WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?)
            ON CONFLICT(path) DO UPDATE SET 
                count = count + 1,
                last_played = CURRENT_TIMESTAMP
            "#,
        )
        .bind(path)
        .bind(path)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    /// 记录完整的播放历史
    ///
    /// play_history.path 有外键指向 songs(path)（ON DELETE CASCADE），
    /// 播放未入库文件时直接 INSERT 会抛 `FOREIGN KEY constraint failed`。
    /// 用 EXISTS 子查询守卫：未入库时插入 0 行（历史记录本就通过 JOIN songs 展示，
    /// 不存在于 songs 的记录也查不出来）。
    pub async fn add_play_history(
        &self,
        path: &str,
        duration: i64,
        completed: bool,
    ) -> Result<(), DatabaseError> {
        sqlx::query(
            r#"
            INSERT INTO play_history (path, duration, completed)
            SELECT ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?)
            "#,
        )
        .bind(path)
        .bind(duration)
        .bind(if completed { 1 } else { 0 })
        .bind(path)
        .execute(&self.pool)
        .await?;

        debug!(
            "Recorded play history: {} duration={}s completed={}",
            path, duration, completed
        );

        Ok(())
    }

    /// 获取播放次数统计
    pub async fn get_play_counts(&self) -> Result<Vec<(String, i64)>, DatabaseError> {
        let counts = sqlx::query_as::<_, (String, i64)>(
            "SELECT path, count FROM play_counts ORDER BY count DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(counts)
    }

    /// 获取歌曲的播放次数
    pub async fn get_song_play_count(&self, path: &str) -> Result<i64, DatabaseError> {
        let count: Option<i64> = sqlx::query_scalar("SELECT count FROM play_counts WHERE path = ?")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;

        Ok(count.unwrap_or(0))
    }

    /// 获取播放历史
    pub async fn get_play_history(
        &self,
        limit: Option<i64>,
    ) -> Result<Vec<PlayHistory>, DatabaseError> {
        let limit = limit.filter(|&l| l > 0).unwrap_or(100).min(1000);

        let history = sqlx::query_as::<_, PlayHistory>(
            r#"
            SELECT 
                h.*,
                s.title,
                s.artist,
                s.album
            FROM play_history h
            JOIN songs s ON h.path = s.path
            ORDER BY h.played_at DESC
            LIMIT ?
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(history)
    }

    /// 获取最后播放的歌曲（restoreLastSong 后端兜底：前端无 lastSongPath 时使用）
    pub async fn get_last_played_song(&self) -> Result<Option<Song>, DatabaseError> {
        let song = sqlx::query_as::<_, Song>(
            r#"
            SELECT
                s.id,
                s.title,
                s.artist,
                s.album,
                s.duration,
                s.path,
                NULL as cover,
                s.play_count,
                s.created_at,
                CASE WHEN l.path IS NOT NULL THEN 1 ELSE 0 END as is_liked
            FROM play_counts p
            JOIN songs s ON p.path = s.path
            LEFT JOIN liked_songs l ON s.path = l.path
            ORDER BY p.last_played DESC
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(song)
    }

    /// 清空播放历史
    ///
    /// 同时复位两处播放次数（`songs.play_count` 与 `play_counts`）。
    /// 这两列由 [`Self::increment_play_count`] 在同一事务里同步递增，是同一条事实的
    /// 两份存储；若只删 play_history 而不复位，用户点「清空播放历史」后次数仍留着，
    /// 两处口径也可能因后续改动而分叉。
    ///
    /// 注意 `play_counts.last_played` 会被一并清掉，这会影响
    /// [`Self::get_last_played_song`] 的兜底 —— 清空历史后不再有「上次播放」是合理的。
    pub async fn clear_play_history(&self) -> Result<(), DatabaseError> {
        let mut tx = self.pool.begin().await?;

        sqlx::query("DELETE FROM play_history")
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM play_counts")
            .execute(&mut *tx)
            .await?;

        sqlx::query("UPDATE songs SET play_count = 0")
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    /// 清理不存在的歌曲 - 分批处理，只查path避免全量加载
    /// 利用 FK ON DELETE CASCADE：删除 songs 时自动清理 play_counts/play_history/liked_songs；
    /// hidden_songs 无 FK 级联，需显式批量删除。
    ///
    /// ⚠️ 数据安全护栏：仅删除「父目录仍存在」的缺失文件。
    /// 若某缺失路径的父目录也不存在（如外接盘未挂载、二级文件夹符号链接目标
    /// 临时不可达），说明整片区域处于临时不可判定状态，此时 `!exists()` 是因为
    /// 挂载点消失而非文件真正被删除。直接删除会级联清掉整盘歌曲的喜欢/播放历史/
    /// 播放次数，且文件既未真正删、记录不可恢复。故一律跳过，待下次可达时再判定。
    pub async fn cleanup_nonexistent_songs(&self) -> Result<usize, DatabaseError> {
        let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM songs")
            .fetch_all(&self.pool)
            .await?;

        let non_existent = filter_confirmably_deleted(paths).await?;

        for path in &non_existent {
            info!("Found non-existent song: {}", path);
        }

        let removed_count = self.delete_songs_by_paths(&non_existent).await?;

        info!(
            "Cleanup complete: removed {} non-existent songs",
            removed_count
        );
        Ok(removed_count)
    }

    /// 清理指定文件夹下不存在的歌曲（限定范围，避免扫描子文件夹时误删其他文件夹的歌曲）
    pub async fn cleanup_nonexistent_songs_in_folder(
        &self,
        folder_path: &str,
    ) -> Result<usize, DatabaseError> {
        // 空文件夹路径防御：避免 pattern="%" 匹配全表
        if folder_path.trim().is_empty() {
            return Ok(0);
        }

        // 只查询该文件夹下的歌曲路径
        // 规范化：去掉尾部路径分隔符，确保 pattern 以 "/%" 结尾，
        // 避免 "/music/foo%" 误匹配 "/music/foobar" 等兄弟文件夹
        let normalized = folder_path.trim_end_matches('/');
        let escaped = normalized
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("{}/%", escaped);
        let paths: Vec<String> =
            sqlx::query_scalar("SELECT path FROM songs WHERE path LIKE ?1 ESCAPE '\\'")
                .bind(&pattern)
                .fetch_all(&self.pool)
                .await?;

        if paths.is_empty() {
            return Ok(0);
        }

        let non_existent = filter_confirmably_deleted(paths).await?;

        for path in &non_existent {
            info!("Found non-existent song in folder: {}", path);
        }

        let removed_count = self.delete_songs_by_paths(&non_existent).await?;

        info!(
            "Cleanup in folder {} complete: removed {} non-existent songs",
            folder_path, removed_count
        );
        Ok(removed_count)
    }

    /// 删除不在 `folder` 下的歌曲记录，返回删除数。
    ///
    /// # 用途：用户更换音乐文件夹
    ///
    /// 换目录后，旧目录的歌曲记录仍在库里，但路径校验
    /// （[`crate::path_validator::is_path_in_music_folder`]）会因路径不在新目录内
    /// 而全部拒绝 —— 它们在列表里可见，播放 / 收藏 / 取歌词 / 删除却都返回
    /// "Access denied"，且没有自愈路径。这里把它们的记录清掉。
    ///
    /// 与 [`Self::cleanup_nonexistent_songs`] 的区别：那个按「文件是否还在磁盘上」
    /// 判定，这个按「是否还在当前曲库根下」判定 —— 换曲库时旧文件通常**仍在**磁盘上，
    /// 所以前者不会清理它们。
    ///
    /// ⚠️ 会经 FK ON DELETE CASCADE 一并删除这些歌曲的喜欢/播放历史/播放次数，
    /// 因此调用方必须确保这是用户的明确意图（更换音乐文件夹），而非被动状态变化。
    pub async fn cleanup_songs_outside_folder(&self, folder: &str) -> Result<usize, DatabaseError> {
        if folder.trim().is_empty() {
            return Ok(0);
        }

        let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM songs")
            .fetch_all(&self.pool)
            .await?;

        // 用 Path::starts_with 做**组件级**比较，而不是字符串前缀：
        // 后者会把 /Music2/a.mp3 误判为 /Music 的子路径。
        // 二级文件夹的歌曲在 DB 里存的是链接路径（`{music_folder}/link/x.mp3`），
        // 因此仍能通过组件级前缀检查，不会被误删。
        let base = std::path::Path::new(folder);
        let outside: Vec<String> = paths
            .into_iter()
            .filter(|p| !std::path::Path::new(p).starts_with(base))
            .collect();

        if outside.is_empty() {
            return Ok(0);
        }

        info!(
            "Removing {} song(s) outside the current music folder ({})",
            outside.len(),
            folder
        );
        self.delete_songs_by_paths(&outside).await
    }

    /// 按路径批量删除歌曲记录，返回实际删除的 songs 行数。
    ///
    /// 每批 50 条：既避开 SQLite 的变量数上限，也让长事务尽早释放写锁。
    /// 删除 songs 时 FK ON DELETE CASCADE 会自动清理 play_counts /
    /// play_history / liked_songs；hidden_songs 没有外键，需显式删除。
    async fn delete_songs_by_paths(&self, paths: &[String]) -> Result<usize, DatabaseError> {
        let mut removed_count = 0usize;

        for chunk in paths.chunks(50) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let mut tx = self.pool.begin().await?;

            let sql_hidden = format!("DELETE FROM hidden_songs WHERE path IN ({})", placeholders);
            let mut query = sqlx::query(&sql_hidden);
            for path in chunk {
                query = query.bind(path);
            }
            query.execute(&mut *tx).await?;

            let sql_songs = format!("DELETE FROM songs WHERE path IN ({})", placeholders);
            let mut query = sqlx::query(&sql_songs);
            for path in chunk {
                query = query.bind(path);
            }
            let result = query.execute(&mut *tx).await?;
            removed_count += result.rows_affected() as usize;

            tx.commit().await?;
        }

        Ok(removed_count)
    }

    /// 删除歌曲及关联数据
    /// 利用 FK ON DELETE CASCADE 自动清理 play_counts/play_history/liked_songs；
    /// hidden_songs 无 FK 级联，需显式删除。
    pub async fn delete_song(&self, path: &str) -> Result<(), DatabaseError> {
        let mut tx = self.pool.begin().await?;

        // 先删 songs 并判断 rows_affected，再删 hidden_songs
        // 避免孤立 hidden_songs 记录存在但 songs 不存在时返回错误导致 hidden_songs 无法清理
        let result = sqlx::query("DELETE FROM songs WHERE path = ?")
            .bind(path)
            .execute(&mut *tx)
            .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::SongNotFound(path.to_string()));
        }

        sqlx::query("DELETE FROM hidden_songs WHERE path = ?")
            .bind(path)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    /// 搜索歌曲（title / artist / album 子串匹配）
    ///
    /// 走 songs_fts 倒排索引。原先的 `LIKE '%x%'` 因前导通配符无法使用
    /// idx_songs_title / artist / album，每次搜索都是全表扫描。
    ///
    /// trigram 分词器至少要 3 个字符才能生成 token，1~2 字符的查询命中不了索引，
    /// 此时回退到 LIKE 子串匹配（这类短查询的结果集通常极小，代价可接受）。
    pub async fn search_songs(&self, query: &str) -> Result<Vec<Song>, DatabaseError> {
        let trimmed = query.trim();
        // 空查询防御：避免 pattern="%%" 匹配全表
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        if trimmed.chars().count() >= FTS_MIN_QUERY_CHARS {
            let fts_query = fts_phrase_query(trimmed);
            let songs = sqlx::query_as::<_, Song>(
                r#"
                SELECT
                    s.id,
                    s.title,
                    s.artist,
                    s.album,
                    s.duration,
                    s.path,
                    NULL as cover,
                    s.play_count,
                    s.created_at,
                    CASE WHEN l.path IS NOT NULL THEN 1 ELSE 0 END as is_liked
                FROM songs_fts
                JOIN songs s ON s.rowid = songs_fts.rowid
                LEFT JOIN liked_songs l ON s.path = l.path
                WHERE songs_fts MATCH ?1
                ORDER BY s.title
                "#,
            )
            .bind(&fts_query)
            .fetch_all(&self.pool)
            .await?;

            return Ok(songs);
        }

        let escaped = trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);

        let songs = sqlx::query_as::<_, Song>(
            r#"
            SELECT
                s.id,
                s.title,
                s.artist,
                s.album,
                s.duration,
                s.path,
                NULL as cover,
                s.play_count,
                s.created_at,
                CASE WHEN l.path IS NOT NULL THEN 1 ELSE 0 END as is_liked
            FROM songs s
            LEFT JOIN liked_songs l ON s.path = l.path
            WHERE s.title LIKE ?1 ESCAPE '\' OR s.artist LIKE ?1 ESCAPE '\' OR s.album LIKE ?1 ESCAPE '\'
            ORDER BY s.title
            "#,
        )
        .bind(&pattern)
        .fetch_all(&self.pool)
        .await?;

        Ok(songs)
    }

    // ==================== 隐藏歌曲管理 ====================

    /// 隐藏歌曲
    ///
    /// - `is_auto = true`（扫描时自动隐藏加密歌曲）：**跳过**用户手动取消过隐藏的路径
    ///   （见 [`unhidden_overrides`]），且只对已入库歌曲生效
    /// - `is_auto = false`（用户在 UI 主动隐藏）：表达最新意愿，同时清除该路径的
    ///   「取消隐藏」标记，之后扫描不会再自动隐藏它
    pub async fn hide_song(&self, path: &str, is_auto: bool) -> Result<(), DatabaseError> {
        let mut tx = self.pool.begin().await?;

        if is_auto {
            // EXISTS 守卫：hidden_songs 对 songs 没有外键，不守时会把未入库路径写进来，
            // 导致 get_hidden_count 与 get_hidden_songs（INNER JOIN）口径不一致。
            sqlx::query(
                r#"
                INSERT OR IGNORE INTO hidden_songs (path, is_auto_hidden)
                SELECT ?1, 1
                WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?1)
                  AND NOT EXISTS (SELECT 1 FROM unhidden_overrides WHERE path = ?1)
                "#,
            )
            .bind(path)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query("DELETE FROM unhidden_overrides WHERE path = ?")
                .bind(path)
                .execute(&mut *tx)
                .await?;

            // INSERT ... SELECT ... WHERE：同样守卫「歌曲必须已入库」
            sqlx::query(
                r#"
                INSERT OR REPLACE INTO hidden_songs (path, is_auto_hidden)
                SELECT ?1, 0 WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?1)
                "#,
            )
            .bind(path)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        info!("Song hidden: {} (auto: {})", path, is_auto);
        Ok(())
    }

    /// 取消隐藏歌曲
    ///
    /// 除了删除 hidden_songs 的记录，还会写入 [`unhidden_overrides`] ——
    /// 否则下次扫描的自动隐藏会把用户的取消操作静默撤销。
    pub async fn unhide_song(&self, path: &str) -> Result<(), DatabaseError> {
        let mut tx = self.pool.begin().await?;

        sqlx::query("DELETE FROM hidden_songs WHERE path = ?")
            .bind(path)
            .execute(&mut *tx)
            .await?;

        // EXISTS 守卫：unhidden_overrides 有外键指向 songs(path)，未入库路径会触发
        // FOREIGN KEY constraint failed
        sqlx::query(
            "INSERT OR IGNORE INTO unhidden_overrides (path) \
             SELECT ? WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?)",
        )
        .bind(path)
        .bind(path)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        info!("Song unhidden: {}", path);
        Ok(())
    }

    /// 检查歌曲是否被隐藏
    pub async fn is_song_hidden(&self, path: &str) -> Result<bool, DatabaseError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hidden_songs WHERE path = ?")
            .bind(path)
            .fetch_one(&self.pool)
            .await?;

        Ok(count > 0)
    }

    /// 获取所有隐藏的歌曲路径
    ///
    /// 用 EXISTS 过滤未入库路径，与 [`Self::get_hidden_songs`] 的 INNER JOIN 口径一致
    /// （hidden_songs 对 songs 没有外键，历史数据可能含未入库路径，不过滤会出现
    /// 「计数/路径数量」与「列表长度」不一致）。
    pub async fn get_hidden_paths(&self) -> Result<Vec<String>, DatabaseError> {
        let paths = sqlx::query_scalar::<_, String>(
            "SELECT h.path FROM hidden_songs h \
             WHERE EXISTS (SELECT 1 FROM songs WHERE songs.path = h.path) \
             ORDER BY h.hidden_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(paths)
    }

    /// 批量隐藏歌曲
    ///
    /// - `is_auto = true`：跳过 [`unhidden_overrides`] 中的路径，让用户手动取消隐藏的
    ///   意愿不会被下一次扫描静默撤销
    /// - `is_auto = false`：清除这些路径的「取消隐藏」标记（用户改主意了）
    pub async fn hide_songs_batch(
        &self,
        paths: Vec<String>,
        is_auto: bool,
    ) -> Result<usize, DatabaseError> {
        if paths.is_empty() {
            return Ok(0);
        }

        let mut tx = self.pool.begin().await?;

        let paths = if is_auto {
            let overridden: std::collections::HashSet<String> =
                sqlx::query_scalar("SELECT path FROM unhidden_overrides")
                    .fetch_all(&mut *tx)
                    .await?
                    .into_iter()
                    .collect();
            if overridden.is_empty() {
                paths
            } else {
                paths
                    .into_iter()
                    .filter(|p| !overridden.contains(p))
                    .collect()
            }
        } else {
            for chunk in paths.chunks(500) {
                let placeholders = vec!["?"; chunk.len()].join(",");
                let sql = format!(
                    "DELETE FROM unhidden_overrides WHERE path IN ({})",
                    placeholders
                );
                let mut query = sqlx::query(&sql);
                for path in chunk {
                    query = query.bind(path);
                }
                query.execute(&mut *tx).await?;
            }
            paths
        };

        let is_auto_val: i64 = if is_auto { 1 } else { 0 };
        let mut count = 0usize;

        // 每行 2 个绑定变量（path, is_auto），SQLite 单语句变量上限 999，
        // 400×2=800 留有余量，避免触发 SQLITE_MAX_VARIABLE_NUMBER
        // 使用 INSERT OR IGNORE：已存在的记录（含用户手动隐藏 is_auto_hidden=0）不会被覆盖，
        // 保留用户的手动隐藏标记。
        for chunk in paths.chunks(400) {
            let placeholders = (0..chunk.len())
                .map(|_| "(?, ?)")
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "INSERT OR IGNORE INTO hidden_songs (path, is_auto_hidden) VALUES {}",
                placeholders
            );
            let mut query = sqlx::query(&sql);
            for path in chunk {
                query = query.bind(path).bind(is_auto_val);
            }
            let result = query.execute(&mut *tx).await?;
            count += result.rows_affected() as usize;
        }

        tx.commit().await?;
        info!("Batch hidden {} songs", count);
        Ok(count)
    }

    /// 批量取消隐藏
    pub async fn unhide_songs_batch(&self, paths: Vec<String>) -> Result<usize, DatabaseError> {
        if paths.is_empty() {
            return Ok(0);
        }

        let mut tx = self.pool.begin().await?;
        let mut count = 0usize;

        for chunk in paths.chunks(400) {
            let placeholders = vec!["?"; chunk.len()].join(",");

            // 记录「用户取消过隐藏」，否则下次扫描的自动隐藏会把这次操作静默撤销。
            // 一条 SQL 处理整批：`SELECT ... WHERE path IN (...)` 从 songs 取交集，
            // 未入库路径天然被排除，从而满足外键约束（unhidden_overrides.path → songs.path）。
            // （逐个路径单独 INSERT 会产生 N 次数据库往返，没有必要。）
            let sql_override = format!(
                "INSERT OR IGNORE INTO unhidden_overrides (path) \
                 SELECT path FROM songs WHERE path IN ({})",
                placeholders
            );
            let mut query = sqlx::query(&sql_override);
            for path in chunk {
                query = query.bind(path);
            }
            query.execute(&mut *tx).await?;

            let sql = format!("DELETE FROM hidden_songs WHERE path IN ({})", placeholders);
            let mut query = sqlx::query(&sql);
            for path in chunk {
                query = query.bind(path);
            }
            let result = query.execute(&mut *tx).await?;
            count += result.rows_affected() as usize;
        }

        tx.commit().await?;
        info!("Batch unhidden {} songs", count);
        Ok(count)
    }

    /// 清空隐藏列表
    ///
    /// 同时清空「取消隐藏」标记：用户点的是「清空隐藏列表」，期望回到初始状态，
    /// 而不是让之前的取消隐藏意愿继续阻止后续扫描自动隐藏加密歌曲。
    pub async fn clear_hidden_songs(&self) -> Result<usize, DatabaseError> {
        let mut tx = self.pool.begin().await?;

        let result = sqlx::query("DELETE FROM hidden_songs")
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM unhidden_overrides")
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        let count = result.rows_affected() as usize;
        info!("Cleared {} hidden songs", count);
        Ok(count)
    }

    /// 获取隐藏歌曲数量
    ///
    /// 用 EXISTS 过滤未入库路径，与 [`Self::get_hidden_songs`] 的 INNER JOIN 口径一致
    /// —— 否则界面上的「隐藏 N 首」会比列表里实际显示的多。
    pub async fn get_hidden_count(&self) -> Result<i64, DatabaseError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM hidden_songs h \
             WHERE EXISTS (SELECT 1 FROM songs WHERE songs.path = h.path)",
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(count)
    }

    // ==================== 设置管理 ====================

    /// 获取设置
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>, DatabaseError> {
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;

        Ok(value)
    }

    /// 保存设置
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), DatabaseError> {
        sqlx::query(
            r#"
            INSERT INTO settings (key, value) 
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET 
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// 获取所有设置
    pub async fn get_all_settings(&self) -> Result<Vec<(String, String)>, DatabaseError> {
        let settings = sqlx::query_as::<_, (String, String)>("SELECT key, value FROM settings")
            .fetch_all(&self.pool)
            .await?;

        Ok(settings)
    }

    // ==================== 喜欢歌曲管理 ====================

    /// 检查歌曲是否已喜欢
    pub async fn is_song_liked(&self, path: &str) -> Result<bool, DatabaseError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM liked_songs WHERE path = ?")
            .bind(path)
            .fetch_one(&self.pool)
            .await?;

        Ok(count > 0)
    }

    /// 获取隐藏的完整歌曲信息
    pub async fn get_hidden_songs(&self) -> Result<Vec<Song>, DatabaseError> {
        let songs = sqlx::query_as::<_, Song>(
            r#"
            SELECT
                s.id,
                s.title,
                s.artist,
                s.album,
                s.duration,
                s.path,
                NULL as cover,
                s.play_count,
                s.created_at,
                CASE WHEN l.path IS NOT NULL THEN 1 ELSE 0 END as is_liked
            FROM songs s
            INNER JOIN hidden_songs h ON s.path = h.path
            LEFT JOIN liked_songs l ON s.path = l.path
            ORDER BY h.hidden_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(songs)
    }

    // ==================== 日志管理 ====================

    /// 添加日志
    pub async fn add_log(
        &self,
        level: &str,
        message: &str,
        target: Option<&str>,
    ) -> Result<(), DatabaseError> {
        sqlx::query("INSERT INTO app_logs (level, message, target) VALUES (?1, ?2, ?3)")
            .bind(level)
            .bind(message)
            .bind(target)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    /// 获取日志
    pub async fn get_logs(
        &self,
        level: Option<&str>,
        limit: Option<i64>,
    ) -> Result<Vec<AppLog>, DatabaseError> {
        let limit = limit.filter(|&l| l > 0).unwrap_or(100).min(1000);

        let logs = if let Some(level) = level {
            sqlx::query_as::<_, AppLog>(
                "SELECT * FROM app_logs WHERE level = ?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .bind(level)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query_as::<_, AppLog>("SELECT * FROM app_logs ORDER BY created_at DESC LIMIT ?1")
                .bind(limit)
                .fetch_all(&self.pool)
                .await?
        };

        Ok(logs)
    }

    /// 获取错误日志
    pub async fn get_error_logs(&self) -> Result<Vec<AppLog>, DatabaseError> {
        self.get_logs(Some("ERROR"), None).await
    }

    /// 清空日志
    pub async fn clear_logs(&self) -> Result<usize, DatabaseError> {
        let result = sqlx::query("DELETE FROM app_logs")
            .execute(&self.pool)
            .await?;

        Ok(result.rows_affected() as usize)
    }

    /// 获取日志数量
    pub async fn get_log_count(&self) -> Result<i64, DatabaseError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_logs")
            .fetch_one(&self.pool)
            .await?;

        Ok(count)
    }

    /// 测试用构造方法：使用临时数据库文件，跳过 AppHandle 依赖
    /// 仅在 cfg(test) 下编译，不影响生产代码
    #[cfg(test)]
    pub async fn new_test(db_path: &std::path::Path) -> Result<Self, DatabaseError> {
        let db_url = format!("sqlite:{}?mode=rwc", db_path.to_string_lossy());
        let connect_options = SqliteConnectOptions::from_str(&db_url)
            .map_err(DatabaseError::from)?
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(connect_options)
            .await?;

        // sqlx::migrate! 在编译时嵌入迁移内容，运行时无需 migrations 目录
        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool })
    }
}

/// 日志数据结构
#[derive(Debug, Clone, Serialize, sqlx::FromRow, TS)]
#[ts(export)]
pub struct AppLog {
    // SQLite INTEGER 序列化为 JSON number（不会超 2^53），覆盖 ts-rs 10.x 默认的 bigint
    #[ts(type = "number")]
    pub id: i64,
    pub level: String,
    pub message: String,
    pub target: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// 播放历史数据结构
#[derive(Debug, Clone, Serialize, sqlx::FromRow, TS)]
#[ts(export)]
pub struct PlayHistory {
    // SQLite INTEGER 序列化为 JSON number（不会超 2^53），覆盖 ts-rs 10.x 默认的 bigint
    #[ts(type = "number")]
    pub id: i64,
    pub path: String,
    pub played_at: DateTime<Utc>,
    #[ts(type = "number | null")]
    pub duration: Option<i64>,
    pub completed: Option<i32>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// 初始化数据库（供 main.rs 调用）
pub async fn init(app_handle: &AppHandle) -> Result<Database, DatabaseError> {
    Database::init(app_handle).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 构造测试 Song
    fn make_song(path: &str, title: &str) -> Song {
        Song {
            id: format!("id-{}", path),
            title: title.to_string(),
            artist: "TestArtist".to_string(),
            album: "TestAlbum".to_string(),
            duration: 180.0,
            path: path.to_string(),
            cover: None,
            play_count: 0,
            created_at: Utc::now(),
            is_liked: None,
            file_mtime: None,
            file_size: None,
        }
    }

    /// 创建临时数据库并应用迁移
    async fn setup_db() -> (Database, TempDir) {
        let tmp = TempDir::new().expect("Failed to create temp dir");
        let db_path = tmp.path().join("test.db");
        let db = Database::new_test(&db_path)
            .await
            .expect("Failed to init test db");
        (db, tmp)
    }

    #[tokio::test]
    async fn test_get_songs_empty() {
        let (db, _tmp) = setup_db().await;
        let songs = db.get_songs().await.expect("get_songs failed");
        assert!(songs.is_empty(), "空库应返回空 Vec");
    }

    #[tokio::test]
    async fn test_upsert_and_get_songs() {
        let (db, _tmp) = setup_db().await;
        let song = make_song("/music/a.mp3", "SongA");
        let (success, errors) = db
            .upsert_songs(&[song.clone()])
            .await
            .expect("upsert failed");
        assert_eq!(success, 1);
        assert_eq!(errors, 0);

        let songs = db.get_songs().await.expect("get_songs failed");
        assert_eq!(songs.len(), 1);
        assert_eq!(songs[0].path, "/music/a.mp3");
        assert_eq!(songs[0].title, "SongA");
        assert_eq!(songs[0].is_liked, Some(false));
    }

    #[tokio::test]
    async fn test_upsert_songs_conflict_update() {
        // 同 path 不同 title 应触发 ON CONFLICT(path) DO UPDATE
        let (db, _tmp) = setup_db().await;
        let s1 = make_song("/music/dup.mp3", "OldTitle");
        db.upsert_songs(&[s1]).await.unwrap();

        let mut s2 = make_song("/music/dup.mp3", "NewTitle");
        s2.artist = "NewArtist".to_string();
        db.upsert_songs(&[s2]).await.unwrap();

        let songs = db.get_songs().await.unwrap();
        assert_eq!(songs.len(), 1, "同 path 应去重");
        assert_eq!(songs[0].title, "NewTitle");
        assert_eq!(songs[0].artist, "NewArtist");
    }

    #[tokio::test]
    async fn test_toggle_like() {
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[make_song("/music/like.mp3", "Liked")])
            .await
            .unwrap();

        // 点赞
        db.toggle_like("/music/like.mp3", true).await.unwrap();
        let liked = db.get_liked_songs().await.unwrap();
        assert_eq!(liked.len(), 1);
        assert_eq!(liked[0].path, "/music/like.mp3");

        // get_songs 的 is_liked 应为 true
        let songs = db.get_songs().await.unwrap();
        assert_eq!(songs[0].is_liked, Some(true));

        // 取消点赞
        db.toggle_like("/music/like.mp3", false).await.unwrap();
        let liked = db.get_liked_songs().await.unwrap();
        assert!(liked.is_empty(), "取消后应无喜欢歌曲");
    }

    #[tokio::test]
    async fn test_get_play_counts_empty() {
        let (db, _tmp) = setup_db().await;
        let counts = db.get_play_counts().await.unwrap();
        assert!(counts.is_empty());
    }

    #[tokio::test]
    async fn test_increment_play_count_and_get() {
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[make_song("/music/count.mp3", "Counted")])
            .await
            .unwrap();

        db.increment_play_count("/music/count.mp3").await.unwrap();
        db.increment_play_count("/music/count.mp3").await.unwrap();

        let counts = db.get_play_counts().await.unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].0, "/music/count.mp3");
        assert_eq!(counts[0].1, 2);

        // 单首播放次数查询
        let n = db.get_song_play_count("/music/count.mp3").await.unwrap();
        assert_eq!(n, 2);

        // 不存在的歌曲应返回 0
        let n = db.get_song_play_count("/nonexistent.mp3").await.unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn test_get_last_played_song_empty() {
        let (db, _tmp) = setup_db().await;
        let song = db.get_last_played_song().await.unwrap();
        assert!(song.is_none(), "空库（无播放记录）应返回 None");
    }

    #[tokio::test]
    async fn test_get_last_played_song_after_play() {
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[make_song("/music/last.mp3", "LastSong")])
            .await
            .unwrap();
        db.increment_play_count("/music/last.mp3").await.unwrap();

        let last = db
            .get_last_played_song()
            .await
            .unwrap()
            .expect("应返回最后播放歌曲");
        assert_eq!(last.path, "/music/last.mp3");
        assert_eq!(last.title, "LastSong");
        assert_eq!(last.is_liked, Some(false));
    }

    #[tokio::test]
    async fn test_get_last_played_song_excludes_unplayed() {
        // 未播放的歌曲不应被返回
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[make_song("/music/silent.mp3", "Silent")])
            .await
            .unwrap();
        let last = db.get_last_played_song().await.unwrap();
        assert!(last.is_none(), "歌曲未播放，应返回 None");
    }

    #[tokio::test]
    async fn test_add_and_get_play_history() {
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[make_song("/music/hist.mp3", "HistSong")])
            .await
            .unwrap();

        db.add_play_history("/music/hist.mp3", 180, true)
            .await
            .unwrap();
        db.add_play_history("/music/hist.mp3", 90, false)
            .await
            .unwrap();

        let history = db.get_play_history(None).await.unwrap();
        assert_eq!(history.len(), 2);
        // ORDER BY played_at DESC，最新在前
        assert_eq!(history[0].completed, Some(0));
        assert_eq!(history[1].completed, Some(1));
        assert_eq!(history[0].title.as_deref(), Some("HistSong"));
    }

    // ===== 外键约束回归测试：播放/喜欢未入库文件时不应抛 FOREIGN KEY constraint failed =====

    #[tokio::test]
    async fn test_toggle_like_unknown_song_ignored() {
        let (db, _tmp) = setup_db().await;
        // 路径不在 songs 表中（如尚未扫描入库的文件）→ 不应报错，且不写入
        db.toggle_like("/music/not_scanned.mp3", true)
            .await
            .expect("未入库歌曲点赞不应触发外键错误");
        assert!(db.get_liked_paths().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_increment_play_count_unknown_song_ignored() {
        let (db, _tmp) = setup_db().await;
        db.increment_play_count("/music/not_scanned.mp3")
            .await
            .expect("未入库歌曲递增播放次数不应触发外键错误");
        assert!(db.get_play_counts().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_add_play_history_unknown_song_ignored() {
        let (db, _tmp) = setup_db().await;
        db.add_play_history("/music/not_scanned.mp3", 180, true)
            .await
            .expect("未入库歌曲记录播放历史不应触发外键错误");
        assert!(db.get_play_history(None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_clear_liked_songs() {
        let (db, _tmp) = setup_db().await;
        db.upsert_songs(&[
            make_song("/music/a.mp3", "A"),
            make_song("/music/b.mp3", "B"),
        ])
        .await
        .unwrap();
        db.toggle_like("/music/a.mp3", true).await.unwrap();
        db.toggle_like("/music/b.mp3", true).await.unwrap();

        let removed = db.clear_liked_songs().await.unwrap();
        assert_eq!(removed, 2);
        let liked = db.get_liked_songs().await.unwrap();
        assert!(liked.is_empty());
    }

    // ===== cleanup_nonexistent_songs 数据安全护栏 =====

    #[tokio::test]
    async fn test_cleanup_removes_song_whose_parent_dir_still_exists() {
        // 父目录仍在、文件被删 → 属于真实删除，应清理
        let (db, tmp) = setup_db().await;
        let album = tmp.path().join("album");
        std::fs::create_dir_all(&album).unwrap();
        let song_path = album.join("gone.mp3");
        std::fs::write(&song_path, b"fake").unwrap();

        db.upsert_songs(&[make_song(&song_path.to_string_lossy(), "Gone")])
            .await
            .unwrap();
        db.toggle_like(&song_path.to_string_lossy(), true)
            .await
            .unwrap();

        // 删除文件，保留父目录
        std::fs::remove_file(&song_path).unwrap();

        let removed = db.cleanup_nonexistent_songs().await.unwrap();
        assert_eq!(removed, 1, "父目录存在时缺失文件应被清理");
        assert!(db.get_songs().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_cleanup_keeps_songs_when_whole_tree_unreachable() {
        // 父目录也不存在（外接盘未挂载 / 二级文件夹符号链接目标消失）→ 不可判定，
        // 必须保留记录，否则会级联删掉 liked_songs 等用户数据且不可恢复
        let (db, tmp) = setup_db().await;
        let unmounted = tmp.path().join("not-mounted-drive").join("album");
        let song_path = unmounted.join("song.mp3");

        db.upsert_songs(&[make_song(&song_path.to_string_lossy(), "OnUnmountedDrive")])
            .await
            .unwrap();
        db.toggle_like(&song_path.to_string_lossy(), true)
            .await
            .unwrap();
        db.increment_play_count(&song_path.to_string_lossy())
            .await
            .unwrap();

        // 整个挂载点都不存在
        let removed = db.cleanup_nonexistent_songs().await.unwrap();

        assert_eq!(removed, 0, "整片区域不可达时不得清理");
        assert_eq!(db.get_songs().await.unwrap().len(), 1, "歌曲记录应保留");
        assert!(
            !db.get_liked_songs().await.unwrap().is_empty(),
            "喜欢记录不得被级联删除"
        );
        assert!(
            !db.get_play_counts().await.unwrap().is_empty(),
            "播放次数不得被级联删除"
        );
    }

    #[test]
    fn test_is_path_confirmably_deleted() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("exists");
        std::fs::create_dir_all(&dir).unwrap();

        // 父目录存在 + 文件不存在 → 可判定为已删除
        assert!(is_path_confirmably_deleted(
            &dir.join("missing.mp3").to_string_lossy()
        ));
        // 父目录也不存在 → 不可判定
        assert!(!is_path_confirmably_deleted(
            &tmp.path()
                .join("no-such-dir")
                .join("a.mp3")
                .to_string_lossy()
        ));
    }

    // ===== search_songs（FTS5）=====

    /// 插入一首可自定义 artist/album 的歌曲
    async fn insert_song(db: &Database, path: &str, title: &str, artist: &str, album: &str) {
        let mut song = make_song(path, title);
        song.artist = artist.to_string();
        song.album = album.to_string();
        db.upsert_songs(&[song]).await.expect("upsert failed");
    }

    #[test]
    fn test_fts_phrase_query_escapes_quotes() {
        // 内部双引号需按 FTS5 规则转义成两个，否则会破坏短语边界导致语法错误
        assert_eq!(fts_phrase_query("ab\"cd"), "\"ab\"\"cd\"");
        assert_eq!(fts_phrase_query("plain"), "\"plain\"");
    }

    #[tokio::test]
    async fn test_search_songs_empty_query_returns_empty() {
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "SongA", "ArtistA", "AlbumA").await;

        assert!(db.search_songs("").await.unwrap().is_empty());
        assert!(db.search_songs("   ").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_songs_matches_title_substring() {
        // 关键回归：中间子串命中（原 LIKE '%x%' 的语义必须保留）
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "Hello Beautiful World", "X", "Y").await;
        insert_song(&db, "/music/b.mp3", "Another Song", "X", "Y").await;

        let hits = db.search_songs("Beautiful").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/music/a.mp3");
    }

    #[tokio::test]
    async fn test_search_songs_matches_artist_and_album() {
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "T1", "Radiohead", "Kid A").await;
        insert_song(&db, "/music/b.mp3", "T2", "Others", "Other Album").await;

        assert_eq!(db.search_songs("Radiohead").await.unwrap().len(), 1);
        assert_eq!(db.search_songs("Kid A").await.unwrap().len(), 1);
        assert_eq!(db.search_songs("Others").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_search_songs_case_insensitive() {
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "Hello World", "X", "Y").await;

        assert_eq!(db.search_songs("hello").await.unwrap().len(), 1);
        assert_eq!(db.search_songs("HELLO").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_search_songs_short_query_falls_back_to_like() {
        // trigram 至少要 3 个字符，1~2 字符走 LIKE 回退，结果必须正确
        // 注意：LIKE 是子串匹配，"Another" 也含 "he"，所以这里用 "Wo" 保证唯一命中
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "Hello World", "X", "Y").await;
        insert_song(&db, "/music/b.mp3", "Another Song", "X", "Y").await;

        let hits = db.search_songs("Wo").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "/music/a.mp3");

        // 2 个中文字符同样走回退路径
        insert_song(&db, "/music/c.mp3", "周杰伦的晴天", "周杰伦", "叶惠美").await;
        assert_eq!(db.search_songs("周杰").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_search_songs_chinese_substring() {
        // trigram 按字符切分，中文无需分词器即可检索
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "周杰伦的晴天", "周杰伦", "叶惠美").await;
        insert_song(&db, "/music/b.mp3", "无关于此", "其他人", "其他专辑").await;

        let hits = db.search_songs("周杰伦").await.unwrap();
        assert_eq!(hits.len(), 1, "中文子串应命中");
        assert_eq!(hits[0].path, "/music/a.mp3");
    }

    #[tokio::test]
    async fn test_search_songs_special_chars_do_not_error() {
        // FTS5 的 MATCH 有独立语法（- : * " ( 均为元字符），
        // 用户输入必须被安全地转成短语，不能触发语法错误
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "Song a-b Test", "X", "Y").await;

        for query in ["a-b", "a*b", "a\"b", "a(b", "a:b", "a^b", "a OR b", "NOT"] {
            db.search_songs(query)
                .await
                .unwrap_or_else(|e| panic!("查询 {:?} 不应报错: {}", query, e));
        }
    }

    #[tokio::test]
    async fn test_search_songs_reflects_update() {
        // 触发器必须同步索引：upsert 改了 title 后，旧关键词不应再命中
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "OldTitle", "X", "Y").await;
        assert_eq!(db.search_songs("OldTitle").await.unwrap().len(), 1);

        insert_song(&db, "/music/a.mp3", "NewTitle", "X", "Y").await;

        assert_eq!(db.search_songs("NewTitle").await.unwrap().len(), 1);
        assert!(
            db.search_songs("OldTitle").await.unwrap().is_empty(),
            "旧标题不应再命中，说明 FTS 索引已同步"
        );
    }

    #[tokio::test]
    async fn test_search_songs_reflects_delete() {
        // 删除歌曲后索引必须同步清理，否则搜索会返回已不存在的记录
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "DeleteMe", "X", "Y").await;
        assert_eq!(db.search_songs("DeleteMe").await.unwrap().len(), 1);

        db.delete_song("/music/a.mp3").await.unwrap();

        assert!(
            db.search_songs("DeleteMe").await.unwrap().is_empty(),
            "删除后不应命中"
        );
    }

    #[tokio::test]
    async fn test_search_songs_reports_liked_state() {
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "LikedSong", "X", "Y").await;
        db.toggle_like("/music/a.mp3", true).await.unwrap();

        let hits = db.search_songs("LikedSong").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].is_liked, Some(true), "搜索结果应带 is_liked");
    }

    // ===== 隐藏歌曲：计数口径与「取消隐藏」记忆 =====

    #[tokio::test]
    async fn test_hidden_count_matches_list() {
        // 回归：hidden_songs 对 songs 没有外键，可能残留未入库路径的记录，
        // 而 get_hidden_count 原先直接 COUNT(*) → 界面显示的数量比列表多。
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "A", "X", "Y").await;
        insert_song(&db, "/music/b.mp3", "B", "X", "Y").await;
        db.hide_song("/music/a.mp3", false).await.unwrap();

        // 直接写入一条指向未入库路径的隐藏记录（模拟历史数据）
        sqlx::query(
            "INSERT INTO hidden_songs (path, is_auto_hidden) VALUES ('/music/ghost.mp3', 0)",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        assert_eq!(
            db.get_hidden_count().await.unwrap(),
            1,
            "计数必须与列表口径一致（排除未入库路径）"
        );
        assert_eq!(db.get_hidden_songs().await.unwrap().len(), 1);
        assert_eq!(
            db.get_hidden_paths().await.unwrap(),
            vec!["/music/a.mp3".to_string()],
            "路径列表同样要排除未入库路径"
        );
    }

    #[tokio::test]
    async fn test_auto_hide_skips_manually_unhidden() {
        // 回归：加密歌曲每次扫描都会被自动隐藏，而用户取消隐藏原先只是 DELETE，
        // 没有任何地方记住「用户取消过」→ 下次扫描又把同一首歌隐藏回来。
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/enc.ncm", "Enc", "X", "Y").await;

        // 首次扫描：自动隐藏
        db.hide_songs_batch(vec!["/music/enc.ncm".to_string()], true)
            .await
            .unwrap();
        assert!(db.is_song_hidden("/music/enc.ncm").await.unwrap());

        // 用户手动取消隐藏
        db.unhide_song("/music/enc.ncm").await.unwrap();
        assert!(!db.is_song_hidden("/music/enc.ncm").await.unwrap());

        // 再次扫描：自动隐藏必须跳过它
        db.hide_songs_batch(vec!["/music/enc.ncm".to_string()], true)
            .await
            .unwrap();
        assert!(
            !db.is_song_hidden("/music/enc.ncm").await.unwrap(),
            "用户取消过隐藏的歌曲不应被再次自动隐藏"
        );

        // 用户又主动隐藏 → 表达最新意愿，取消隐藏标记应被清除
        db.hide_song("/music/enc.ncm", false).await.unwrap();
        assert!(db.is_song_hidden("/music/enc.ncm").await.unwrap());
        db.hide_songs_batch(vec!["/music/enc.ncm".to_string()], true)
            .await
            .unwrap();
        assert!(
            db.is_song_hidden("/music/enc.ncm").await.unwrap(),
            "用户重新隐藏后应保持隐藏"
        );
    }

    #[tokio::test]
    async fn test_batch_unhide_remembers_override() {
        // 批量取消隐藏（前端多选）同样要写入取消隐藏标记
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.ncm", "A", "X", "Y").await;

        db.hide_songs_batch(vec!["/music/a.ncm".to_string()], true)
            .await
            .unwrap();
        db.unhide_songs_batch(vec!["/music/a.ncm".to_string()])
            .await
            .unwrap();
        db.hide_songs_batch(vec!["/music/a.ncm".to_string()], true)
            .await
            .unwrap();

        assert!(
            !db.is_song_hidden("/music/a.ncm").await.unwrap(),
            "批量取消隐藏同样应阻止后续自动隐藏"
        );
    }

    #[tokio::test]
    async fn test_unhide_unknown_song_does_not_error() {
        // unhidden_overrides 有外键指向 songs(path)，未入库路径必须被 EXISTS 守卫拦下
        let (db, _tmp) = setup_db().await;
        db.unhide_song("/music/not-scanned.mp3")
            .await
            .expect("未入库歌曲取消隐藏不应触发外键错误");
    }

    #[tokio::test]
    async fn test_clear_hidden_songs_clears_overrides() {
        // 「清空隐藏列表」应回到初始状态：连取消隐藏的标记一起清掉，
        // 否则后续扫描不会再自动隐藏加密歌曲
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.ncm", "A", "X", "Y").await;

        db.hide_songs_batch(vec!["/music/a.ncm".to_string()], true)
            .await
            .unwrap();
        db.unhide_song("/music/a.ncm").await.unwrap();

        db.clear_hidden_songs().await.unwrap();

        db.hide_songs_batch(vec!["/music/a.ncm".to_string()], true)
            .await
            .unwrap();
        assert!(
            db.is_song_hidden("/music/a.ncm").await.unwrap(),
            "清空隐藏列表后应恢复自动隐藏行为"
        );
    }

    #[tokio::test]
    async fn test_remove_song_cleans_hidden_related_rows() {
        // 歌曲被删除时，hidden_songs（无外键）与 unhidden_overrides（有外键级联）
        // 都不应留下孤儿记录
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.ncm", "A", "X", "Y").await;
        db.hide_song("/music/a.ncm", false).await.unwrap();
        db.unhide_song("/music/a.ncm").await.unwrap();

        db.delete_song("/music/a.ncm").await.unwrap();

        let hidden: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hidden_songs")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        let overrides: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM unhidden_overrides")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(hidden, 0, "hidden_songs 不应残留孤儿记录");
        assert_eq!(overrides, 0, "unhidden_overrides 应随 songs 级联删除");
    }

    // ===== 更换音乐文件夹：清理不在新目录下的记录 =====

    #[tokio::test]
    async fn test_cleanup_songs_outside_folder() {
        // 回归：换音乐文件夹后，旧目录的记录仍在库里但路径校验全部失败
        // （列表可见、操作全被拒），且旧文件还在磁盘上，cleanup_nonexistent_songs 不会清
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/old/a.mp3", "A", "X", "Y").await;
        insert_song(&db, "/old/sub/b.mp3", "B", "X", "Y").await;
        insert_song(&db, "/new/c.mp3", "C", "X", "Y").await;
        db.toggle_like("/old/a.mp3", true).await.unwrap();

        let removed = db.cleanup_songs_outside_folder("/new").await.unwrap();

        assert_eq!(removed, 2, "只应删除不在 /new 下的记录");
        let songs = db.get_songs().await.unwrap();
        assert_eq!(songs.len(), 1);
        assert_eq!(songs[0].path, "/new/c.mp3");
        assert!(
            db.get_liked_paths().await.unwrap().is_empty(),
            "被清理歌曲的喜欢记录应随之级联删除"
        );
    }

    #[tokio::test]
    async fn test_cleanup_songs_outside_folder_keeps_sibling_prefix() {
        // /Music2 不是 /Music 的子路径：必须用组件级比较，字符串前缀会把
        // /Music2/a.mp3 误判为 /Music 下的歌曲而漏删（或反之误删）
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/Music/a.mp3", "A", "X", "Y").await;
        insert_song(&db, "/Music2/b.mp3", "B", "X", "Y").await;

        let removed = db.cleanup_songs_outside_folder("/Music").await.unwrap();

        assert_eq!(removed, 1);
        let paths: Vec<String> = db
            .get_songs()
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.path)
            .collect();
        assert_eq!(paths, vec!["/Music/a.mp3".to_string()]);
    }

    #[tokio::test]
    async fn test_cleanup_songs_outside_folder_keeps_secondary_link_songs() {
        // 二级文件夹的歌曲在 DB 里存的是**链接路径**（{music_folder}/link/x.mp3），
        // 因此换/保持目录时不应被误删
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/Music/link/x.mp3", "X", "X", "Y").await;
        insert_song(&db, "/Music/y.mp3", "Y", "X", "Y").await;

        let removed = db.cleanup_songs_outside_folder("/Music").await.unwrap();

        assert_eq!(removed, 0, "链接路径仍在曲库根下，不应被清理");
        assert_eq!(db.get_songs().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_cleanup_songs_outside_folder_empty_folder_is_noop() {
        // 空目录路径防御：不能因为 path 为空就把整个曲库删掉
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/Music/a.mp3", "A", "X", "Y").await;

        assert_eq!(db.cleanup_songs_outside_folder("").await.unwrap(), 0);
        assert_eq!(db.cleanup_songs_outside_folder("   ").await.unwrap(), 0);
        assert_eq!(db.get_songs().await.unwrap().len(), 1);
    }

    // ===== 播放次数：两处计数必须始终一致 =====
    #[tokio::test]
    async fn test_play_counts_stay_in_sync() {
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "A", "X", "Y").await;

        db.increment_play_count("/music/a.mp3").await.unwrap();
        db.increment_play_count("/music/a.mp3").await.unwrap();

        let songs = db.get_songs().await.unwrap();
        assert_eq!(songs[0].play_count, 2, "songs.play_count 应累加");
        assert_eq!(
            db.get_song_play_count("/music/a.mp3").await.unwrap(),
            2,
            "play_counts.count 应同步累加"
        );
    }

    #[tokio::test]
    async fn test_clear_play_history_resets_both_counts() {
        // 回归：原先只删 play_history，两处计数仍留着 →
        // 用户点「清空播放历史」后次数没清，且两处口径存在分叉风险。
        let (db, _tmp) = setup_db().await;
        insert_song(&db, "/music/a.mp3", "A", "X", "Y").await;
        db.increment_play_count("/music/a.mp3").await.unwrap();
        db.add_play_history("/music/a.mp3", 180, true)
            .await
            .unwrap();

        db.clear_play_history().await.unwrap();

        assert!(db.get_play_history(None).await.unwrap().is_empty());
        assert!(db.get_play_counts().await.unwrap().is_empty());
        assert_eq!(
            db.get_song_play_count("/music/a.mp3").await.unwrap(),
            0,
            "play_counts.count 应被复位"
        );
        assert_eq!(
            db.get_songs().await.unwrap()[0].play_count,
            0,
            "songs.play_count 应被复位"
        );
        assert!(
            db.get_last_played_song().await.unwrap().is_none(),
            "清空历史后不应再有「上次播放」兜底"
        );
    }
}
