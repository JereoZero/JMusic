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
/// - DB 中有非空路径 → **原样返回**（不判断路径是否存在，见下方说明）
/// - 否则（缺失/为空）→ 回退到默认目录 [`get_default_music_folder_path`]（自动创建）并写回 DB
///
/// # 为什么「路径不存在」不回退
///
/// 外接盘/网络盘未挂载、或目录被临时改名时，`Path::exists()` 同样返回 `false`。
/// 若此时回退到默认目录并写回 DB，会把用户配置的音乐文件夹**永久覆盖**成
/// `app_data/jmusic-file` 这个空目录 —— 曲库看起来「凭空消失」，原配置不可恢复。
/// 因此这里只把「设置为空/缺失」当作未配置；路径暂时不可达时原样返回，
/// 由调用方自行 `exists()` 判断并决定是否跳过（如启动扫描）。
///
/// 注意：校验路径的 [`crate::commands::common::get_music_folder_and_targets`]
/// 必须与本函数对「已配置」的取值保持一致（都返回 DB 原值），否则会出现
/// 「界面显示的目录」与「校验用的目录」不一致。
pub async fn resolve_music_folder(
    app: &AppHandle,
    db: &crate::database::Database,
) -> Result<PathBuf, String> {
    match db.get_setting("music_folder").await {
        Ok(Some(folder)) if !folder.trim().is_empty() => return Ok(PathBuf::from(folder)),
        Ok(_) => {}
        Err(e) => return Err(format!("读取 music_folder 设置失败: {}", e)),
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
