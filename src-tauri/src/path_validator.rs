use crate::constants::{
    is_playable_extension, ENCRYPTED_AUDIO_EXTENSIONS, NORMAL_AUDIO_EXTENSIONS,
};
#[cfg(windows)]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 白名单递归收集的最大深度，与 scanner 的 `max_depth(50)` 保持一致，
/// 避免病态深的目录树拖慢校验（本函数在每个带路径的命令里都会被调用）。
const MAX_SECONDARY_SCAN_DEPTH: usize = 50;

/// 二级文件夹白名单的进程内缓存：(music_folder, targets)。
///
/// **为什么需要缓存**：`get_secondary_targets` 要递归遍历整个曲库目录树
/// （实测 6000 文件 / 441 目录的库约 **20ms**），而它在**每次带路径的命令**
/// （播放 / 收藏 / 删除 / 取封面 / 取歌词）里都会执行一次，白名单却极少变化。
///
/// 缓存键是 `music_folder` 字符串，因此更换主目录会自动失效；
/// 但增删二级文件夹、或扫描后发现新符号链接时**必须**显式调用
/// [`invalidate_secondary_targets_cache`]，否则新链接在缓存失效前不被认可。
///
/// 已知取舍：只保留最近一个目录的结果，且**不随外部文件系统变化自动过期** ——
/// 用户若在 Finder 里直接增删音乐库中的符号链接（不经应用操作），
/// 需重启应用或触发一次扫描才会生效。
static SECONDARY_TARGETS_CACHE: Mutex<Option<(String, Vec<PathBuf>)>> = Mutex::new(None);

/// 使二级文件夹白名单缓存失效。曲库结构变化后必须调用。
pub fn invalidate_secondary_targets_cache() {
    if let Ok(mut cache) = SECONDARY_TARGETS_CACHE.lock() {
        *cache = None;
    }
}

/// 获取音乐文件夹内所有符号链接的 canonicalize 目标（二级文件夹白名单）
/// 用于安全校验：只允许通过已注册的二级文件夹符号链接访问外部目录
///
/// 递归收集**任意深度**的符号链接，理由见 [`collect_symlink_targets`]。
/// 结果带进程内缓存；返回的是克隆（通常只有几个元素，成本可忽略），
/// 真正的开销（遍历目录树）已被省掉。
pub fn get_secondary_targets(music_folder: &str) -> Vec<PathBuf> {
    // 锁中毒（其他线程 panic 时）不能直接 unwrap：降级为「不走缓存、直接重算」，
    // 校验逻辑必须始终可用。
    if let Ok(cache) = SECONDARY_TARGETS_CACHE.lock() {
        if let Some((cached_folder, targets)) = cache.as_ref() {
            if cached_folder == music_folder {
                return targets.clone();
            }
        }
    }

    let targets = collect_secondary_targets(music_folder);

    if let Ok(mut cache) = SECONDARY_TARGETS_CACHE.lock() {
        *cache = Some((music_folder.to_string(), targets.clone()));
    }
    targets
}

/// 无缓存地收集白名单（真正的遍历实现在 [`collect_symlink_targets`]）
fn collect_secondary_targets(music_folder: &str) -> Vec<PathBuf> {
    let music_path = match Path::new(music_folder).canonicalize() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let mut targets = Vec::new();
    collect_symlink_targets(&music_path, 0, &mut targets);
    targets
}

/// 递归收集 `dir` 子树内所有符号链接的 canonicalize 目标。
///
/// # 为什么要递归（而不是只看一级子项）
///
/// scanner 用 `follow_links(true)` 跟进**任意深度**的符号链接，并把「链接路径」形式
/// 入库；而校验时 [`is_path_in_music_folder`] 会 canonicalize 该路径得到真实目标，
/// 再要求它在白名单内。若白名单只登记一级子项，深层链接下的歌曲就会以链接路径入库、
/// 却在 canonicalize 后被判越权 —— 它们在列表里可见，但播放 / 取歌词 / 收藏 / 删除
/// **全部返回 Access denied**（即「幽灵歌」）。递归收集后，这类歌曲的校验能正常通过，
/// 且不改变扫描行为（不会误删已入库的歌曲）。
///
/// # 不会无限递归
///
/// 只对**真实目录**递归（用 `symlink_metadata` 判断类型，不跟随链接），
/// 遇到符号链接只记录其目标、不进入。因此链接成环也不会失控。
/// 链接目标**内部**的更深处符号链接不再展开 —— 那是用户手动构造的极端场景，
/// 扫描层也不会为它建立可点击的二级文件夹入口。
fn collect_symlink_targets(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth >= MAX_SECONDARY_SCAN_DEPTH {
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let file_type = metadata.file_type();

        if file_type.is_symlink() {
            // 悬空链接（目标盘未挂载 / 目标已删）canonicalize 失败，静默跳过
            if let Ok(target) = path.canonicalize() {
                out.push(target);
            }
        } else if file_type.is_dir() {
            // 与扫描阶段的过滤规则保持一致：隐藏目录与 NAS 元数据目录本就
            // 不会被扫描跟进，其中的链接无需登记
            let name = entry.file_name();
            let name_lossy = name.to_string_lossy();
            if name_lossy.starts_with('.') || name_lossy == "@eaDir" {
                continue;
            }
            collect_symlink_targets(&path, depth + 1, out);
        }
    }
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
    match Path::new(music_folder).canonicalize() {
        Ok(music_path) => is_path_under_canonical_base(path_str, &music_path, secondary_targets),
        Err(_) => false,
    }
}

/// 批量校验：只 canonicalize **一次** `music_folder`，再逐个检查路径。
///
/// # 为什么需要这个变体
///
/// [`is_path_in_music_folder`] 每次调用都会 canonicalize 一遍 `music_folder`。
/// 批量场景（一次最多 100 个路径）下这会重复 100 次同一目录的 canonicalize ——
/// 实测单次 0.06ms，累计约 5.8ms 的纯浪费。
///
/// 返回通过校验的路径（保持输入顺序）。
pub fn filter_paths_in_music_folder(
    paths: &[String],
    music_folder: &str,
    secondary_targets: &[PathBuf],
) -> Vec<String> {
    let Ok(base) = Path::new(music_folder).canonicalize() else {
        return Vec::new();
    };

    paths
        .iter()
        .filter(|p| is_path_under_canonical_base(p, &base, secondary_targets))
        .cloned()
        .collect()
}

/// 与 [`is_path_in_music_folder`] 相同的判定，但接收**已 canonicalize** 的 music_folder。
///
/// 供批量校验复用，避免每个路径都重复解析同一目录。
fn is_path_under_canonical_base(
    path_str: &str,
    music_path: &Path,
    secondary_targets: &[PathBuf],
) -> bool {
    let path = Path::new(path_str);

    // 1. 尝试 canonicalize 完整路径（解析所有符号链接）
    if let Ok(canon) = path.canonicalize() {
        if path_starts_with_ci(&canon, music_path) {
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
            if path_starts_with_ci(&parent_canon, music_path) {
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

/// 校验路径在音乐文件夹内，并返回 **canonical 后的真实路径**。
///
/// 与 [`is_path_in_music_folder`] 的区别：
/// - 仅接受**已存在**的文件（`canonicalize` 失败即返回 `None`）
/// - 返回 canonical 路径，调用方应使用它打开文件
///
/// 用途：消除「先校验、后用原始路径打开」之间的 TOCTOU 窗口——攻击者若在两次
/// 操作之间把受信目录内的符号链接指向外部文件，原始路径会绕过校验被打开。
/// 使用本函数返回的 canonical 路径打开即可保证校验与打开的是同一实体。
///
/// 注意：DB 相关操作仍应使用**原始路径**，因为二级文件夹歌曲在 DB 中记录的是
/// 符号链接路径，canonical 后无法与 DB 记录匹配。
pub fn resolve_path_in_music_folder(
    path_str: &str,
    music_folder: &str,
    secondary_targets: &[PathBuf],
) -> Option<PathBuf> {
    let canon = Path::new(path_str).canonicalize().ok()?;
    let music_path = Path::new(music_folder).canonicalize().ok()?;

    if path_starts_with_ci(&canon, &music_path) {
        return Some(canon);
    }
    for target in secondary_targets {
        if path_starts_with_ci(&canon, target) {
            return Some(canon);
        }
    }
    None
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

    // ===== resolve_path_in_music_folder（TOCTOU 防护：返回 canonical 路径）=====

    #[test]
    fn resolve_returns_canonical_path_inside_music_folder() {
        let (_dir, music, _external) = create_test_tree();
        let song = music.join("song.mp3");
        let music_str = music.to_string_lossy().to_string();

        let resolved = resolve_path_in_music_folder(&song.to_string_lossy(), &music_str, &[]);
        assert_eq!(resolved, Some(song.canonicalize().unwrap()));
    }

    #[test]
    fn resolve_returns_none_for_nonexistent_file() {
        // 仅接受已存在的文件（canonicalize 失败即拒绝），
        // 因此「文件不存在」不会再走到后续的打开逻辑
        let (_dir, music, _external) = create_test_tree();
        let ghost = music.join("ghost.mp3");
        let music_str = music.to_string_lossy().to_string();

        assert!(resolve_path_in_music_folder(&ghost.to_string_lossy(), &music_str, &[]).is_none());
    }

    #[test]
    fn resolve_returns_none_for_path_outside_music_folder() {
        let (_dir, music, external) = create_test_tree();
        let outside = external.join("other.mp3");
        let music_str = music.to_string_lossy().to_string();

        assert!(
            resolve_path_in_music_folder(&outside.to_string_lossy(), &music_str, &[]).is_none()
        );
    }

    #[test]
    fn resolve_follows_symlink_only_within_whitelisted_target() {
        // 受信目录内的符号链接若指向白名单之外，必须拒绝——
        // 这是 TOCTOU 防护的核心：canonical 后越界即判定越权
        let (_dir, music, external) = create_test_tree();
        let link = music.join("evil.mp3");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(external.join("other.mp3"), &link).unwrap();
            let music_str = music.to_string_lossy().to_string();
            assert!(
                resolve_path_in_music_folder(&link.to_string_lossy(), &music_str, &[]).is_none(),
                "指向白名单外的符号链接必须被拒绝"
            );
            // 若该目标被登记为二级文件夹白名单，则应放行
            let targets = vec![external.clone()];
            assert_eq!(
                resolve_path_in_music_folder(&link.to_string_lossy(), &music_str, &targets),
                Some(external.join("other.mp3").canonicalize().unwrap())
            );
        }
        #[cfg(not(unix))]
        let _ = &link;
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

        #[test]
        fn nested_symlink_target_is_whitelisted() {
            // 回归「幽灵歌」：scanner 用 follow_links(true) 跟进任意深度的符号链接，
            // 歌曲以**链接路径**入库，而校验时会 canonicalize 成真实目标。
            // 若白名单只登记一级子项，深层链接下的歌曲就会在列表里可见、
            // 却所有操作都返回 Access denied。
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            let album = music.join("Artist").join("Album");
            fs::create_dir_all(&album).unwrap();

            let external = dir.path().join("external");
            fs::create_dir(&external).unwrap();
            fs::write(external.join("deep.mp3"), b"fake").unwrap();

            // 深层链接：music/Artist/Album/deep-link → external
            let link = album.join("deep-link");
            symlink(&external, &link).unwrap();

            let music_str = music.canonicalize().unwrap().to_string_lossy().to_string();
            let targets = get_secondary_targets(&music_str);

            assert!(
                targets.contains(&external.canonicalize().unwrap()),
                "深层符号链接的目标也必须进白名单，否则歌曲会变成幽灵歌"
            );

            // 以链接路径形式入库的歌曲，校验必须通过
            let linked_song = link.join("deep.mp3");
            assert!(is_path_in_music_folder(
                &linked_song.to_string_lossy(),
                &music_str,
                &targets
            ));
        }

        #[test]
        fn symlink_cycle_does_not_hang() {
            // 只对真实目录递归、遇到链接不进入，因此链接成环也不会无限递归
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            let sub = music.join("sub");
            fs::create_dir_all(&sub).unwrap();
            // sub/loop → music（指回祖先）
            symlink(&music, sub.join("loop")).unwrap();

            let music_str = music.canonicalize().unwrap().to_string_lossy().to_string();
            let targets = get_secondary_targets(&music_str);

            // 能正常返回即说明没有死循环；环本身作为目标被登记
            assert_eq!(targets, vec![music.canonicalize().unwrap()]);
        }

        #[test]
        fn invalidation_makes_new_symlink_visible() {
            // 回归：白名单有进程内缓存，若新增链接后不失效，
            // 该链接下的歌曲会在缓存过期前被判越权（Access denied）。
            //
            // 注意：这里**不**断言「未失效时一定命中缓存」—— 缓存是全局 static
            // 且测试并行执行，命中与否取决于其他测试是否覆盖过条目，断言它会 flaky。
            // 真正要保证的是：失效之后必须能识别到新的链接。
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            fs::create_dir_all(&music).unwrap();
            let external = dir.path().join("external");
            fs::create_dir_all(&external).unwrap();

            let music_str = music.canonicalize().unwrap().to_string_lossy().to_string();

            // 先调用一次（无论是否写入缓存）
            let _ = get_secondary_targets(&music_str);

            // 新增链接后失效缓存
            let link = music.join("new-link");
            symlink(&external, &link).unwrap();
            invalidate_secondary_targets_cache();

            assert_eq!(
                get_secondary_targets(&music_str),
                vec![external.canonicalize().unwrap()],
                "失效后必须能识别到新增的符号链接"
            );
        }

        #[test]
        fn cache_is_keyed_by_music_folder() {
            // 不同目录不能串用缓存（否则会拿 A 的白名单去校验 B 的路径）
            let dir = tempdir().unwrap();
            let music_a = dir.path().join("music-a");
            let music_b = dir.path().join("music-b");
            fs::create_dir_all(&music_a).unwrap();
            fs::create_dir_all(&music_b).unwrap();

            let external = dir.path().join("external");
            fs::create_dir_all(&external).unwrap();
            // 只在 b 下建链接
            symlink(&external, music_b.join("link")).unwrap();

            let a_str = music_a
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let b_str = music_b
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .to_string();

            // 交替查询：a 的结果不应污染 b（反之亦然）
            assert!(get_secondary_targets(&a_str).is_empty());
            assert_eq!(
                get_secondary_targets(&b_str),
                vec![external.canonicalize().unwrap()],
                "b 目录的白名单不能受 a 的缓存影响"
            );
            assert!(
                get_secondary_targets(&a_str).is_empty(),
                "回查 a 仍应为空（结果只取决于 a 自身）"
            );
        }

        #[test]
        fn filter_paths_in_music_folder_matches_single_check() {
            // 批量变体必须与逐个校验结果一致（它只是把 music_folder 的
            // canonicalize 提到循环外，判定逻辑不变）
            let dir = tempdir().unwrap();
            let music = dir.path().join("music");
            fs::create_dir_all(&music).unwrap();
            fs::write(music.join("inside.mp3"), b"x").unwrap();

            let outside = dir.path().join("outside");
            fs::create_dir_all(&outside).unwrap();
            fs::write(outside.join("forbidden.mp3"), b"x").unwrap();

            let music_str = music.canonicalize().unwrap().to_string_lossy().to_string();
            let targets = get_secondary_targets(&music_str);

            let paths = vec![
                music.join("inside.mp3").to_string_lossy().to_string(),
                outside.join("forbidden.mp3").to_string_lossy().to_string(),
            ];

            let filtered = filter_paths_in_music_folder(&paths, &music_str, &targets);
            let expected: Vec<String> = paths
                .iter()
                .filter(|p| is_path_in_music_folder(p, &music_str, &targets))
                .cloned()
                .collect();

            assert_eq!(filtered, expected);
            assert_eq!(filtered.len(), 1, "只应放行音乐文件夹内的路径");
        }

        #[test]
        fn filter_paths_returns_empty_when_folder_unresolvable() {
            // music_folder 无法 canonicalize（不存在）时，批量校验必须全部拒绝，
            // 不能因为「基准解析失败」而意外放行
            let paths = vec!["/music/a.mp3".to_string()];
            assert!(filter_paths_in_music_folder(&paths, "/no-such-folder-xyz", &[]).is_empty());
        }
    }
}
