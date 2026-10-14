use tauri::State;

use super::common::{validate_path_in_music_folder, ApiResponse};
use crate::app_log;
use crate::database::Database;
use crate::database::PlayHistory;

/// 合法日志级别白名单（与设置页筛选项一致）
fn is_valid_level(level: &str) -> bool {
    const VALID_LEVELS: &[&str] = &["INFO", "WARN", "ERROR", "DEBUG", "TRACE"];
    VALID_LEVELS.contains(&level)
}

// ==================== 日志（读取内存环形缓冲，见 crate::app_log） ====================

#[tauri::command]
pub fn get_logs(
    level: Option<String>,
    limit: Option<i64>,
) -> Result<ApiResponse<Vec<app_log::AppLog>>, String> {
    if let Some(ref l) = level {
        if !is_valid_level(l) {
            return Ok(ApiResponse::err(format!("Invalid log level: {}", l)));
        }
    }
    Ok(ApiResponse::ok(app_log::get_logs(level.as_deref(), limit)))
}

#[tauri::command]
pub fn clear_logs() -> Result<ApiResponse<usize>, String> {
    Ok(ApiResponse::ok(app_log::clear()))
}

#[tauri::command]
pub fn get_logs_as_text() -> Result<ApiResponse<String>, String> {
    use std::fmt::Write;

    let logs = app_log::get_logs(None, Some(100));

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
            "[{}] [{}] [{}] {}",
            log.created_at.format("%Y-%m-%d %H:%M:%S"),
            log.level,
            log.target.as_deref().unwrap_or("-"),
            log.message
        );
    }

    Ok(ApiResponse::ok(output))
}

// ==================== 播放历史 ====================

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
