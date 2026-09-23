use base64::Engine;
use std::collections::HashMap;
use tauri::State;

use super::common::{
    get_music_folder_and_targets, get_or_create_thumbnail, validate_path_in_music_folder,
    ApiResponse, ThumbnailInfo, MAX_BATCH_SIZE,
};
use crate::database::Database;
use crate::database::Song;

#[tauri::command]
pub async fn get_songs(db: State<'_, Database>) -> Result<ApiResponse<Vec<Song>>, String> {
    match db.get_songs().await {
        Ok(songs) => Ok(ApiResponse::ok(songs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

/// 获取最后播放的歌曲（restoreLastSong 后端兜底）
#[tauri::command]
pub async fn get_last_played_song(
    db: State<'_, Database>,
) -> Result<ApiResponse<Option<Song>>, String> {
    match db.get_last_played_song().await {
        Ok(song) => Ok(ApiResponse::ok(song)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_song_cover(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<Option<String>>, String> {
    use crate::thumbnail::THUMBNAIL_SMALL_SIZE;

    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match get_or_create_thumbnail(&db, &path, THUMBNAIL_SMALL_SIZE).await {
        Ok(thumbnail) => Ok(ApiResponse::ok(thumbnail)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_song_cover_large(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<Option<String>>, String> {
    use crate::thumbnail::THUMBNAIL_LARGE_SIZE;

    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    // 先尝试缩略图缓存 + DB 封面
    match get_or_create_thumbnail(&db, &path, THUMBNAIL_LARGE_SIZE).await {
        Ok(Some(thumbnail)) => return Ok(ApiResponse::ok(Some(thumbnail))),
        Ok(None) => {} // DB 无封面，进入 fallback
        Err(e) => return Ok(ApiResponse::err(e)),
    }

    // H1 修复：fallback 从音频文件提取或查找同目录封面，再生成缩略图
    // 避免 C1 优化（改用缩略图 API）导致 fallback cover 功能丢失
    let (music_folder, secondary_targets) = match get_music_folder_and_targets(&db).await {
        Ok(v) => v,
        Err(e) => return Ok(ApiResponse::err(e)),
    };
    if let Some(cover_base64) =
        extract_cover_with_fallback(&db, &path, &music_folder, &secondary_targets).await
    {
        let path_owned = path.to_string();
        let thumbnail = tokio::task::spawn_blocking(move || {
            use base64::{engine::general_purpose::STANDARD, Engine};
            match STANDARD.decode(&cover_base64) {
                Ok(decoded) => match crate::thumbnail::create_thumbnail(
                    &decoded,
                    &path_owned,
                    THUMBNAIL_LARGE_SIZE,
                ) {
                    Ok(thumb) => Some(thumb),
                    Err(_) => Some(cover_base64), // 缩略图生成失败则返回原始封面
                },
                Err(_) => Some(cover_base64),
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        return Ok(ApiResponse::ok(thumbnail));
    }

    Ok(ApiResponse::ok(None))
}

/// Fallback 封面获取：从音频文件提取或查找同目录封面文件。
/// 调用前提：DB 中已确认无封面（由 get_or_create_thumbnail 或 get_song_cover 确认）。
async fn extract_cover_with_fallback(
    db: &Database,
    path: &str,
    music_folder: &str,
    secondary_targets: &[std::path::PathBuf],
) -> Option<String> {
    // 1. 从音频文件提取嵌入封面
    let extractor = crate::metadata::MetadataExtractor::new();
    match extractor.extract(path).await {
        Ok(metadata) => {
            if let Some(cover) = metadata.cover {
                if let Err(e) = db.update_song_cover(path, &cover).await {
                    tracing::warn!("Failed to update song cover: {}", e);
                }
                return Some(cover);
            }
        }
        Err(e) => tracing::error!("Failed to extract cover: {}", e),
    }

    // 2. 查找同目录封面文件 (cover.jpg/folder.jpg/artist.jpg 等)
    find_fallback_cover(path, music_folder, secondary_targets).await
}

#[tauri::command]
pub async fn get_song_cover_full(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<Option<String>>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    let (music_folder, secondary_targets) = get_music_folder_and_targets(&db).await?;

    // 1. DB 查封面
    match db.get_song_cover(&path).await {
        Ok(Some(cover)) if !cover.is_empty() => Ok(ApiResponse::ok(Some(cover))),
        Ok(_) => {
            // 2. Fallback: 从音频提取 + 同目录查找
            match extract_cover_with_fallback(&db, &path, &music_folder, &secondary_targets).await {
                Some(cover) => Ok(ApiResponse::ok(Some(cover))),
                None => Ok(ApiResponse::ok(None)),
            }
        }
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

async fn find_fallback_cover(
    song_path: &str,
    music_folder: &str,
    secondary_targets: &[std::path::PathBuf],
) -> Option<String> {
    // 整体放入 spawn_blocking：原实现混用同步 exists() + async fs::read().await，
    // exists() 在 async 线程上阻塞；统一改为同步 fs 并移入 blocking 线程池
    let song_path = song_path.to_string();
    let music_folder = music_folder.to_string();
    let secondary_targets = secondary_targets.to_vec();

    tokio::task::spawn_blocking(move || {
        find_fallback_cover_blocking(&song_path, &music_folder, &secondary_targets)
    })
    .await
    .ok()
    .flatten()
}

/// 在 blocking 线程中执行 fallback 封面查找
fn find_fallback_cover_blocking(
    song_path: &str,
    music_folder: &str,
    secondary_targets: &[std::path::PathBuf],
) -> Option<String> {
    use std::path::Path;

    const ALBUM_COVER_NAMES: &[&str] = &[
        "cover", "Cover", "COVER", "album", "Album", "ALBUM", "folder", "Folder", "FOLDER",
        "front", "Front", "FRONT", "artwork", "Artwork", "ARTWORK",
    ];
    const ARTIST_COVER_NAMES: &[&str] = &[
        "artist", "Artist", "ARTIST", "band", "Band", "BAND", "singer", "Singer", "SINGER",
    ];
    const EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

    fn find_cover_in_dir(dir: &Path, names: &[&str]) -> Option<String> {
        for name in names {
            for ext in EXTENSIONS {
                let cover_path = dir.join(format!("{}.{}", name, ext));
                if let Ok(bytes) = std::fs::read(&cover_path) {
                    return Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
                }
            }
        }
        None
    }

    let song = Path::new(song_path);
    let song_dir = song.parent()?;

    if !crate::path_validator::is_path_in_music_folder(
        song_dir.to_str()?,
        music_folder,
        secondary_targets,
    ) {
        return None;
    }

    if let Some(cover) = find_cover_in_dir(song_dir, ALBUM_COVER_NAMES) {
        return Some(cover);
    }

    if let Some(artist_dir) = song_dir.parent() {
        // 安全检查：artist_dir 必须仍在 music_folder 内，防止越权读取父目录
        if !crate::path_validator::is_path_in_music_folder(
            artist_dir.to_str()?,
            music_folder,
            secondary_targets,
        ) {
            return None;
        }
        if let Some(cover) = find_cover_in_dir(artist_dir, ALBUM_COVER_NAMES) {
            return Some(cover);
        }
        if let Some(cover) = find_cover_in_dir(artist_dir, ARTIST_COVER_NAMES) {
            return Some(cover);
        }
    }

    None
}

#[tauri::command]
pub async fn get_song_covers_batch(
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<ApiResponse<HashMap<String, Option<String>>>, String> {
    use crate::thumbnail::THUMBNAIL_SMALL_SIZE;
    use base64::{engine::general_purpose::STANDARD, Engine};

    if paths.len() > MAX_BATCH_SIZE {
        return Ok(ApiResponse::err(format!(
            "Too many paths (max {})",
            MAX_BATCH_SIZE
        )));
    }

    let db_ref = db.inner().clone();
    let (music_folder, secondary_targets) =
        super::common::get_music_folder_and_targets(&db).await?;

    // Step 1: 批量校验路径 + 检查缩略图缓存（单次 spawn_blocking）
    let music_folder_clone = music_folder.clone();
    let secondary_targets_clone = secondary_targets.clone();
    let paths_for_check = paths.clone();
    let (valid_paths, cached) = tokio::task::spawn_blocking(move || {
        let mut cached: HashMap<String, String> = HashMap::new();
        // 批量校验：music_folder 只 canonicalize 一次，而不是每个路径各一次
        let valid = crate::path_validator::filter_paths_in_music_folder(
            &paths_for_check,
            &music_folder_clone,
            &secondary_targets_clone,
        );
        for path in &valid {
            // 缓存命中即读；未命中返回 None，无需先 exists 再读（那会重复解析路径）
            if let Some(b64) = crate::thumbnail::get_thumbnail_base64(path, THUMBNAIL_SMALL_SIZE) {
                cached.insert(path.clone(), b64);
            }
        }
        (valid, cached)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Step 2: 未命中缓存的路径，单次 IN 查询替代 N 次 get_song_cover（消除 N+1）
    let uncached: Vec<String> = valid_paths
        .iter()
        .filter(|p| !cached.contains_key(*p))
        .cloned()
        .collect();

    let db_covers = if uncached.is_empty() {
        HashMap::new()
    } else {
        db_ref
            .get_song_covers_batch(&uncached)
            .await
            .map_err(|e| e.to_string())?
    };

    // Step 3: 对 DB 有封面的路径，rayon 并行创建缩略图（CPU 密集：解码+Lanczos3+编码+写盘）
    let covers_for_thumbnail: Vec<(String, String)> = db_covers
        .iter()
        .filter_map(|(p, c)| c.as_ref().map(|c| (p.clone(), c.clone())))
        .collect();

    let created: HashMap<String, String> = if covers_for_thumbnail.is_empty() {
        HashMap::new()
    } else {
        tokio::task::spawn_blocking(move || {
            use rayon::prelude::*;
            covers_for_thumbnail
                .into_par_iter()
                .map(|(path, cover)| {
                    let thumbnail = match STANDARD.decode(&cover) {
                        Ok(decoded) => {
                            match crate::thumbnail::create_thumbnail(
                                &decoded,
                                &path,
                                THUMBNAIL_SMALL_SIZE,
                            ) {
                                Ok(t) => t,
                                Err(_) => cover,
                            }
                        }
                        Err(_) => cover,
                    };
                    (path, thumbnail)
                })
                .collect()
        })
        .await
        .map_err(|e| e.to_string())?
    };

    // Step 4: 合并结果：缓存命中 > 新建缩略图 > None
    let mut result: HashMap<String, Option<String>> = HashMap::with_capacity(paths.len());
    for path in &paths {
        if let Some(b64) = cached.get(path) {
            result.insert(path.clone(), Some(b64.clone()));
        } else if let Some(thumbnail) = created.get(path) {
            result.insert(path.clone(), Some(thumbnail.clone()));
        } else {
            result.insert(path.clone(), None);
        }
    }

    Ok(ApiResponse::ok(result))
}

#[tauri::command]
pub async fn get_thumbnail_info() -> Result<ApiResponse<ThumbnailInfo>, String> {
    let (small_count, large_count, size_bytes) = tokio::task::spawn_blocking(|| {
        let (small_count, large_count) = crate::thumbnail::get_thumbnails_count();
        let size_bytes = crate::thumbnail::get_thumbnails_size();
        (small_count, large_count, size_bytes)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(ApiResponse::ok(ThumbnailInfo {
        small_count,
        large_count,
        size_bytes,
    }))
}

#[tauri::command]
pub async fn get_liked_paths(db: State<'_, Database>) -> Result<ApiResponse<Vec<String>>, String> {
    match db.get_liked_paths().await {
        Ok(paths) => Ok(ApiResponse::ok(paths)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_liked_songs(db: State<'_, Database>) -> Result<ApiResponse<Vec<Song>>, String> {
    match db.get_liked_songs().await {
        Ok(songs) => Ok(ApiResponse::ok(songs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn toggle_like(
    db: State<'_, Database>,
    path: String,
    liked: bool,
) -> Result<ApiResponse<()>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.toggle_like(&path, liked).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn clear_liked_songs(db: State<'_, Database>) -> Result<ApiResponse<usize>, String> {
    match db.clear_liked_songs().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn scan_folder(
    db: State<'_, Database>,
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<ApiResponse<crate::scanner::ScanResult>, String> {
    // 安全检查：扫描路径必须在音乐文件夹内（validate 返回 music_folder，复用避免重复查询）
    let music_folder = match validate_path_in_music_folder(&db, &path).await {
        Ok(folder) => folder,
        Err(e) => return Ok(ApiResponse::err(e)),
    };

    // 清理范围：扫描主文件夹时全局清理，扫描子文件夹时仅清理该文件夹范围，
    // 避免扫描子文件夹时误删其他文件夹（如未挂载的外部盘）的歌曲。
    // 用 canonicalize 比较，避免尾斜杠 / symlink 形式差异导致误判。
    let is_primary_folder = tokio::task::spawn_blocking({
        let music_folder = music_folder.clone();
        let path = path.clone();
        move || {
            let canon_music = std::path::Path::new(&music_folder).canonicalize().ok();
            let canon_path = std::path::Path::new(&path).canonicalize().ok();
            canon_music.is_some() && canon_path.is_some() && canon_music == canon_path
        }
    })
    .await
    .unwrap_or(false);

    // 与启动扫描共用同一份「清理 → 扫描 → 落库 → 回收缩略图 → 广播」实现
    let scope = if is_primary_folder {
        crate::scanner::CleanupScope::Global
    } else {
        crate::scanner::CleanupScope::Folder
    };
    match crate::scanner::scan_and_persist(&db, &path, scope, &app_handle).await {
        Ok(result) => Ok(ApiResponse::ok(result)),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn search_songs(
    db: State<'_, Database>,
    query: String,
) -> Result<ApiResponse<Vec<Song>>, String> {
    match db.search_songs(&query).await {
        Ok(songs) => Ok(ApiResponse::ok(songs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn delete_song(db: State<'_, Database>, path: String) -> Result<ApiResponse<()>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.delete_song(&path).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}
