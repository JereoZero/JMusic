use tauri::AppHandle;
use tauri::Manager;
use super::common::ApiResponse;

#[tauri::command]
pub async fn select_folder(app: AppHandle) -> Result<ApiResponse<Option<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let folder_path: Option<tauri_plugin_dialog::FilePath> = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择音乐文件夹")
            .blocking_pick_folder()
    }).await.map_err(|e| e.to_string())?;
    
    let result = folder_path.map(|p| match p {
        tauri_plugin_dialog::FilePath::Path(path_buf) => path_buf.to_string_lossy().to_string(),
        tauri_plugin_dialog::FilePath::Url(url) => url
            .to_file_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| url.to_string()),
    });
    
    Ok(ApiResponse::ok(result))
}

#[tauri::command]
pub async fn get_lyrics(
    app: AppHandle,
    path: String,
) -> Result<ApiResponse<Option<crate::lyrics::LyricSource>>, String> {
    if !crate::path_validator::validate_audio_extension(&path) {
        return Ok(ApiResponse::err("Invalid audio file format"));
    }

    let db = app.state::<crate::database::Database>();
    let music_folder = match db.get_setting("music_folder").await {
        Ok(Some(folder)) => folder,
        Ok(None) => return Ok(ApiResponse::err("Music folder not configured")),
        Err(e) => return Ok(ApiResponse::err(e.to_string())),
    };

    // 获取二级文件夹符号链接目标用于安全校验（同步 fs 操作）
    let music_folder_clone = music_folder.clone();
    let secondary_targets = tokio::task::spawn_blocking(move || {
        crate::path_validator::get_secondary_targets(&music_folder_clone)
    })
    .await
    .map_err(|e| e.to_string())?;

    if !crate::path_validator::is_path_in_music_folder(&path, &music_folder, &secondary_targets) {
        return Ok(ApiResponse::err("Access denied: path outside music folder"));
    }
    
    let audio_path = std::path::PathBuf::from(path);
    let lyrics = tokio::task::spawn_blocking(move || crate::lyrics::get_lyrics(&audio_path))
        .await
        .map_err(|e| e.to_string())?;

    match lyrics {
        Some(lyrics) => Ok(ApiResponse::ok(Some(lyrics))),
        None => Ok(ApiResponse::ok(None)),
    }
}

#[tauri::command]
pub async fn get_primary_music_folder(app: AppHandle) -> Result<ApiResponse<String>, String> {
    let db = app.state::<crate::database::Database>();
    
    if let Ok(Some(custom_folder)) = db.get_setting("music_folder").await {
        if !custom_folder.is_empty() && std::path::Path::new(&custom_folder).exists() {
            return Ok(ApiResponse::ok(custom_folder));
        }
    }
    
    let music_folder = crate::paths::ensure_music_folder_exists(&app)?;
    let folder_str = music_folder.to_string_lossy().to_string();

    if let Err(e) = db.set_setting("music_folder", &folder_str).await {
        tracing::warn!("Failed to persist music_folder setting: {}", e);
    }

    Ok(ApiResponse::ok(folder_str))
}

#[tauri::command]
pub async fn add_secondary_folder(
    app: AppHandle,
    target_path: String,
) -> Result<ApiResponse<String>, String> {
    let primary_folder = crate::paths::ensure_music_folder_exists(&app)?;

    let target_path_buf = std::path::PathBuf::from(&target_path);

    // 在 spawn_blocking 中执行文件存在性检查、canonicalize 和符号链接创建
    let link_path = tokio::task::spawn_blocking(move || {
        if !target_path_buf.exists() {
            return Err::<_, String>("目标路径不存在".to_string());
        }

        let absolute_target = target_path_buf
            .canonicalize()
            .map_err(|e| format!("无法解析目标路径: {}", e))?;

        // 安全检查：禁止链接到系统敏感目录
        if is_sensitive_path(&absolute_target) {
            return Err("禁止链接到系统敏感目录".to_string());
        }

        let target_name = absolute_target
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "无法获取目标文件夹名称".to_string())?;

        let mut link_name = target_name.to_string();
        let mut counter = 1;
        loop {
            let link_path = primary_folder.join(&link_name);
            if !link_path.exists() {
                break;
            }
            link_name = format!("{}_{}", target_name, counter);
            counter += 1;
        }

        let link_path = primary_folder.join(&link_name);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&absolute_target, &link_path)
                .map_err(|e| format!("创建符号链接失败: {}", e))?;
        }

        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(&["/C", "mklink", "/J", &link_path.to_string_lossy(), &absolute_target.to_string_lossy()])
                .output()
                .map_err(|e| format!("创建 junction 失败: {}", e))?;
        }

        Ok(link_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(ApiResponse::ok(link_path))
}

#[tauri::command]
pub async fn remove_secondary_folder(
    app: AppHandle,
    link_name: String,
) -> Result<ApiResponse<()>, String> {
    // 安全检查：link_name 必须是单一路径组件，防止路径遍历
    if !crate::path_validator::is_safe_link_name(&link_name) {
        return Ok(ApiResponse::err("无效的链接名称"));
    }

    let primary_folder = crate::paths::get_music_folder_path(&app)?;
    let link_path = primary_folder.join(&link_name);

    // 二次校验：拼接后的路径必须仍在 primary_folder 内
    let link_canon = match link_path.canonicalize() {
        Ok(c) => c,
        Err(_) => return Ok(ApiResponse::err("指定的路径不存在")),
    };
    let primary_canon = primary_folder.canonicalize().map_err(|e| e.to_string())?;
    if !link_canon.starts_with(&primary_canon) {
        return Ok(ApiResponse::err("指定的路径不在音乐文件夹内"));
    }

    if !link_path.exists() {
        return Ok(ApiResponse::err("指定的路径不存在"));
    }

    // 在 spawn_blocking 中执行同步文件删除
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::symlink_metadata(&link_path)
            .map_err(|e| format!("获取链接信息失败: {}", e))?;

        let file_type = metadata.file_type();

        #[cfg(unix)]
        {
            if !file_type.is_symlink() {
                return Err("指定的路径不是符号链接".to_string());
            }
            std::fs::remove_file(&link_path)
                .map_err(|e| format!("删除符号链接失败: {}", e))?;
        }

        #[cfg(windows)]
        {
            if file_type.is_dir() {
                std::fs::remove_dir(&link_path)
                    .map_err(|e| format!("删除 junction 失败: {}", e))?;
            } else if file_type.is_symlink() {
                std::fs::remove_file(&link_path)
                    .map_err(|e| format!("删除符号链接失败: {}", e))?;
            } else {
                return Err("指定的路径不是符号链接或 junction".to_string());
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(ApiResponse::ok(()))
}

#[tauri::command]
pub async fn get_secondary_folders(app: AppHandle) -> Result<ApiResponse<Vec<(String, String)>>, String> {
    let primary_folder = crate::paths::get_music_folder_path(&app)?;
    
    let folders = tokio::task::spawn_blocking(move || {
        if !primary_folder.exists() {
            return Ok::<_, String>(Vec::new());
        }
        
        let mut folders = Vec::new();
        
        for entry in std::fs::read_dir(&primary_folder)
            .map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?;
            let file_type = metadata.file_type();
            
            #[cfg(unix)]
            let is_link = file_type.is_symlink();
            
            #[cfg(windows)]
            let is_link = file_type.is_symlink() || file_type.is_dir();
            
            if is_link {
                let name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                
                let target = std::fs::read_link(&path)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "unknown".to_string());
                
                folders.push((name, target));
            }
        }
        
        Ok(folders)
    })
    .await
    .map_err(|e| e.to_string())??;
    
    Ok(ApiResponse::ok(folders))
}

/// 检查路径是否为系统敏感目录，禁止创建符号链接指向这些路径
///
/// 调用方传入的 path 应为 canonicalize 后的绝对路径。
/// macOS 上 `/etc`、`/var`、`/tmp` 是 `/private/...` 的符号链接，
/// canonicalize 后会变成 `/private/etc` 等形式，因此敏感前缀必须同时包含两种变体，
/// 否则用户传入 `/etc` 经 canonicalize 后可绕过检查。
fn is_sensitive_path(path: &std::path::Path) -> bool {
    let path_str = path.to_string_lossy();
    // 同时列出 symlink 形式与 canonicalize 后的形式，覆盖 macOS /private 前缀
    let sensitive_prefixes: &[&str] = &[
        "/etc", "/private/etc",
        "/var", "/private/var",
        "/tmp", "/private/tmp",
        "/System", "/usr", "/bin", "/sbin",
        "/dev", "/proc", "/sys", "/boot", "/lib",
    ];

    for prefix in sensitive_prefixes {
        if path_str == *prefix || path_str.starts_with(&format!("{}/", prefix)) {
            return true;
        }
    }

    // 检查用户敏感目录
    if let Some(home) = dirs::home_dir() {
        let home_str = home.to_string_lossy();
        let sensitive_homes = [".ssh", ".gnupg", ".config", ".cache", "Library/Keychains"];
        for s in &sensitive_homes {
            let sensitive_path = format!("{}/{}", home_str, s);
            if path_str == sensitive_path || path_str.starts_with(&format!("{}/", sensitive_path)) {
                return true;
            }
        }
    }

    false
}
