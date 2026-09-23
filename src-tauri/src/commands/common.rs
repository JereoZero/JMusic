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
///
/// 取值必须与 [`crate::paths::resolve_music_folder`] 对「已配置」的判断一致：
/// 都返回 DB 原值、都只把「空/缺失」当作未配置。
/// 区别在于本函数**不创建默认目录、不写回 DB**（校验侧不该有副作用）。
pub async fn get_music_folder_and_targets(
    db: &crate::database::Database,
) -> Result<(String, Vec<PathBuf>), String> {
    let music_folder = match db
        .get_setting("music_folder")
        .await
        .map_err(|e| e.to_string())?
    {
        // 空串必须与缺失同样处理：`set_setting` 不做值校验，一旦写入空串，
        // 下面的 canonicalize("") 必然失败，会让所有带路径的命令（播放/封面/歌词/
        // 喜欢/隐藏/删除）全部返回 "Access denied"，且没有自愈路径。
        Some(folder) if !folder.trim().is_empty() => folder,
        _ => return Err("Music folder not configured".to_string()),
    };

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

    // 缩略图缓存检查（同步 fs 操作）。
    // 直接调 get_thumbnail_base64：文件不存在时它返回 None，无需先 exists 再读——
    // 那会把路径解析（stat + md5 + 建缓存目录）重复做一遍。
    let cached = tokio::task::spawn_blocking({
        let path_owned = path_owned.clone();
        move || crate::thumbnail::get_thumbnail_base64(&path_owned, size)
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_db() -> (crate::database::Database, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().expect("failed to create temp dir");
        let db = crate::database::Database::new_test(&tmp.path().join("test.db"))
            .await
            .expect("failed to init test db");
        (db, tmp)
    }

    #[tokio::test]
    async fn get_music_folder_and_targets_rejects_missing_setting() {
        let (db, _tmp) = setup_db().await;
        assert_eq!(
            get_music_folder_and_targets(&db).await.unwrap_err(),
            "Music folder not configured"
        );
    }

    #[tokio::test]
    async fn get_music_folder_and_targets_rejects_empty_setting() {
        // 回归：`set_setting` 不做值校验，写入空串后旧实现只判 `None`，
        // 会把 "" 当成合法目录 → `canonicalize("")` 失败 → 播放/封面/歌词/喜欢/
        // 隐藏/删除等所有带路径的命令都返回 "Access denied"，且没有自愈路径。
        let (db, _tmp) = setup_db().await;
        db.set_setting("music_folder", "").await.unwrap();
        assert_eq!(
            get_music_folder_and_targets(&db).await.unwrap_err(),
            "Music folder not configured"
        );

        // 纯空白同样视为未配置
        db.set_setting("music_folder", "   ").await.unwrap();
        assert_eq!(
            get_music_folder_and_targets(&db).await.unwrap_err(),
            "Music folder not configured"
        );
    }

    #[tokio::test]
    async fn get_music_folder_and_targets_returns_configured_folder_verbatim() {
        // 已配置的目录必须原样返回，**不判断路径是否存在**：
        // 外接盘未挂载时路径不存在，但也不能因此被当成「未配置」——
        // 否则会与 paths::resolve_music_folder 的取值不一致，出现
        // 「界面显示的目录」与「校验用的目录」不同。
        let (db, _tmp) = setup_db().await;
        let unmounted = "/Volumes/not-mounted/music";
        db.set_setting("music_folder", unmounted).await.unwrap();

        let (folder, targets) = get_music_folder_and_targets(&db).await.unwrap();
        assert_eq!(folder, unmounted);
        assert!(targets.is_empty(), "不可达目录不应产生二级文件夹白名单");
    }
}
