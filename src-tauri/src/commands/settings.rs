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

    match db.set_setting(&key, &value).await {
        Ok(_) => Ok(ApiResponse::ok(())),
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
