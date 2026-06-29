use crate::database::Song;
use crate::metadata::MetadataExtractor;
use crate::ncm::is_ncm_file;
use crate::qmc::is_qmc_file;
use crate::constants::{is_playable_extension, is_encrypted_extension, ENCRYPTED_AUDIO_EXTENSIONS, UNSUPPORTED_AUDIO_EXTENSIONS};
use std::sync::Arc;
use chrono::Utc;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};
use tracing::{info, debug, warn};
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

pub struct FolderScanner;

impl FolderScanner {
    pub fn new() -> Self {
        Self
    }

    /// 扫描文件夹，提取音频元数据
    /// existing_mtimes: DB 中已存储的 {path: file_mtime}，mtime 匹配的文件跳过元数据提取
    /// app_handle: 用于向前端 emit 扫描进度事件（scan_progress / scan_complete / scan_error）
    pub async fn scan(
        &self,
        folder_path: &str,
        existing_mtimes: &HashMap<String, i64>,
        app_handle: AppHandle,
    ) -> anyhow::Result<ScanResult> {
        let folder_path = folder_path.to_string();
        // 用 Arc 避免克隆整个 HashMap（~1MB/10k 歌曲）
        let existing_mtimes = Arc::new(existing_mtimes.clone());
        let app_handle_clone = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            Self::scan_blocking(&folder_path, &existing_mtimes, &app_handle_clone)
        }).await?
    }

    fn scan_blocking(
        folder_path: &str,
        existing_mtimes: &HashMap<String, i64>,
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

        // 阶段 1：WalkDir 遍历收集候选文件路径 + mtime（IO 密集，单线程足够）
        let mut supported_files: Vec<(PathBuf, i64)> = Vec::with_capacity(500);
        let mut encrypted_files: Vec<(PathBuf, String)> = Vec::with_capacity(50);
        let mut visited: HashSet<PathBuf> = HashSet::new();
        let mut scanned = 0usize;
        let mut skipped = 0usize;

        // M5 优化：filter_entry 跳过隐藏目录(.git/.DS_Store)和 NAS 元数据目录(@eaDir)
        // max_depth(50) 限制递归深度，配合 visited 去重防止恶意 symlink 循环或目录爆炸
        for entry in WalkDir::new(folder_path)
            .follow_links(true)
            .max_depth(50)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name();
                !name.to_string_lossy().starts_with('.') && name != "@eaDir"
            })
            .filter_map(|e| e.ok())
        {
            let path = entry.path();

            if !path.is_file() {
                continue;
            }

            let canonical = match path.canonicalize() {
                Ok(p) => p,
                Err(e) => {
                    debug!("Failed to canonicalize {:?}: {}", path, e);
                    continue;
                }
            };

            if !visited.insert(canonical) {
                continue;
            }

            scanned += 1;

            // 阶段 1 进度反馈：每 WALK_EMIT_INTERVAL 个文件 emit 一次
            if scanned.is_multiple_of(WALK_EMIT_INTERVAL) {
                let _ = app_handle.emit("scan_progress", serde_json::json!({
                    "phase": "walking",
                    "scanned": scanned,
                    "supported": supported_files.len(),
                    "skipped": skipped,
                }));
            }

            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();

                let is_supported = is_playable_extension(&ext_lower) && !is_encrypted_extension(&ext_lower);
                let is_encrypted = is_ncm_file(path) || is_qmc_file(path) || is_encrypted_extension(&ext_lower);

                if is_supported {
                    // 获取文件 mtime 用于增量扫描判断（毫秒精度，避免同秒内修改被漏判）
                    let path_str = path.to_string_lossy().to_string();
                    let mtime = std::fs::metadata(path)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);

                    // 增量扫描：mtime 匹配则跳过（文件未变更，DB 中已有最新元数据）
                    if let Some(&existing_mtime) = existing_mtimes.get(&path_str) {
                        if existing_mtime == mtime {
                            skipped += 1;
                            continue;
                        }
                    }

                    supported_files.push((path.to_path_buf(), mtime));
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
        let _ = app_handle.emit("scan_progress", serde_json::json!({
            "phase": "walking_done",
            "scanned": scanned,
            "supported": supported_files.len(),
            "encrypted": encrypted_files.len(),
            "skipped": skipped,
        }));

        // 阶段 2：rayon 并行提取元数据（CPU 密集，多核并行加速）
        // 用 AtomicUsize 计数，定期 emit 进度（AppHandle 是 Send + Sync，可安全传入 rayon 闭包）
        let total = supported_files.len();
        let processed = AtomicUsize::new(0);
        let results: Vec<Result<Song, String>> = supported_files
            .par_iter()
            .map(|(path, mtime)| {
                let r = Self::process_normal_file(path, *mtime);
                let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if done.is_multiple_of(METADATA_EMIT_INTERVAL) || done == total {
                    let _ = app_handle.emit("scan_progress", serde_json::json!({
                        "phase": "metadata",
                        "processed": done,
                        "total": total,
                    }));
                }
                r
            })
            .collect();

        let mut normal_songs = Vec::with_capacity(results.len());
        let mut metadata_errors = Vec::with_capacity(20);
        let mut errors = 0usize;

        for result in results {
            match result {
                Ok(song) => normal_songs.push(song),
                Err(err_msg) => {
                    errors += 1;
                    metadata_errors.push(err_msg);
                }
            }
        }

        // 阶段 3：处理加密/不支持文件（轻量级，串行即可）
        let encrypted_songs: Vec<Song> = encrypted_files
            .into_iter()
            .filter_map(|(path, ext)| Self::process_unsupported_file(&path, &ext, is_encrypted_extension(&ext)))
            .collect();

        info!(
            "Folder scan completed. Scanned: {}, Normal: {}, Encrypted: {}, Errors: {}, MetadataErrors: {}, Skipped: {}",
            scanned,
            normal_songs.len(),
            encrypted_songs.len(),
            errors,
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

    /// 处理单个正常音频文件，返回 Song 或错误消息
    fn process_normal_file(path: &Path, file_mtime: i64) -> Result<Song, String> {
        let path_str = path.to_string_lossy().to_string();

        let metadata = match MetadataExtractor::extract_blocking(&path_str) {
            Ok(m) => m,
            Err(e) => {
                let err_msg = format!("Failed to extract metadata from {}: {}", path_str, e);
                warn!("{}", err_msg);
                return Err(err_msg);
            }
        };

        let duration = if metadata.duration > 0.0 {
            metadata.duration
        } else {
            Self::get_duration_from_symphonia(&path_str).unwrap_or(0.0)
        };

        let filename = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Unknown")
            .to_string();

        Ok(Song {
            id: Uuid::new_v4().to_string(),
            title: metadata.title.clone().unwrap_or_else(|| filename.clone()),
            artist: metadata.artist.clone().unwrap_or_else(|| "Unknown Artist".to_string()),
            album: metadata.album.clone().unwrap_or_else(|| "Unknown Album".to_string()),
            duration,
            path: path_str,
            cover: metadata.cover,
            play_count: 0,
            created_at: Utc::now(),
            is_liked: None,
            file_mtime: Some(file_mtime),
        })
    }

    fn get_duration_from_symphonia(path: &str) -> Option<f64> {
        use symphonia::core::codecs::CODEC_TYPE_NULL;
        use symphonia::core::formats::FormatOptions;
        use symphonia::core::io::MediaSourceStream;
        use symphonia::core::meta::MetadataOptions;
        use symphonia::core::probe::Hint;
        use std::fs::File;
        use std::path::PathBuf;

        let path = PathBuf::from(path);
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                debug!("Failed to open file for duration detection: {:?}: {}", path, e);
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

        let probed = match symphonia::default::get_probe().format(&hint, mss, &format_opts, &metadata_opts) {
            Ok(p) => p,
            Err(e) => {
                debug!("Failed to probe audio format: {:?}: {}", path, e);
                return None;
            }
        };
        let format_reader = probed.format;

        let track = format_reader.tracks()
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
                if secs.is_finite() && secs >= 0.0 { secs } else { 0.0 }
            })
        })
    }

    fn is_unsupported_format(ext: &str) -> bool {
        UNSUPPORTED_AUDIO_EXTENSIONS.contains(&ext)
            || ENCRYPTED_AUDIO_EXTENSIONS.contains(&ext)
            || matches!(ext, "kgm" | "mgg" | "vpr" | "kwm")
    }

    fn process_unsupported_file(path: &Path, ext: &str, _is_encrypted: bool) -> Option<Song> {
        let path_str = path.to_string_lossy().to_string();

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

        let file_mtime = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

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
        };

        Some(song)
    }
}
