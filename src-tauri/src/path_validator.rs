use crate::constants::{
    is_playable_extension, ENCRYPTED_AUDIO_EXTENSIONS, NORMAL_AUDIO_EXTENSIONS,
};
#[cfg(windows)]
use std::path::Component;
use std::path::{Path, PathBuf};

/// 获取音乐文件夹内所有符号链接的 canonicalize 目标（二级文件夹白名单）
/// 用于安全校验：只允许通过已注册的二级文件夹符号链接访问外部目录
pub fn get_secondary_targets(music_folder: &str) -> Vec<PathBuf> {
    let music_path = match Path::new(music_folder).canonicalize() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let mut targets = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&music_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            // 只检查 music_folder 直接子项中的符号链接
            if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                if metadata.file_type().is_symlink() {
                    // canonicalize 解析符号链接的真实目标
                    if let Ok(target) = path.canonicalize() {
                        targets.push(target);
                    }
                }
            }
        }
    }
    targets
}

/// 跨平台"路径前缀"比较：判断 path 是否位于 base 之下。
///
/// - Unix：直接使用 `Path::starts_with`（大小写敏感，符合文件系统语义）。
/// - Windows：文件系统大小写不敏感，`Path::starts_with` 却按 OsStr 精确匹配，
///   会导致 `C:\Music` 与 `C:\music` 被判为不同前缀而拒绝合法路径。
///   因此在 starts_with 失败时，回退到按 component 做大小写不敏感比较。
///
/// 安全性：按 component 比较，不会出现 `C:\Music` 误匹配 `C:\MusicOther` 的字符串前缀问题。
fn path_starts_with_ci(path: &Path, base: &Path) -> bool {
    if path.starts_with(base) {
        return true;
    }
    #[cfg(windows)]
    {
        let path_comps: Vec<Component> = path.components().collect();
        let base_comps: Vec<Component> = base.components().collect();
        if path_comps.len() < base_comps.len() {
            return false;
        }
        path_comps[..base_comps.len()]
            .iter()
            .zip(base_comps.iter())
            .all(|(p, b)| {
                p.as_os_str().to_string_lossy().to_lowercase()
                    == b.as_os_str().to_string_lossy().to_lowercase()
            })
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 检查路径是否在音乐文件夹内（安全校验：canonicalize 后必须在 music_folder 或已注册的二级文件夹目标内）
/// secondary_targets: 二级文件夹符号链接的 canonicalize 目标列表，通过 get_secondary_targets 获取
pub fn is_path_in_music_folder(
    path_str: &str,
    music_folder: &str,
    secondary_targets: &[PathBuf],
) -> bool {
    let path = Path::new(path_str);
    let music_path = match Path::new(music_folder).canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };

    // 1. 尝试 canonicalize 完整路径（解析所有符号链接）
    if let Ok(canon) = path.canonicalize() {
        if path_starts_with_ci(&canon, &music_path) {
            return true;
        }
        // 检查 canonical 路径是否在任一二级文件夹目标内
        for target in secondary_targets {
            if path_starts_with_ci(&canon, target) {
                return true;
            }
        }
        // canonical 路径既不在 music_folder 也不在二级文件夹目标内 → 拒绝
        // 不再回退到 normalize_path（安全漏洞：未解析符号链接的前缀检查可被绕过）
        return false;
    }

    // 2. 文件尚不存在 — 尝试 canonicalize 父目录
    if let Some(parent) = path.parent() {
        if let Ok(parent_canon) = parent.canonicalize() {
            if path_starts_with_ci(&parent_canon, &music_path) {
                return true;
            }
            for target in secondary_targets {
                if path_starts_with_ci(&parent_canon, target) {
                    return true;
                }
            }
        }
    }

    false
}

/// 校验 link_name 是单一路径组件（不含 / \ ..），防止路径遍历
pub fn is_safe_link_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    // 不允许包含路径分隔符或 ..
    !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

pub fn validate_audio_extension(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match ext.as_deref() {
        Some(ext) => is_playable_extension(ext),
        None => false,
    }
}

#[allow(dead_code)]
pub fn get_all_supported_extensions() -> Vec<&'static str> {
    let mut extensions: Vec<&'static str> = NORMAL_AUDIO_EXTENSIONS.to_vec();
    extensions.extend_from_slice(ENCRYPTED_AUDIO_EXTENSIONS);
    extensions
}

#[allow(dead_code)]
pub fn get_format_description(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "ncm" => Some("网易云音乐加密格式"),
        "qmc" | "qmc0" | "qmc3" | "qmcflac" | "qmcogg" | "mflac" => Some("QQ音乐加密格式"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// 构造测试目录树：
    /// root/
    ///   music/
    ///     song.mp3
    ///     sub/
    ///       inner.mp3
    ///   external/
    ///     other.mp3
    /// 返回 (root, music_dir_canonical, external_dir_canonical)
    fn create_test_tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempdir().expect("failed to create tempdir");
        let music = dir.path().join("music");
        fs::create_dir(&music).unwrap();
        fs::write(music.join("song.mp3"), b"fake").unwrap();
        fs::create_dir(music.join("sub")).unwrap();
        fs::write(music.join("sub").join("inner.mp3"), b"fake").unwrap();

        let external = dir.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("other.mp3"), b"fake").unwrap();

        let music_canon = music.canonicalize().unwrap();
        let external_canon = external.canonicalize().unwrap();
        (dir, music_canon, external_canon)
    }

    // ===== is_safe_link_name =====

    #[test]
    fn safe_link_name_accepts_normal() {
        assert!(is_safe_link_name("music"));
        assert!(is_safe_link_name("my_folder"));
        assert!(is_safe_link_name("foo.bar"));
    }

    #[test]
    fn safe_link_name_rejects_empty() {
        assert!(!is_safe_link_name(""));
    }

    #[test]
    fn safe_link_name_rejects_dot_and_dotdot() {
        assert!(!is_safe_link_name("."));
        assert!(!is_safe_link_name(".."));
    }

    #[test]
    fn safe_link_name_rejects_separators() {
        assert!(!is_safe_link_name("a/b"));
        assert!(!is_safe_link_name("a\\b"));
    }

    #[test]
    fn safe_link_name_rejects_dotdot_anywhere() {
        // 保守策略：任何位置出现 ".." 都拒绝，防止 "foo/../bar" 类变形
        assert!(!is_safe_link_name("a..b"));
        assert!(!is_safe_link_name("foo.."));
    }

    // ===== validate_audio_extension =====

    #[test]
    fn audio_extension_normal() {
        assert!(validate_audio_extension("song.mp3"));
        assert!(validate_audio_extension("song.flac"));
        assert!(validate_audio_extension("song.m4a"));
        assert!(validate_audio_extension("song.opus"));
    }

    #[test]
    fn audio_extension_encrypted() {
        assert!(validate_audio_extension("song.ncm"));
        assert!(validate_audio_extension("song.qmcflac"));
    }

    #[test]
    fn audio_extension_rejects_unsupported() {
        // validate_audio_extension 现在使用 is_playable_extension，拒绝 wma/ape 等不支持格式
        assert!(!validate_audio_extension("song.wma"));
        assert!(!validate_audio_extension("song.ape"));
        assert!(!validate_audio_extension("song.wv"));
        assert!(!validate_audio_extension("song.tta"));
    }

    #[test]
    fn audio_extension_rejects_non_audio() {
        assert!(!validate_audio_extension("song.txt"));
        assert!(!validate_audio_extension("song.mp4"));
        assert!(!validate_audio_extension("song"));
        assert!(!validate_audio_extension("song."));
    }

    #[test]
    fn audio_extension_case_insensitive() {
        assert!(validate_audio_extension("song.MP3"));
        assert!(validate_audio_extension("song.FLAC"));
        assert!(validate_audio_extension("song.NCM"));
    }

    // ===== is_path_in_music_folder =====

    #[test]
    fn path_inside_music_folder_accepted() {
        let (_dir, music, _external) = create_test_tree();
        let song = music.join("song.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(is_path_in_music_folder(
            &song.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn path_in_subdir_of_music_folder_accepted() {
        let (_dir, music, _external) = create_test_tree();
        let inner = music.join("sub").join("inner.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(is_path_in_music_folder(
            &inner.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn path_outside_music_folder_rejected() {
        let (_dir, music, external) = create_test_tree();
        let other = external.join("other.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(!is_path_in_music_folder(
            &other.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn path_traversal_rejected() {
        // "music/../external/other.mp3" canonicalize 后落在 external，应被拒
        let (dir, music, _external) = create_test_tree();
        let traversal = dir
            .path()
            .join("music")
            .join("..")
            .join("external")
            .join("other.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(!is_path_in_music_folder(
            &traversal.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn nonexistent_file_with_valid_parent_accepted() {
        // 文件不存在但父目录在 music_folder 内 → 允许（用于写入场景）
        let (_dir, music, _external) = create_test_tree();
        let nonexistent = music.join("not_yet_exist.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(is_path_in_music_folder(
            &nonexistent.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn nonexistent_file_with_invalid_parent_rejected() {
        // 文件不存在且父目录也不在 music_folder 内 → 拒绝
        let (_dir, music, external) = create_test_tree();
        let nonexistent = external.join("not_yet_exist.mp3");
        let music_str = music.to_string_lossy().to_string();
        assert!(!is_path_in_music_folder(
            &nonexistent.to_string_lossy(),
            &music_str,
            &[]
        ));
    }

    #[test]
    fn nonexistent_root_completely_rejected() {
        let (_dir, music, _external) = create_test_tree();
        let music_str = music.to_string_lossy().to_string();
        assert!(!is_path_in_music_folder(
            "/path/to/nowhere/nonexistent.mp3",
            &music_str,
            &[]
        ));
    }

    #[test]
    fn nonexistent_music_folder_rejected() {
        // music_folder 本身不存在 → canonicalize 失败 → 拒绝
        assert!(!is_path_in_music_folder(
            "/tmp/whatever.mp3",
            "/nonexistent/music/folder",
            &[]
        ));
    }

    // ===== get_secondary_targets =====

    #[test]
    fn secondary_targets_empty_when_no_symlinks() {
        let (_dir, music, _external) = create_test_tree();
        let music_str = music.to_string_lossy().to_string();
        let targets = get_secondary_targets(&music_str);
        assert!(
            targets.is_empty(),
            "expected no secondary targets without symlinks"
        );
    }

    // ===== 二级文件夹符号链接白名单（Unix only，Windows symlink 需要权限）=====
    #[cfg(unix)]
    mod unix_symlink {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn path_in_secondary_target_accepted() {
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            fs::create_dir(&music).unwrap();
            fs::write(music.join("local.mp3"), b"fake").unwrap();

            let external = dir.path().join("external");
            fs::create_dir(&external).unwrap();
            fs::write(external.join("linked.mp3"), b"fake").unwrap();

            // 创建符号链接 music/link → external
            let link = music.join("link");
            symlink(&external, &link).unwrap();

            let music_canon = music.canonicalize().unwrap();
            let external_canon = external.canonicalize().unwrap();
            let music_str = music_canon.to_string_lossy().to_string();

            // get_secondary_targets 应返回 external 的 canonicalize 目标
            let targets = get_secondary_targets(&music_str);
            assert_eq!(targets, vec![external_canon.clone()]);

            // external/linked.mp3 通过 secondary_targets 白名单 → 允许
            let linked = external_canon.join("linked.mp3");
            assert!(is_path_in_music_folder(
                &linked.to_string_lossy(),
                &music_str,
                &targets
            ));

            // music/local.mp3 仍然允许
            let local = music_canon.join("local.mp3");
            assert!(is_path_in_music_folder(
                &local.to_string_lossy(),
                &music_str,
                &targets
            ));
        }

        #[test]
        fn path_outside_both_music_and_targets_rejected() {
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            fs::create_dir(&music).unwrap();

            let external = dir.path().join("external");
            fs::create_dir(&external).unwrap();
            fs::write(external.join("linked.mp3"), b"fake").unwrap();

            let outside = dir.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("forbidden.mp3"), b"fake").unwrap();

            let link = music.join("link");
            symlink(&external, &link).unwrap();

            let music_canon = music.canonicalize().unwrap();
            let music_str = music_canon.to_string_lossy().to_string();
            let targets = get_secondary_targets(&music_str);

            // outside 不在 music 也不在 secondary_targets → 拒绝
            let forbidden = outside.canonicalize().unwrap().join("forbidden.mp3");
            assert!(!is_path_in_music_folder(
                &forbidden.to_string_lossy(),
                &music_str,
                &targets
            ));
        }
    }
}
