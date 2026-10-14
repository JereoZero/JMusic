// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_log;
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
    // 初始化日志：
    // - fmt() 保留控制台输出（开发/排查时看终端）
    // - LogLayer 把事件额外收进内存环形缓冲，供设置页「日志」标签读取
    //   （此前 app_logs 表零写入方，日志面板永远为空）
    let env_filter = tracing_subscriber::EnvFilter::from_default_env()
        .add_directive("jlocal=info".parse().expect("invalid jlocal log directive"))
        .add_directive("tauri=info".parse().expect("invalid tauri log directive"));
    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(app_log::LogLayer)
        .init();

    info!("Starting JlocalMusic v{}", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        // 仅保留 dialog：select_folder 命令（commands/misc.rs）实际使用。
        // 曾还注册 shell/fs，但 Rust 与前端 JS API 均零调用、capabilities 也未授权。
        .plugin(tauri_plugin_dialog::init())
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
            commands::get_song_covers_batch,
            commands::get_liked_paths,
            commands::get_liked_songs,
            commands::toggle_like,
            commands::clear_liked_songs,
            commands::scan_folder,
            // 播放控制
            commands::play_song,
            commands::pause_song,
            commands::resume_song,
            commands::stop_song,
            commands::seek_song,
            commands::set_volume,
            // 隐藏歌曲管理
            commands::hide_song,
            commands::unhide_song,
            commands::get_hidden_paths,
            commands::hide_songs_batch,
            commands::unhide_songs_batch,
            commands::clear_hidden_songs,
            // 设置管理
            commands::set_setting,
            // 日志管理
            commands::get_logs,
            commands::clear_logs,
            commands::get_logs_as_text,
            // 播放历史
            commands::add_play_history,
            commands::get_play_history,
            commands::clear_play_history,
            // 歌词
            commands::get_lyrics,
            // 文件夹选择
            commands::select_folder,
            // 符号链接管理
            commands::get_primary_music_folder,
            commands::add_secondary_folder,
            commands::remove_secondary_folder,
            commands::get_secondary_folders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
