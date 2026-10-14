use tauri::State;

use super::common::{validate_path_in_music_folder, ApiResponse, MAX_BATCH_SIZE};
use crate::database::Database;

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
pub async fn unhide_song(db: State<'_, Database>, path: String) -> Result<ApiResponse<()>, String> {
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
pub async fn hide_songs_batch(
    db: State<'_, Database>,
    paths: Vec<String>,
    is_auto: Option<bool>,
) -> Result<ApiResponse<usize>, String> {
    if paths.len() > MAX_BATCH_SIZE {
        return Ok(ApiResponse::err(format!(
            "Too many paths (max {})",
            MAX_BATCH_SIZE
        )));
    }

    // 走统一入口：自行读 DB 只判了 `None`，漏掉「空串/纯空白」——用空串配置时
    // canonicalize("") 失败，表现成「0 个路径通过校验」而非「未配置」，语义误导。
    let (music_folder, secondary_targets) =
        super::common::get_music_folder_and_targets(&db).await?;

    // filter_paths_in_music_folder 内部调用 canonicalize（同步系统调用），用 spawn_blocking 避免阻塞 async 线程
    // 二级文件夹白名单已由上面的统一入口取回（带进程内缓存）
    let valid_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        // 用批量变体：music_folder 只 canonicalize 一次，而不是每个路径各一次
        crate::path_validator::filter_paths_in_music_folder(
            &paths,
            &music_folder,
            &secondary_targets,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    match db
        .hide_songs_batch(valid_paths, is_auto.unwrap_or(false))
        .await
    {
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
            "Too many paths (max {})",
            MAX_BATCH_SIZE
        )));
    }

    // 走统一入口（同 hide_songs_batch：空串配置应报「未配置」而非「0 个通过」）
    let (music_folder, secondary_targets) =
        super::common::get_music_folder_and_targets(&db).await?;

    // filter_paths_in_music_folder 内部调用 canonicalize（同步系统调用），用 spawn_blocking 避免阻塞 async 线程
    let valid_paths: Vec<String> = tokio::task::spawn_blocking(move || {
        // 用批量变体：music_folder 只 canonicalize 一次，而不是每个路径各一次
        crate::path_validator::filter_paths_in_music_folder(
            &paths,
            &music_folder,
            &secondary_targets,
        )
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
