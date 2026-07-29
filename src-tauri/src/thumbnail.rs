use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageReader;
use md5::compute;
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

pub const THUMBNAIL_SMALL_SIZE: u32 = 56;
pub const THUMBNAIL_LARGE_SIZE: u32 = 200;

fn get_thumbnails_dir() -> Result<PathBuf, String> {
    // 与 paths::get_app_data_dir 保持一致：优先使用 JLOCAL_DATA_DIR（dev 环境），
    // 否则回退到系统本地数据目录，避免 dev/prod 缩略图目录不一致
    let data_dir = if let Ok(dir) = std::env::var("JLOCAL_DATA_DIR") {
        PathBuf::from(dir)
    } else {
        dirs::data_local_dir()
            .ok_or_else(|| "Failed to get local data directory".to_string())?
            .join("com.jlocal.app")
    };

    let thumbnails_dir = data_dir.join("thumbnails");

    if !thumbnails_dir.exists() {
        fs::create_dir_all(&thumbnails_dir)
            .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;
    }

    Ok(thumbnails_dir)
}

fn path_to_hash(path: &str) -> String {
    let digest = compute(path.as_bytes());
    format!("{:x}", digest)
}

/// 获取源音频文件的 mtime（UNIX 毫秒，与 scanner.rs 一致）
/// 用于缩略图缓存失效：文件被替换后 mtime 变化，强制重新生成缩略图
fn get_source_mtime(song_path: &str) -> Option<u64> {
    fs::metadata(song_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// 缩略图文件名格式：{hash}_{mtime}_{size}.jpg
/// mtime 为源文件修改时间，文件替换后 mtime 变化 → 文件名变化 → 缓存自动失效
fn thumbnail_filename(hash: &str, mtime: u64, size: u32) -> String {
    format!("{}_{}_{}.jpg", hash, mtime, size)
}

/// 查找同一首歌同一尺寸的所有旧缩略图（不同 mtime），用于清理
fn find_existing_thumbnails(hash: &str, size: u32) -> Vec<PathBuf> {
    let dir = match get_thumbnails_dir() {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let prefix = format!("{}_", hash);
    let suffix = format!("_{}.jpg", size);
    let mut found = vec![];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(&suffix) {
                found.push(entry.path());
            }
        }
    }
    found
}

/// 获取缩略图路径（基于源文件 mtime）
/// 返回 None 表示源文件不存在（无法获取 mtime），此时不应缓存
pub fn get_thumbnail_path(song_path: &str, size: u32) -> Result<Option<PathBuf>, String> {
    let mtime = match get_source_mtime(song_path) {
        Some(m) => m,
        None => return Ok(None),
    };
    let hash = path_to_hash(song_path);
    let filename = thumbnail_filename(&hash, mtime, size);
    Ok(Some(get_thumbnails_dir()?.join(filename)))
}

pub fn thumbnail_exists(song_path: &str, size: u32) -> bool {
    match get_thumbnail_path(song_path, size) {
        Ok(Some(p)) => p.exists(),
        _ => false,
    }
}

pub fn get_thumbnail_base64(song_path: &str, size: u32) -> Option<String> {
    let thumbnail_path = match get_thumbnail_path(song_path, size) {
        Ok(Some(p)) => p,
        _ => {
            tracing::debug!(
                "get_thumbnail_base64: cannot resolve path for {}",
                song_path
            );
            return None;
        }
    };

    if thumbnail_path.exists() {
        match fs::read(&thumbnail_path) {
            Ok(bytes) => Some(STANDARD.encode(&bytes)),
            Err(e) => {
                tracing::debug!(
                    "get_thumbnail_base64: read error {:?}: {}",
                    thumbnail_path,
                    e
                );
                None
            }
        }
    } else {
        None
    }
}

pub fn create_thumbnail(cover_data: &[u8], song_path: &str, size: u32) -> Result<String, String> {
    let img = ImageReader::new(Cursor::new(cover_data))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;

    // 小尺寸缩略图用 Triangle 滤镜（线性插值），比 Lanczos3 快 3-5 倍且质量足够
    // 大尺寸用 CatmullRom（三次卷积），质量与性能平衡
    let filter = if size <= THUMBNAIL_SMALL_SIZE {
        image::imageops::FilterType::Triangle
    } else {
        image::imageops::FilterType::CatmullRom
    };

    let thumbnail = img.resize_to_fill(size, size, filter);

    let hash = path_to_hash(song_path);
    let mtime =
        get_source_mtime(song_path).ok_or_else(|| "Failed to get source file mtime".to_string())?;
    let thumbnail_path = get_thumbnails_dir()?.join(thumbnail_filename(&hash, mtime, size));

    // 清理同一首歌同一尺寸的旧 mtime 缩略图（缓存失效）
    for old_path in find_existing_thumbnails(&hash, size) {
        if old_path != thumbnail_path {
            let _ = fs::remove_file(&old_path);
        }
    }

    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);

    thumbnail
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;

    let mut file = fs::File::create(&thumbnail_path)
        .map_err(|e| format!("Failed to create thumbnail file: {}", e))?;

    file.write_all(&buffer)
        .map_err(|e| format!("Failed to write thumbnail: {}", e))?;

    Ok(STANDARD.encode(&buffer))
}

#[allow(dead_code)]
pub fn get_or_create_thumbnail(
    cover_data: &[u8],
    song_path: &str,
    size: u32,
) -> Result<String, String> {
    if let Some(cached) = get_thumbnail_base64(song_path, size) {
        return Ok(cached);
    }

    create_thumbnail(cover_data, song_path, size)
}

pub fn get_thumbnails_count() -> (usize, usize) {
    let thumbnails_dir = match get_thumbnails_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("get_thumbnails_count: {}", e);
            return (0, 0);
        }
    };
    let mut small_count = 0;
    let mut large_count = 0;

    if thumbnails_dir.exists() {
        if let Ok(entries) = fs::read_dir(&thumbnails_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(&format!("_{}.jpg", THUMBNAIL_SMALL_SIZE)) {
                    small_count += 1;
                } else if name.ends_with(&format!("_{}.jpg", THUMBNAIL_LARGE_SIZE)) {
                    large_count += 1;
                }
            }
        }
    }

    (small_count, large_count)
}

pub fn get_thumbnails_size() -> u64 {
    let thumbnails_dir = match get_thumbnails_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("get_thumbnails_size: {}", e);
            return 0;
        }
    };
    let mut total_size = 0;

    if thumbnails_dir.exists() {
        if let Ok(entries) = fs::read_dir(&thumbnails_dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "jpg") {
                    if let Ok(metadata) = entry.metadata() {
                        total_size += metadata.len();
                    }
                }
            }
        }
    }

    total_size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_to_hash() {
        let hash1 = path_to_hash("/music/song1.mp3");
        let hash2 = path_to_hash("/music/song2.mp3");

        assert_ne!(hash1, hash2);
        assert_eq!(hash1.len(), 32);
    }

    #[test]
    fn test_thumbnail_filename_format() {
        let hash = path_to_hash("/music/test.mp3");
        let name = thumbnail_filename(&hash, 1700000000, THUMBNAIL_SMALL_SIZE);
        assert!(name.starts_with(&format!("{}_", hash)));
        assert!(name.ends_with(&format!("_{}.jpg", THUMBNAIL_SMALL_SIZE)));
        assert!(name.contains("1700000000"));
    }

    #[test]
    fn test_get_thumbnail_path_nonexistent_file() {
        // 源文件不存在时，get_thumbnail_path 返回 None
        let result =
            get_thumbnail_path("/nonexistent/path/test.mp3", THUMBNAIL_SMALL_SIZE).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_thumbnail_path_existing_file() {
        // 使用临时文件测试
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("jlocal_thumbnail_test.mp3");
        fs::write(&temp_file, b"test").unwrap();

        let path_small =
            get_thumbnail_path(temp_file.to_str().unwrap(), THUMBNAIL_SMALL_SIZE).unwrap();
        let path_large =
            get_thumbnail_path(temp_file.to_str().unwrap(), THUMBNAIL_LARGE_SIZE).unwrap();

        assert!(path_small.is_some());
        assert!(path_large.is_some());

        let path_small = path_small.unwrap();
        let path_large = path_large.unwrap();
        assert!(path_small
            .to_str()
            .unwrap()
            .ends_with(&format!("_{}.jpg", THUMBNAIL_SMALL_SIZE)));
        assert!(path_large
            .to_str()
            .unwrap()
            .ends_with(&format!("_{}.jpg", THUMBNAIL_LARGE_SIZE)));

        // 清理
        let _ = fs::remove_file(&temp_file);
    }
}
