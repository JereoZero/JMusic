use tauri::State;

use crate::database::Database;
use crate::database::Song;
use super::common::{ApiResponse, validate_path_in_music_folder, MAX_BATCH_SIZE};

#[tauri::command]
pub async fn hide_song(
    db: State<'_, Database>,
    path: String,
    is_auto: Option<bool>,
) -> Result<ApiResponse<()>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.hide_song(&path, is_auto.unwrap_or(false)).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn unhide_song(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<()>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.unhide_song(&path).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_hidden_paths(db: State<'_, Database>) -> Result<ApiResponse<Vec<String>>, String> {
    match db.get_hidden_paths().await {
        Ok(paths) => Ok(ApiResponse::ok(paths)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_hidden_songs(db: State<'_, Database>) -> Result<ApiResponse<Vec<Song>>, String> {
    match db.get_hidden_songs().await {
        Ok(songs) => Ok(ApiResponse::ok(songs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn hide_songs_batch(
    db: State<'_, Database>,
    paths: Vec<String>,
    is_auto: Option<bool>,
) -> Result<ApiResponse<usize>, String> {
    if paths.len() > MAX_BATCH_SIZE {
        return Ok(ApiResponse::err(format!(
            "Too many paths (max {})", MAX_BATCH_SIZE
        )));
    }

    let music_folder = db.get_setting("music_folder").await
        .map_err(|e| e.to_string())?
        .ok_or("Music folder not configured".to_string())?;

    // is_path_in_music_folder 内部调用 canonicalize（同步系统调用），用 spawn_blocking 避免阻塞 async 线程
    // 同时获取二级文件夹符号链接目标，用于安全校验
    let valid_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        let secondary_targets = crate::path_validator::get_secondary_targets(&music_folder);
        paths.into_iter()
            .filter(|p| crate::path_validator::is_path_in_music_folder(p, &music_folder, &secondary_targets))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    match db.hide_songs_batch(valid_paths, is_auto.unwrap_or(false)).await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn unhide_songs_batch(
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<ApiResponse<usize>, String> {
    if paths.len() > MAX_BATCH_SIZE {
        return Ok(ApiResponse::err(format!(
            "Too many paths (max {})", MAX_BATCH_SIZE
        )));
    }

    let music_folder = db.get_setting("music_folder").await
        .map_err(|e| e.to_string())?
        .ok_or("Music folder not configured".to_string())?;

    // is_path_in_music_folder 内部调用 canonicalize（同步系统调用），用 spawn_blocking 避免阻塞 async 线程
    // 同时获取二级文件夹符号链接目标，用于安全校验
    let valid_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        let secondary_targets = crate::path_validator::get_secondary_targets(&music_folder);
        paths.into_iter()
            .filter(|p| crate::path_validator::is_path_in_music_folder(p, &music_folder, &secondary_targets))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    match db.unhide_songs_batch(valid_paths).await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn clear_hidden_songs(db: State<'_, Database>) -> Result<ApiResponse<usize>, String> {
    match db.clear_hidden_songs().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_hidden_count(db: State<'_, Database>) -> Result<ApiResponse<i64>, String> {
    match db.get_hidden_count().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn is_song_hidden(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<bool>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.is_song_hidden(&path).await {
        Ok(hidden) => Ok(ApiResponse::ok(hidden)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}
