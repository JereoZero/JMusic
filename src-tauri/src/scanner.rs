use crate::constants::{
    is_encrypted_extension, is_playable_extension, ENCRYPTED_AUDIO_EXTENSIONS,
    UNSUPPORTED_AUDIO_EXTENSIONS,
};
use crate::database::Database;
use crate::database::Song;
use crate::metadata::MetadataExtractor;
use crate::ncm::is_ncm_file;
use crate::qmc::is_qmc_file;
use chrono::Utc;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};
use tracing::{debug, error, info, warn};
use ts_rs::TS;
use uuid::Uuid;
use walkdir::WalkDir;

/// 扫描进度 emit 的间隔（避免高频 emit 淹没前端）
const WALK_EMIT_INTERVAL: usize = 200;
const METADATA_EMIT_INTERVAL: usize = 50;

#[derive(Serialize, TS)]
#[ts(export)]
pub struct ScanResult {
    pub normal_songs: Vec<Song>,
    pub encrypted_songs: Vec<Song>,
    pub metadata_errors: Vec<String>,
    /// 增量扫描跳过的未变文件数（mtime 匹配，无需重新提取元数据）
    pub skipped: usize,
}

/// 扫描**并写库**完成后广播给前端的统计。
///
/// 前端据此重新拉取曲库。为什么需要这个事件：启动时的自动扫描是后台异步任务
/// （main.rs 的 setup 里 spawn），而前端挂载时的 `get_songs` 几乎必然先返回 ——
/// 空库首启时它是毫秒级的，扫描却要走文件系统 + 提取元数据。没有完成通知，
/// 界面会一直停在「曲库为空」，用户只能手动下拉刷新或进设置重新扫描。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ScanSummary {
    /// 本次写入/更新的正常歌曲数
    pub normal: usize,
    /// 本次写入/更新的加密歌曲数
    pub encrypted: usize,
    /// 因 mtime + size 均未变而跳过元数据提取的文件数
    pub skipped: usize,
    /// 元数据提取失败的文件数
    pub metadata_errors: usize,
}

/// 扫描失败时广播给前端的负载
#[derive(Debug, Clone, Serialize)]
pub struct ScanErrorPayload {
    pub message: String,
}

/// 广播「扫描并写库完成」事件。
///
/// ⚠️ 必须在调用方**写库完成之后**调用：前端收到事件会立即重新拉取曲库，
/// 若在写库前发出，拉到的仍是旧数据（等于没修）。
pub fn emit_scan_complete(app_handle: &AppHandle, summary: ScanSummary) {
    let _ = app_handle.emit("scan_complete", summary);
}

/// 广播「扫描失败」事件。
pub fn emit_scan_error(app_handle: &AppHandle, message: impl Into<String>) {
    let _ = app_handle.emit(
        "scan_error",
        ScanErrorPayload {
            message: message.into(),
        },
    );
}

/// 清理「已不存在的歌曲记录」的范围。
#[derive(Debug, Clone, Copy)]
pub enum CleanupScope {
    /// 扫描主文件夹：全局清理所有已不在磁盘上的歌曲记录
    Global,
    /// 扫描子文件夹：只清理该文件夹范围，避免误删其他文件夹（如未挂载的外接盘）的歌曲
    Folder,
}

/// 扫描音乐文件夹并把结果写入数据库，返回完整扫描结果。
///
/// **启动时的自动扫描（main.rs）与设置页的「重新扫描」（`scan_folder` 命令）共用本函数。**
/// 这两条路径此前各自实现了一遍，已经分叉过：一方漏了缩略图回收、另一方漏了自动隐藏
/// 加密歌曲，且返回给前端的计数被 `mem::take` 搬空。后续扫描逻辑的调整只需改这里。
pub async fn scan_and_persist(
    db: &Database,
    folder: &str,
    cleanup_scope: CleanupScope,
    app_handle: &AppHandle,
) -> anyhow::Result<ScanResult> {
    // 0. 扫描根必须可达 —— 必须在任何清理之前判定。
    //    若根目录不存在（外接盘未挂载 / 路径失效），下面按路径前缀判定的清理
    //    会把整个曲库都视为「不在根下」而删光；即便不清范围外记录，
    //    cleanup_nonexistent_songs 也会因所有文件 exists()==false 而误删
    //    （其内部虽有父目录护栏，但根目录消失时父目录同样不存在，护栏会拦住 ——
    //    这里的前置检查是第二道防线，也避免无意义的遍历）。
    let scan_path = std::path::Path::new(folder);
    if !scan_path.exists() {
        anyhow::bail!("Directory does not exist: {}", folder);
    }
    if !scan_path.is_dir() {
        anyhow::bail!("Path is not a directory: {}", folder);
    }

    // 1. 清理已不存在的歌曲记录
    let cleanup_result = match cleanup_scope {
        CleanupScope::Global => db.cleanup_nonexistent_songs().await,
        CleanupScope::Folder => db.cleanup_nonexistent_songs_in_folder(folder).await,
    };
    match cleanup_result {
        Ok(removed) => info!("Removed {} non-existent songs", removed),
        Err(e) => error!("Failed to cleanup non-existent songs: {}", e),
    }

    // 2. 全局清理时，同时清掉「不在当前曲库根下」的记录。
    //
    //    换过音乐文件夹（旧版本遗留、或本次未走 set_setting 的路径）后，旧目录的
    //    歌曲记录仍在库里，但路径校验会因路径不在新目录内而全部拒绝 ——
    //    列表里可见、播放/收藏/删除却都返回 Access denied。
    //    旧文件通常仍在磁盘上，所以上一步的 cleanup_nonexistent_songs 不会清理它们。
    //
    //    ⚠️ 只在 Global 范围执行：扫描子文件夹时 folder 是子路径，用它当基准
    //    会把主目录下的其他歌曲全部误判为「范围外」。调用方保证 Global 时
    //    folder 就是当前 music_folder 的原值。
    if matches!(cleanup_scope, CleanupScope::Global) {
        match db.cleanup_songs_outside_folder(folder).await {
            Ok(removed) => {
                if removed > 0 {
                    info!("Removed {} song(s) outside the music folder", removed);
                }
            }
            Err(e) => error!("Failed to cleanup songs outside music folder: {}", e),
        }
    }

    // 3. 扫描（增量：mtime + size 均未变的文件跳过元数据提取）
    let existing_mtimes = db.get_all_song_mtimes().await.unwrap_or_else(|e| {
        warn!(
            "Failed to load existing mtimes, falling back to full scan: {}",
            e
        );
        Default::default()
    });
    let scanner = FolderScanner::new();
    let result = match scanner
        .scan(folder, existing_mtimes, app_handle.clone())
        .await
    {
        Ok(result) => result,
        Err(e) => {
            emit_scan_error(app_handle, e.to_string());
            return Err(e);
        }
    };

    // 4. 落库（按引用 upsert，保留 Vec 供下面返回给前端展示计数）
    if !result.normal_songs.is_empty() {
        match db.upsert_songs(&result.normal_songs).await {
            Ok((success, errors)) => {
                if errors > 0 {
                    warn!("{} normal songs failed to insert", errors);
                }
                info!("Saved {} normal songs, {} errors", success, errors);
            }
            Err(e) => error!("Failed to save normal songs: {}", e),
        }
    }

    // 加密歌曲（ncm/qmc）入库后自动隐藏：它们无法直接播放，留在列表里只会让用户困惑。
    // hide_songs_batch 内部会跳过「用户手动取消过隐藏」的路径，故可无条件调用。
    if !result.encrypted_songs.is_empty() {
        // 先提取 paths，避免 clone 整个 Vec<Song>
        let encrypted_paths: Vec<String> = result
            .encrypted_songs
            .iter()
            .map(|s| s.path.clone())
            .collect();
        match db.upsert_songs(&result.encrypted_songs).await {
            Ok((success, errors)) => {
                if success > 0 {
                    if let Err(e) = db.hide_songs_batch(encrypted_paths, true).await {
                        error!("Failed to auto-hide encrypted songs: {}", e);
                    }
                }
                if errors > 0 {
                    warn!("{} encrypted songs failed to insert", errors);
                }
            }
            Err(e) => error!("Failed to save encrypted songs: {}", e),
        }
    }

    // 5. 回收孤儿/失效缩略图：歌曲被移出曲库（删除记录 / 更换音乐文件夹）后，
    //    其缩略图缓存没有任何清理路径，会随每次库变更持续累积占用磁盘。
    //    取数失败时跳过，避免误删整个缓存（cleanup 内部对空列表也会跳过）。
    //
    //    用 get_all_song_paths（无 WHERE 过滤）而不是 get_all_song_mtimes：
    //    后者带 `WHERE file_mtime IS NOT NULL`，会把 mtime 为 NULL 的历史记录
    //    误判为「不在曲库」而删掉它们的缩略图。这里也只需 path 一列，更省。
    match db.get_all_song_paths().await {
        Ok(valid_paths) => {
            if let Err(e) = tokio::task::spawn_blocking(move || {
                crate::thumbnail::cleanup_orphan_thumbnails(&valid_paths)
            })
            .await
            {
                warn!("Orphan thumbnail cleanup task failed: {}", e);
            }
        }
        Err(e) => warn!("Skipping orphan thumbnail cleanup: {}", e),
    }

    // 6. 通知前端重新拉取曲库 —— **必须在落库之后**，否则前端拉到的还是旧数据
    emit_scan_complete(
        app_handle,
        ScanSummary {
            normal: result.normal_songs.len(),
            encrypted: result.encrypted_songs.len(),
            skipped: result.skipped,
            metadata_errors: result.metadata_errors.len(),
        },
    );

    // 7. 曲库结构可能已变化（新增/移除了符号链接）→ 让路径校验的白名单缓存失效。
    //    不失效的话，新出现的链接在缓存过期前不被认可，其下的歌曲会返回 Access denied。
    crate::path_validator::invalidate_secondary_targets_cache();

    Ok(result)
}

pub struct FolderScanner;

/// 文件身份标识，用于扫描去重。
///
/// # 为什么不用 `path.canonicalize()`
///
/// 同一文件可能经不同路径到达（符号链接、大小写差异、挂载点别名），必须去重。
/// 原实现用 canonicalize 后的路径作键，但它要逐级解析路径上每个组件 ——
/// 实测比一次 stat **贵约 5.8 倍**（6000 文件：realpath 577ms vs stat 99ms），
/// 而 `(dev, ino)` 直接取自那次本来就要做的 stat，零额外成本。
///
/// # 行为差异
///
/// 硬链接（同一 inode 对应多个路径）会被去重，只入库一次。
/// 音乐库中硬链接极罕见，且「同一份音频只出现一次」本身更符合预期。
#[cfg(unix)]
type FileId = (u64, u64);

#[cfg(unix)]
fn file_id(_path: &Path, metadata: &std::fs::Metadata) -> FileId {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

/// 非 Unix 平台回退到 canonicalize（Windows 支持已推迟，此分支当前不会执行）
#[cfg(not(unix))]
type FileId = PathBuf;

#[cfg(not(unix))]
fn file_id(path: &Path, _metadata: &std::fs::Metadata) -> FileId {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl FolderScanner {
    pub fn new() -> Self {
        Self
    }

    /// 扫描文件夹，提取音频元数据
    /// existing_mtimes: DB 中已存储的 {path: (file_mtime, file_size)}，
    ///                  两者均未变的文件跳过元数据提取
    /// app_handle: 用于向前端 emit 扫描**进度**事件（scan_progress）
    ///
    /// 注意：本函数只负责扫描，**不写库**，因此不发 `scan_complete` —— 完成事件
    /// 由调用方在 upsert 落库后通过 [`emit_scan_complete`] 发出，否则前端会在
    /// 数据写入前就去拉取曲库。
    ///
    /// existing_mtimes 按值接收：内部要把它移进 spawn_blocking 的闭包，按值接收
    /// 让调用方直接移交所有权，省掉一次全量 HashMap 克隆（约 1MB / 10k 首）。
    pub async fn scan(
        &self,
        folder_path: &str,
        existing_mtimes: HashMap<String, (i64, Option<i64>)>,
        app_handle: AppHandle,
    ) -> anyhow::Result<ScanResult> {
        let folder_path = folder_path.to_string();
        let existing_mtimes = Arc::new(existing_mtimes);
        let app_handle_clone = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            Self::scan_blocking(&folder_path, &existing_mtimes, &app_handle_clone)
        })
        .await?
    }

    fn scan_blocking(
        folder_path: &str,
        existing_mtimes: &HashMap<String, (i64, Option<i64>)>,
        app_handle: &AppHandle,
    ) -> anyhow::Result<ScanResult> {
        let scan_path = Path::new(folder_path);
        if !scan_path.exists() {
            anyhow::bail!("Directory does not exist: {}", folder_path);
        }
        if !scan_path.is_dir() {
            anyhow::bail!("Path is not a directory: {}", folder_path);
        }
        info!("Starting folder scan: {}", folder_path);

        // 阶段 1：WalkDir 遍历收集候选文件路径 + mtime + size（IO 密集，单线程足够）
        let mut supported_files: Vec<(PathBuf, i64, Option<i64>)> = Vec::with_capacity(500);
        let mut encrypted_files: Vec<(PathBuf, String)> = Vec::with_capacity(50);
        let mut visited: HashSet<FileId> = HashSet::new();
        let mut scanned = 0usize;
        let mut skipped = 0usize;

        // M5 优化：filter_entry 跳过隐藏目录(.git/.DS_Store)和 NAS 元数据目录(@eaDir)
        // max_depth(50) 限制递归深度，配合 visited 去重防止恶意 symlink 循环或目录爆炸
        for entry in WalkDir::new(folder_path)
            .follow_links(true)
            .max_depth(50)
            .into_iter()
            .filter_entry(|e| {
                // depth 0 是扫描根自身，必须无条件放行：
                // filter_entry 对根条目同样生效，若音乐文件夹名为 `.music` 之类的
                // 隐藏目录，会被整体 skip_current_dir 过滤掉，扫描静默返回 0 首且无提示。
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name();
                !name.to_string_lossy().starts_with('.') && name != "@eaDir"
            })
            .filter_map(|e| e.ok())
        {
            let path = entry.path();

            // 一次 stat 同时拿到：是否为文件、去重标识、mtime、size。
            // 原实现对每个文件做了 is_file() + canonicalize() + metadata() 三套系统调用，
            // 其中 canonicalize 要逐级解析路径上每个组件，实测比 stat 贵约 5.8 倍
            // （6000 文件：realpath 577ms vs stat 99ms）—— 而这些信息一次 stat 全都有。
            let metadata = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    // stat 失败（权限不足 / 竞态删除）→ 跳过。入库了也打不开该文件。
                    debug!("Failed to stat {:?}: {}", path, e);
                    continue;
                }
            };

            if !metadata.is_file() {
                continue;
            }

            if !visited.insert(file_id(&path, &metadata)) {
                continue;
            }

            scanned += 1;

            // 阶段 1 进度反馈：每 WALK_EMIT_INTERVAL 个文件 emit 一次
            if scanned.is_multiple_of(WALK_EMIT_INTERVAL) {
                let _ = app_handle.emit(
                    "scan_progress",
                    serde_json::json!({
                        "phase": "walking",
                        "scanned": scanned,
                        "supported": supported_files.len(),
                        "skipped": skipped,
                    }),
                );
            }

            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();

                let is_supported =
                    is_playable_extension(&ext_lower) && !is_encrypted_extension(&ext_lower);
                let is_encrypted =
                    is_ncm_file(path) || is_qmc_file(path) || is_encrypted_extension(&ext_lower);

                if is_supported {
                    // 路径必须以合法 UTF-8 入库：DB 的 path 列是 TEXT、IPC 也是 UTF-8，
                    // 而 to_string_lossy 会把非法字节替换成 U+FFFD，得到的路径再也无法
                    // 打开该文件（歌曲会显示在列表里却永远播放失败）。
                    // macOS 的 APFS/HFS+ 强制 UTF-8，主要影响 exFAT/SMB 挂载点，
                    // 此时宁可跳过并记录日志，也不写入必然失效的记录。
                    let Some(path_str) = path.to_str().map(str::to_string) else {
                        warn!("Skipping file with non-UTF-8 path: {:?}", path);
                        continue;
                    };

                    // mtime + size 用于增量扫描判断（毫秒精度，避免同秒内修改被漏判）。
                    // 复用上面那次 stat 的结果，不再重复调用 metadata()。
                    let mtime = metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let size = Some(metadata.len() as i64);

                    // 增量扫描：mtime 与 size 均未变才跳过。
                    // 仅比 mtime 会漏判「内容变但 mtime 不变」的情况——cp -p / rsync -t /
                    // 恢复备份都会保留原 mtime，导致 DB 元数据永久陈旧。
                    // size 为 None（历史记录尚未回填）时保守重扫一次。
                    if let Some(&(existing_mtime, existing_size)) = existing_mtimes.get(&path_str) {
                        if existing_mtime == mtime
                            && existing_size.is_some()
                            && existing_size == size
                        {
                            skipped += 1;
                            continue;
                        }
                    }

                    supported_files.push((path.to_path_buf(), mtime, size));
                } else if is_encrypted || Self::is_unsupported_format(&ext_lower) {
                    encrypted_files.push((path.to_path_buf(), ext_lower));
                }
            }
        }

        info!(
            "WalkDir completed. Scanned: {}, Supported (changed): {}, Encrypted: {}, Skipped (unchanged): {}",
            scanned,
            supported_files.len(),
            encrypted_files.len(),
            skipped
        );

        // 阶段 1 完成：emit 汇总
        let _ = app_handle.emit(
            "scan_progress",
            serde_json::json!({
                "phase": "walking_done",
                "scanned": scanned,
                "supported": supported_files.len(),
                "encrypted": encrypted_files.len(),
                "skipped": skipped,
            }),
        );

        // 阶段 2：rayon 并行提取元数据（CPU 密集，多核并行加速）
        // 用 AtomicUsize 计数，定期 emit 进度（AppHandle 是 Send + Sync，可安全传入 rayon 闭包）
        let total = supported_files.len();
        let processed = AtomicUsize::new(0);
        let results: Vec<(Song, Option<String>)> = supported_files
            .par_iter()
            .map(|(path, mtime, size)| {
                let r = Self::process_normal_file(path, *mtime, *size);
                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if done.is_multiple_of(METADATA_EMIT_INTERVAL) || done == total {
                    let _ = app_handle.emit(
                        "scan_progress",
                        serde_json::json!({
                            "phase": "metadata",
                            "processed": done,
                            "total": total,
                        }),
                    );
                }
                r
            })
            .collect();

        let mut normal_songs = Vec::with_capacity(results.len());
        let mut metadata_errors = Vec::with_capacity(20);

        for (song, warn_msg) in results {
            // 元数据提取失败不再丢弃整首，只把原因汇总起来供 UI 提示
            if let Some(msg) = warn_msg {
                metadata_errors.push(msg);
            }
            normal_songs.push(song);
        }

        // 阶段 3：处理加密/不支持文件（轻量级，串行即可）
        let encrypted_songs: Vec<Song> = encrypted_files
            .into_iter()
            .filter_map(|(path, ext)| {
                Self::process_unsupported_file(&path, &ext, is_encrypted_extension(&ext))
            })
            .collect();

        info!(
            "Folder scan completed. Scanned: {}, Normal: {}, Encrypted: {}, MetadataErrors: {}, Skipped: {}",
            scanned,
            normal_songs.len(),
            encrypted_songs.len(),
            metadata_errors.len(),
            skipped
        );

        Ok(ScanResult {
            normal_songs,
            encrypted_songs,
            metadata_errors,
            skipped,
        })
    }

    /// 处理单个正常音频文件，返回 `(Song, 可选的元数据错误信息)`。
    ///
    /// **元数据提取失败时不再丢弃整首**：改用文件名兜底（标题 = 文件名、
    /// 歌手/专辑 = Unknown、时长尝试用 symphonia 估算），并把失败原因一并返回
    /// 供上层汇总提示。此前直接 `return Err` 会让「标签损坏但音频流可解」的文件
    /// **永远不入库** —— 用户在列表里根本看不到它，也就无从发现播放器其实能播它。
    fn process_normal_file(
        path: &Path,
        file_mtime: i64,
        file_size: Option<i64>,
    ) -> (Song, Option<String>) {
        let path_str = path.to_string_lossy().to_string();

        let (metadata, extract_error) = match MetadataExtractor::extract_blocking(&path_str) {
            Ok(m) => (Some(m), None),
            Err(e) => {
                let err_msg = format!("Failed to extract metadata from {}: {}", path_str, e);
                warn!("{}", err_msg);
                (None, Some(err_msg))
            }
        };

        // 时长：优先用标签里的时长，缺失或为 0 时用 symphonia 估算
        let duration = match metadata.as_ref().map(|m| m.duration) {
            Some(d) if d > 0.0 => d,
            _ => Self::get_duration_from_symphonia(&path_str).unwrap_or(0.0),
        };

        let filename = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let song = Song {
            id: Uuid::new_v4().to_string(),
            title: metadata
                .as_ref()
                .and_then(|m| m.title.clone())
                .unwrap_or_else(|| filename.clone()),
            artist: metadata
                .as_ref()
                .and_then(|m| m.artist.clone())
                .unwrap_or_else(|| "Unknown Artist".to_string()),
            album: metadata
                .as_ref()
                .and_then(|m| m.album.clone())
                .unwrap_or_else(|| "Unknown Album".to_string()),
            duration,
            path: path_str,
            cover: metadata.and_then(|m| m.cover),
            play_count: 0,
            created_at: Utc::now(),
            is_liked: None,
            file_mtime: Some(file_mtime),
            file_size,
        };

        (song, extract_error)
    }

    fn get_duration_from_symphonia(path: &str) -> Option<f64> {
        use std::fs::File;
        use std::path::PathBuf;
        use symphonia::core::codecs::CODEC_TYPE_NULL;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;

        let path = PathBuf::from(path);
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                debug!(
                    "Failed to open file for duration detection: {:?}: {}",
                    path, e
                );
                return None;
            }
        };
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();

        let probed = match symphonia::default::get_probe().format(
            &hint,
            mss,
            &format_opts,
            &metadata_opts,
        ) {
            Ok(p) => p,
            Err(e) => {
                debug!("Failed to probe audio format: {:?}: {}", path, e);
                return None;
            }
        };
        let format_reader = probed.format;

        let track = format_reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;

        let codec_params = &track.codec_params;

        codec_params.time_base.and_then(|tb| {
            codec_params.n_frames.map(|frames| {
                // tb.denom == 0 会导致除零产生 infinity
                if tb.denom == 0 {
                    return 0.0;
                }
                let secs = frames as f64 * tb.numer as f64 / tb.denom as f64;
                if secs.is_finite() && secs >= 0.0 {
                    secs
                } else {
                    0.0
                }
            })
        })
    }

    fn is_unsupported_format(ext: &str) -> bool {
        UNSUPPORTED_AUDIO_EXTENSIONS.contains(&ext)
            || ENCRYPTED_AUDIO_EXTENSIONS.contains(&ext)
            || matches!(ext, "kgm" | "mgg" | "vpr" | "kwm")
    }

    fn process_unsupported_file(path: &Path, ext: &str, _is_encrypted: bool) -> Option<Song> {
        // 非 UTF-8 路径无法在 DB(TEXT)/IPC(UTF-8) 中正确往返，跳过而非写入 U+FFFD 占位路径
        let path_str = path.to_str()?.to_string();

        let filename = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let format_note = match ext {
            "ncm" => "网易云加密格式",
            "qmc" | "qmc0" | "qmc3" => "QQ音乐加密格式",
            "ape" => "APE格式",
            "wv" | "wvc" => "WavPack格式",
            "wma" => "WMA格式",
            "tta" => "TTA格式",
            "kgm" => "酷狗加密格式",
            "mflac" => "QQ音乐无损加密",
            "mgg" => "QQ音乐加密",
            "vpr" => "酷狗加密",
            "kwm" => "酷我加密",
            _ => "不支持",
        };

        let metadata = std::fs::metadata(path).ok();
        let file_mtime = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let file_size = metadata.as_ref().map(|m| m.len() as i64);

        let song = Song {
            id: Uuid::new_v4().to_string(),
            title: format!("{} [{}]", filename, format_note),
            artist: "无法播放".to_string(),
            album: "不支持的格式".to_string(),
            duration: 0.0,
            path: path_str,
            cover: None,
            play_count: 0,
            created_at: Utc::now(),
            is_liked: None,
            file_mtime,
            file_size,
        };

        Some(song)
    }
}
