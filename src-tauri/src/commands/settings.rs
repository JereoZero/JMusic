use tauri::State;

use super::common::{
    get_music_folder_and_targets, validate_path_in_music_folder, ApiResponse, ALLOWED_SETTING_KEYS,
};
use crate::database::Database;
use crate::path_validator;

#[tauri::command]
pub async fn get_setting(
    db: State<'_, Database>,
    key: String,
) -> Result<ApiResponse<Option<String>>, String> {
    if !ALLOWED_SETTING_KEYS.contains(&key.as_str()) {
        return Ok(ApiResponse::err(format!(
            "Setting key '{}' is not allowed",
            key
        )));
    }
    match db.get_setting(&key).await {
        Ok(value) => Ok(ApiResponse::ok(value)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn set_setting(
    db: State<'_, Database>,
    key: String,
    value: String,
) -> Result<ApiResponse<()>, String> {
    if !ALLOWED_SETTING_KEYS.contains(&key.as_str()) {
        return Ok(ApiResponse::err(format!(
            "Setting key '{}' is not allowed",
            key
        )));
    }

    // 更换音乐文件夹时，旧目录下的歌曲记录会因路径不在新目录内而**全部校验失败**
    // （列表里可见，但播放/收藏/取歌词/删除都返回 Access denied）。
    // 旧文件通常仍在磁盘上，所以 cleanup_nonexistent_songs 不会清理它们 ——
    // 必须在这里显式按「是否还在曲库根下」清理，否则界面会一直留着一批点不动的歌。
    let previous = if key == "music_folder" {
        db.get_setting("music_folder").await.ok().flatten()
    } else {
        None
    };

    match db.set_setting(&key, &value).await {
        Ok(_) => {
            if let Some(previous) = previous {
                // 只在值真正变化时清理（尾斜杠等无意义差异用字符串比较规避）
                let changed = previous.trim_end_matches('/') != value.trim_end_matches('/');
                // ⚠️ 数据安全护栏：新目录必须**实际存在且是目录**才清理。
                // 若传入的是不存在的路径（拼写错误、外接盘未挂载、直接 invoke 乱传），
                // 所有歌曲都会被判定为「不在曲库根下」→ 整库记录连同喜欢/播放历史
                // 被级联删除且不可恢复。目录不可用时一律跳过，等目录可用后
                // 重新设置（或下次扫描）再清理。
                let new_folder_usable =
                    std::path::Path::new(&value).is_dir() && !value.trim().is_empty();
                if changed && !previous.trim().is_empty() && new_folder_usable {
                    match db.cleanup_songs_outside_folder(&value).await {
                        Ok(removed) => {
                            if removed > 0 {
                                tracing::info!(
                                    "Removed {} song(s) outside the new music folder",
                                    removed
                                );
                            }
                        }
                        Err(e) => {
                            // 清理失败不回滚设置：目录已经换好，残留记录下次扫描还能再清
                            tracing::error!("Failed to cleanup songs outside new folder: {}", e);
                        }
                    }
                } else if changed && !new_folder_usable {
                    tracing::warn!(
                        "Skipped cleanup for new music folder '{}': not an existing directory",
                        value
                    );
                }
            }
            Ok(ApiResponse::ok(()))
        }
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_all_settings(
    db: State<'_, Database>,
) -> Result<ApiResponse<Vec<(String, String)>>, String> {
    match db.get_all_settings().await {
        Ok(settings) => Ok(ApiResponse::ok(settings)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn check_file_exists(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<bool>, String> {
    let (music_folder, secondary_targets) = match get_music_folder_and_targets(&db).await {
        Ok(v) => v,
        Err(e) => return Ok(ApiResponse::err(e)),
    };

    let music_folder_for_check = music_folder.clone();
    let secondary_targets_for_check = secondary_targets.clone();
    let path_for_check = path.clone();
    let is_allowed = tokio::task::spawn_blocking(move || {
        path_validator::is_path_in_music_folder(
            &path_for_check,
            &music_folder_for_check,
            &secondary_targets_for_check,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    if !is_allowed {
        return Ok(ApiResponse::err("Access denied: path outside music folder"));
    }

    let path_clone = path.clone();
    let exists = tokio::task::spawn_blocking(move || std::path::Path::new(&path_clone).exists())
        .await
        .map_err(|e| e.to_string())?;
    Ok(ApiResponse::ok(exists))
}

#[tauri::command]
pub async fn is_song_liked(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<bool>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.is_song_liked(&path).await {
        Ok(liked) => Ok(ApiResponse::ok(liked)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}
