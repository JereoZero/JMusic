// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod constants;
mod database;
mod dsd_decoder;
mod lyrics;
mod metadata;
mod ncm;
mod path_validator;
mod paths;
mod player;
mod qmc;
mod scanner;
mod thumbnail;

use tauri::Manager;
use tracing::{error, info, warn};

#[cfg(target_os = "macos")]
fn set_dark_window_appearance(window: &tauri::WebviewWindow) {
    use objc2::class;
    use objc2::msg_send;
    use objc2_foundation::ns_string;

    let ns_window = match window.ns_window() {
        Ok(w) => w as *mut objc2::runtime::AnyObject,
        Err(e) => {
            error!("Failed to get NSWindow for dark appearance: {}", e);
            return;
        }
    };
    unsafe {
        let appearance: *mut objc2::runtime::AnyObject = msg_send![
            class!(NSAppearance),
            appearanceNamed: ns_string!("NSAppearanceNameDarkAqua")
        ];
        if !appearance.is_null() {
            let _: () = msg_send![ns_window, setAppearance: appearance];
            info!("Set macOS window to dark appearance");
        }
    }
}

fn main() {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("jlocal=info".parse().expect("invalid jlocal log directive"))
                .add_directive("tauri=info".parse().expect("invalid tauri log directive")),
        )
        .init();

    info!("Starting JlocalMusic v{}", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 初始化数据库
            let db = tauri::async_runtime::block_on(async {
                match database::init(&app_handle).await {
                    Ok(db) => Ok(db),
                    Err(e) => {
                        tracing::error!("Failed to initialize database: {}", e);
                        Err(e)
                    }
                }
            })?;

            // 初始化播放器
            let player = player::init(app_handle.clone()).map_err(|e| {
                tracing::error!("Failed to initialize player: {}", e);
                e
            })?;

            // 管理状态
            app.manage(db.clone());
            app.manage(player);

            // macOS 原生标题栏深色外观
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                set_dark_window_appearance(&window);
            }

            // 自动扫描默认音乐文件夹
            tauri::async_runtime::spawn(async move {
                // 音乐文件夹唯一真源：DB 设置 `music_folder`，缺失时回退默认目录并写回 DB
                let music_folder: String =
                    match crate::paths::resolve_music_folder(&app_handle, &db).await {
                        Ok(folder) => folder.to_string_lossy().to_string(),
                        Err(e) => {
                            error!("Failed to resolve music folder: {}", e);
                            return;
                        }
                    };

                if music_folder.is_empty() {
                    info!("No music folder configured");
                    return;
                }

                if std::path::Path::new(&music_folder).exists() {
                    info!("Auto-scanning music folder: {}", music_folder);

                    // 与设置页的「重新扫描」共用同一份实现（清理 → 扫描 → 落库 →
                    // 回收缩略图 → 广播 scan_complete），避免两条路径再次分叉。
                    match scanner::scan_and_persist(
                        &db,
                        &music_folder,
                        scanner::CleanupScope::Global,
                        &app_handle,
                    )
                    .await
                    {
                        Ok(result) => info!(
                            "Scan completed. Normal: {}, Encrypted: {}, Skipped: {}",
                            result.normal_songs.len(),
                            result.encrypted_songs.len(),
                            result.skipped
                        ),
                        Err(e) => error!("Failed to scan default music folder: {}", e),
                    }
                } else {
                    warn!("Music folder does not exist: {}", music_folder);
                }
            });

            info!("Application initialized successfully");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 歌曲相关
            commands::get_songs,
            commands::get_last_played_song,
            commands::get_song_cover,
            commands::get_song_cover_large,
            commands::get_song_cover_full,
            commands::get_song_covers_batch,
            commands::get_liked_paths,
            commands::get_liked_songs,
            commands::toggle_like,
            commands::clear_liked_songs,
            commands::scan_folder,
            commands::search_songs,
            commands::delete_song,
            // 播放控制
            commands::play_song,
            commands::pause_song,
            commands::resume_song,
            commands::stop_song,
            commands::seek_song,
            commands::set_volume,
            commands::get_player_state,
            // 元数据
            commands::get_metadata,
            commands::get_metadata_batch,
            // 隐藏歌曲管理
            commands::hide_song,
            commands::unhide_song,
            commands::get_hidden_paths,
            commands::hide_songs_batch,
            commands::unhide_songs_batch,
            commands::clear_hidden_songs,
            commands::get_hidden_count,
            commands::is_song_hidden,
            // 设置管理
            commands::get_setting,
            commands::set_setting,
            commands::get_all_settings,
            // 文件操作
            commands::check_file_exists,
            // 喜欢歌曲查询
            commands::is_song_liked,
            // 隐藏歌曲完整信息
            commands::get_hidden_songs,
            // 日志管理
            commands::add_log,
            commands::get_logs,
            commands::get_error_logs,
            commands::clear_logs,
            commands::get_log_count,
            commands::get_logs_as_text,
            // 播放历史
            commands::add_play_history,
            commands::get_play_history,
            commands::clear_play_history,
            commands::get_play_counts,
            commands::get_song_play_count,
            commands::cleanup_nonexistent_songs,
            // 文件夹选择
            commands::select_folder,
            // 歌词
            commands::get_lyrics,
            // 缩略图
            commands::get_thumbnail_info,
            // 符号链接管理
            commands::get_primary_music_folder,
            commands::add_secondary_folder,
            commands::remove_secondary_folder,
            commands::get_secondary_folders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
