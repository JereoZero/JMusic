use std::path::Path;

/// 检查是否是 NCM 文件
pub fn is_ncm_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        ext.eq_ignore_ascii_case("ncm")
    } else {
        false
    }
}

/// 尝试从 NCM 文件中提取元数据
/// 注：保留用于未来可能的元数据提取功能
#[allow(dead_code)]
pub fn extract_ncm_metadata(path: &Path) -> Option<(String, String, String, Option<String>)> {
    use std::fs;
    
    let buffer = fs::read(path).ok()?;
    
    // NCM 文件头魔数
    const NCM_MAGIC: &[u8] = &[0x43, 0x54, 0x45, 0x4E, 0x46, 0x44, 0x41, 0x4D];
    
    // 检查魔数
    if buffer.len() < 8 || &buffer[0..8] != NCM_MAGIC {
        return None;
    }
    
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
    
    Some((title, artist, "Unknown Album".to_string(), None))
}
