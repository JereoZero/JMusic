use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(error: impl ToString) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.to_string()),
        }
    }
}

#[derive(Serialize)]
pub struct ThumbnailInfo {
    pub small_count: usize,
    pub large_count: usize,
    pub size_bytes: u64,
}

/// 统一获取 music_folder 和二级文件夹符号链接目标，用于路径安全校验
pub async fn get_music_folder_and_targets(
    db: &crate::database::Database,
) -> Result<(String, Vec<PathBuf>), String> {
    let music_folder = db
        .get_setting("music_folder")
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Music folder not configured".to_string())?;

    let music_folder_clone = music_folder.clone();
    let secondary_targets = tokio::task::spawn_blocking(move || {
        crate::path_validator::get_secondary_targets(&music_folder_clone)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok((music_folder, secondary_targets))
}

pub async fn validate_path_in_music_folder(
    db: &crate::database::Database,
    path: &str,
) -> Result<String, String> {
    let (music_folder, secondary_targets) = get_music_folder_and_targets(db).await?;

    if !crate::path_validator::is_path_in_music_folder(path, &music_folder, &secondary_targets) {
        return Err("Access denied: path outside music folder".to_string());
    }

    Ok(music_folder)
}

pub const MAX_BATCH_SIZE: usize = 100;

pub const ALLOWED_SETTING_KEYS: &[&str] = &[
    "music_folder",
    "secondary_folders",
    "theme",
    "language",
    "volume",
    "last_scan",
];

pub async fn get_or_create_thumbnail(
    db: &crate::database::Database,
    path: &str,
    size: u32,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let path_owned = path.to_string();

    // 缩略图缓存检查（同步 fs 操作）
    let cached = tokio::task::spawn_blocking({
        let path_owned = path_owned.clone();
        move || {
            if crate::thumbnail::thumbnail_exists(&path_owned, size) {
                crate::thumbnail::get_thumbnail_base64(&path_owned, size)
            } else {
                None
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    if cached.is_some() {
        return Ok(cached);
    }

    // 从 DB 获取封面（async）
    match db.get_song_cover(path).await {
        Ok(Some(cover)) => {
            // 创建缩略图（CPU 密集：解码 + Lanczos3 缩放 + JPEG 编码 + 同步文件写入）
            let thumbnail = tokio::task::spawn_blocking(move || match STANDARD.decode(&cover) {
                Ok(decoded) => {
                    match crate::thumbnail::create_thumbnail(&decoded, &path_owned, size) {
                        Ok(thumbnail) => Some(thumbnail),
                        Err(_) => Some(cover),
                    }
                }
                Err(_) => Some(cover),
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(thumbnail)
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
