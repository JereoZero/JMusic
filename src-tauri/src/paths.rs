use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 获取应用数据目录
///
/// 默认使用 Tauri 的 `app_data_dir()`（macOS: ~/Library/Application Support/<identifier>/）。
///
/// Dev 环境下可通过 `JLOCAL_DATA_DIR` 环境变量覆盖（如 Trae sandbox 限制 ~/Library 访问时）：
/// ```sh
/// JLOCAL_DATA_DIR=./jlocal-dev-data npm run tauri dev
/// ```
pub fn get_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("JLOCAL_DATA_DIR") {
        let path = PathBuf::from(&dir);
        if !path.exists() {
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("无法创建数据目录 {}: {}", path.display(), e))?;
        }
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))
}

pub fn get_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = get_app_data_dir(app)?;
    Ok(data_dir.join("data").join("music.db"))
}

/// 默认音乐文件夹路径（`app_data/jmusic-file`）
///
/// 仅作为 [`resolve_music_folder`] 的兜底默认值；运行时唯一真源是 DB 设置 `music_folder`。
pub fn get_default_music_folder_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = get_app_data_dir(app)?;
    Ok(data_dir.join("jmusic-file"))
}

pub fn ensure_database_dir_exists(app: &AppHandle) -> Result<PathBuf, String> {
    let db_path = get_database_path(app)?;
    if let Some(parent) = db_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("无法创建数据库目录: {}", e))?;
        }
    }
    Ok(db_path)
}

/// 解析音乐文件夹（唯一真源：DB 设置 `music_folder`）
///
/// - DB 中有非空且实际存在的路径 → 直接使用
/// - 否则回退到默认目录 [`get_default_music_folder_path`]（自动创建）并写回 DB
///
/// 所有需要「音乐文件夹」的后端逻辑都必须走此函数，
/// 否则会出现「写入用硬编码目录、校验用 DB 目录」的不一致，
/// 导致二级文件夹符号链接建在错误目录、路径白名单失效。
pub async fn resolve_music_folder(
    app: &AppHandle,
    db: &crate::database::Database,
) -> Result<PathBuf, String> {
    if let Ok(Some(folder)) = db.get_setting("music_folder").await {
        if !folder.is_empty() && std::path::Path::new(&folder).exists() {
            return Ok(PathBuf::from(folder));
        }
    }

    let default_folder = get_default_music_folder_path(app)?;
    if !default_folder.exists() {
        std::fs::create_dir_all(&default_folder)
            .map_err(|e| format!("无法创建音乐文件夹: {}", e))?;
    }

    let folder_str = default_folder.to_string_lossy().to_string();
    if let Err(e) = db.set_setting("music_folder", &folder_str).await {
        tracing::warn!("Failed to persist music_folder setting: {}", e);
    }

    Ok(default_folder)
}
