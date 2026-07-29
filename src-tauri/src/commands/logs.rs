use tauri::State;

use super::common::{validate_path_in_music_folder, ApiResponse};
use crate::database::AppLog;
use crate::database::Database;
use crate::database::PlayHistory;

/// 合法日志级别白名单
fn is_valid_level(level: &str) -> bool {
    const VALID_LEVELS: &[&str] = &["INFO", "WARN", "ERROR", "DEBUG", "TRACE"];
    VALID_LEVELS.contains(&level)
}

#[tauri::command]
pub async fn add_log(
    db: State<'_, Database>,
    level: String,
    message: String,
    target: Option<String>,
) -> Result<ApiResponse<()>, String> {
    if !is_valid_level(&level) {
        return Ok(ApiResponse::err(format!("Invalid log level: {}", level)));
    }
    match db.add_log(&level, &message, target.as_deref()).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_logs(
    db: State<'_, Database>,
    level: Option<String>,
    limit: Option<i64>,
) -> Result<ApiResponse<Vec<AppLog>>, String> {
    match db.get_logs(level.as_deref(), limit).await {
        Ok(logs) => Ok(ApiResponse::ok(logs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_error_logs(db: State<'_, Database>) -> Result<ApiResponse<Vec<AppLog>>, String> {
    match db.get_error_logs().await {
        Ok(logs) => Ok(ApiResponse::ok(logs)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn clear_logs(db: State<'_, Database>) -> Result<ApiResponse<usize>, String> {
    match db.clear_logs().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_log_count(db: State<'_, Database>) -> Result<ApiResponse<i64>, String> {
    match db.get_log_count().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_logs_as_text(db: State<'_, Database>) -> Result<ApiResponse<String>, String> {
    use std::fmt::Write;

    let logs = match db.get_logs(None, Some(100)).await {
        Ok(logs) => logs,
        Err(e) => return Ok(ApiResponse::err(e.to_string())),
    };

    let mut output = String::new();
    let _ = writeln!(&mut output, "=== JlocalMusic 日志 ===");
    let _ = writeln!(&mut output, "应用版本: v{}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(&mut output, "平台: {}", std::env::consts::OS);
    let _ = writeln!(&mut output, "架构: {}", std::env::consts::ARCH);
    let _ = writeln!(&mut output, "===================");
    let _ = writeln!(&mut output);

    for log in logs {
        let _ = writeln!(
            &mut output,
            "[{}] [{}] {}",
            log.created_at.format("%Y-%m-%d %H:%M:%S"),
            log.level,
            log.message
        );
    }

    Ok(ApiResponse::ok(output))
}

#[tauri::command]
pub async fn add_play_history(
    db: State<'_, Database>,
    path: String,
    duration: i64,
    completed: bool,
) -> Result<ApiResponse<()>, String> {
    if duration < 0 {
        return Ok(ApiResponse::err("Duration must be non-negative"));
    }
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.add_play_history(&path, duration, completed).await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_play_history(
    db: State<'_, Database>,
    limit: Option<i64>,
) -> Result<ApiResponse<Vec<PlayHistory>>, String> {
    match db.get_play_history(limit).await {
        Ok(history) => Ok(ApiResponse::ok(history)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn clear_play_history(db: State<'_, Database>) -> Result<ApiResponse<()>, String> {
    match db.clear_play_history().await {
        Ok(_) => Ok(ApiResponse::ok(())),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_play_counts(
    db: State<'_, Database>,
) -> Result<ApiResponse<Vec<(String, i64)>>, String> {
    match db.get_play_counts().await {
        Ok(counts) => Ok(ApiResponse::ok(counts)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn get_song_play_count(
    db: State<'_, Database>,
    path: String,
) -> Result<ApiResponse<i64>, String> {
    if let Err(e) = validate_path_in_music_folder(&db, &path).await {
        return Ok(ApiResponse::err(e));
    }

    match db.get_song_play_count(&path).await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}

#[tauri::command]
pub async fn cleanup_nonexistent_songs(
    db: State<'_, Database>,
) -> Result<ApiResponse<usize>, String> {
    match db.cleanup_nonexistent_songs().await {
        Ok(count) => Ok(ApiResponse::ok(count)),
        Err(e) => Ok(ApiResponse::err(e)),
    }
}
