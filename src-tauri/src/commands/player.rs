use tauri::State;

use super::common::{get_music_folder_and_targets, ApiResponse};
use crate::database::Database;
use crate::metadata::MetadataExtractor;
use crate::path_validator::{resolve_path_in_music_folder, validate_audio_extension};
use crate::player::AudioPlayer;
use rayon::prelude::*;

#[tauri::command]
pub async fn play_song(
    player: State<'_, AudioPlayer>,
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<()>, String> {
    // 验证文件扩展名
    if !validate_audio_extension(&path) {
        return Ok(ApiResponse::err("Invalid audio file format"));
    }

    // 验证路径是否在音乐文件夹内，并取回 canonical 路径。
    // 后续用 canonical 路径打开文件，消除「校验 → 打开」之间符号链接被替换的
    // TOCTOU 窗口（原实现校验后仍用原始 path 打开，两者可能指向不同实体）。
    let (music_folder, secondary_targets) = match get_music_folder_and_targets(&db).await {
        Ok(v) => v,
        Err(e) => return Ok(ApiResponse::err(e)),
    };

    let path_for_check = path.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        resolve_path_in_music_folder(&path_for_check, &music_folder, &secondary_targets)
    })
    .await
    .map_err(|e| e.to_string())?;

    let safe_path = match resolved {
        Some(p) => p,
        None => {
            // 区分「文件不存在」与「越权」以保持原有错误语义
            let path_for_exists = path.clone();
            let exists = tokio::task::spawn_blocking(move || {
                std::path::Path::new(&path_for_exists).exists()
            })
            .await
            .map_err(|e| e.to_string())?;
            return Ok(ApiResponse::err(if exists {
                "Access denied: path outside music folder"
            } else {
                "File not found"
            }));
        }
    };

    // H3 优化：删除 probe_audio_file 预探测，直接调用 player.play()。
    // play() 内部 DsdDecoder::new 已含 symphonia probe，失败返回 Err，
    // 省去一次文件 I/O + format probe，切歌延迟降 30-50%。
    // 注意：用 canonical 路径打开音频；DB 仍用原始 path（二级文件夹歌曲在 DB 中
    // 记录的是符号链接路径，canonical 后无法匹配）。
    match player.play(&safe_path.to_string_lossy()).await {
        Ok(_) => {
            // 播放次数在 play 成功后递增（play 成功即证明可解码）
            // 语义为"用户尝试播放的次数"，而非"完整播放次数"
            if let Err(e) = db.increment_play_count(&path).await {
                tracing::warn!("Failed to increment play count: {}", e);
            }
            Ok(ApiResponse::ok(()))
        }
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn pause_song(player: State<'_, AudioPlayer>) -> Result<ApiResponse<()>, String> {
    match player.pause().await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn resume_song(player: State<'_, AudioPlayer>) -> Result<ApiResponse<()>, String> {
    match player.resume().await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn stop_song(player: State<'_, AudioPlayer>) -> Result<ApiResponse<()>, String> {
    match player.stop().await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn seek_song(
    player: State<'_, AudioPlayer>,
    time: f64,
) -> Result<ApiResponse<()>, String> {
    // Duration::from_secs_f64 在 NaN/Infinity/负数时会 panic，必须在入口拦截
    if !time.is_finite() || time < 0.0 {
        return Ok(ApiResponse::err("Invalid seek time"));
    }
    // 校验上界：不允许 seek 超过当前歌曲 duration
    // 用轻量 get_duration() 替代 get_state()，避免 handle lock + kira 同步 + clone
    if let Some(duration) = player.get_duration().await {
        if duration > 0.0 && time > duration {
            return Ok(ApiResponse::err("Seek time exceeds duration"));
        }
    }
    match player.seek(time).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn set_volume(
    player: State<'_, AudioPlayer>,
    volume: f32,
) -> Result<ApiResponse<()>, String> {
    // 入口校验音量范围
    if !(0.0..=1.0).contains(&volume) {
        return Ok(ApiResponse::err("Volume must be between 0.0 and 1.0"));
    }
    match player.set_volume(volume).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

#[tauri::command]
pub async fn get_player_state(
    player: State<'_, AudioPlayer>,
) -> Result<ApiResponse<crate::player::PlayerState>, String> {
    let state = player.get_state().await;
    Ok(ApiResponse::ok(state))
}

#[tauri::command]
pub async fn get_metadata(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<crate::metadata::Metadata>, String> {
    if !validate_audio_extension(&path) {
        return Ok(ApiResponse::err("Invalid audio file format"));
    }

    let (music_folder, secondary_targets) = match get_music_folder_and_targets(&db).await {
        Ok(v) => v,
        Err(e) => return Ok(ApiResponse::err(e)),
    };

    // 用 canonical 路径读取，消除「校验 → 读取」之间的 TOCTOU 窗口
    let path_for_check = path.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        resolve_path_in_music_folder(&path_for_check, &music_folder, &secondary_targets)
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(safe_path) = resolved else {
        return Ok(ApiResponse::err("Access denied: path outside music folder"));
    };

    let extractor = MetadataExtractor::new();

    match extractor.extract(&safe_path.to_string_lossy()).await {
        Ok(metadata) => Ok(ApiResponse::ok(metadata)),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

/// 单次批量元数据提取的路径上限，防止前端传入超大数组导致 rayon 并行解码耗尽资源
const METADATA_BATCH_LIMIT: usize = 500;

#[tauri::command]
pub async fn get_metadata_batch(
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<ApiResponse<Vec<BatchMetadata>>, String> {
    if paths.len() > METADATA_BATCH_LIMIT {
        return Ok(ApiResponse::err(format!(
            "单次最多处理 {} 个文件，当前收到 {} 个",
            METADATA_BATCH_LIMIT,
            paths.len()
        )));
    }

    let (music_folder, secondary_targets) = match get_music_folder_and_targets(&db).await {
        Ok(v) => v,
        Err(e) => return Ok(ApiResponse::err(e)),
    };

    let results = tokio::task::spawn_blocking(move || {
        paths
            .into_par_iter()
            .filter(|path| validate_audio_extension(path))
            .filter_map(|path| {
                // 用 canonical 路径读取（消除 TOCTOU）；响应中仍返回**原始 path**，
                // 前端按 path 匹配结果，且二级文件夹歌曲在 DB 中记录的是符号链接路径
                let resolved =
                    resolve_path_in_music_folder(&path, &music_folder, &secondary_targets)?;
                MetadataExtractor::extract_blocking(&resolved.to_string_lossy())
                    .ok()
                    .map(|metadata| BatchMetadata { path, metadata })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(ApiResponse::ok(results))
}

#[derive(serde::Serialize)]
pub struct BatchMetadata {
    pub path: String,
    pub metadata: crate::metadata::Metadata,
}
