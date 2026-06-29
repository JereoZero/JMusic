use std::path::Path;

const QMC_EXTENSIONS: &[&str] = &[
    "qmc0", "qmc2", "qmc3", "qmc4", "qmc6", "qmc8",
    "qmcflac", "qmcogg",
    "mflac", "mflac0", "mgg", "mgg0", "mgg1", "mggl",
    "mmp4", "tkm",
];

/// 检查是否是 QMC 文件
pub fn is_qmc_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_lowercase();
        QMC_EXTENSIONS.contains(&ext.as_str())
    } else {
        false
    }
}

/// 尝试从 QMC 文件中提取元数据
/// 注：保留用于未来可能的元数据提取功能
#[allow(dead_code)]
pub fn extract_qmc_metadata(path: &Path) -> Option<(String, String, String)> {
    let filename = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    
    // 尝试从文件名解析 (通常格式: "歌手 - 歌曲名")
    let (artist, title) = if let Some(dash_pos) = filename.find(" - ") {
        let artist = filename[..dash_pos].trim().to_string();
        let title = filename[dash_pos + 3..].trim().to_string();
        (artist, title)
    } else {
        ("Unknown Artist".to_string(), filename.clone())
    };
    
    Some((title, artist, "Unknown Album".to_string()))
}
