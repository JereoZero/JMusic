use chardetng::EncodingDetector;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::debug;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LyricSource {
    pub content: String,
    #[serde(rename = "type")]
    pub source: String,
}

/// 解码 .lrc 文件字节流。
///
/// **UTF-8 优先**：去掉 BOM 后若能按 UTF-8 严格解码就直接采用。
/// chardetng 对短文本/中英混排容易误判，而 UTF-8 是当前绝大多数 .lrc 的编码——
/// 先走严格 UTF-8 可避免「本来合法却被探测成其他编码」导致整篇乱码。
/// 非 UTF-8（GBK/BIG5/Shift-JIS 等遗留编码）才交给 chardetng 探测。
fn decode_lrc_content(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);

    if let Ok(text) = std::str::from_utf8(body) {
        return text.to_string();
    }

    let mut detector = EncodingDetector::new();
    detector.feed(body, true);
    let (encoding, _confident) = detector.guess_assess(None, true);
    let (decoded, _, _) = encoding.decode(body);
    decoded.to_string()
}

/// 加载与音频同名的 .lrc 文件。
///
/// ⚠️ 安全校验：`.lrc` 路径由音频路径派生，**必须独立做边界校验**——
/// 上层只校验了音频路径，而同目录下一个名为 `xxx.lrc` 的符号链接完全可能
/// 指向音乐文件夹之外（如 `/etc/passwd`），不校验就等于开放任意文件读取。
/// 这里复用 `resolve_path_in_music_folder`（校验通过时返回 canonical 路径，
/// 顺带消除「校验→打开」的 TOCTOU 窗口）。
pub fn load_lrc_file(
    audio_path: &Path,
    music_folder: &str,
    secondary_targets: &[PathBuf],
) -> Option<LyricSource> {
    for ext in ["lrc", "LRC"] {
        let candidate = audio_path.with_extension(ext);
        // 用 continue 而非 ?：首个候选不存在/校验失败时仍应继续尝试下一个扩展名
        let Some(safe_path) = crate::path_validator::resolve_path_in_music_folder(
            &candidate.to_string_lossy(),
            music_folder,
            secondary_targets,
        ) else {
            continue;
        };

        if let Some(lyrics) = load_lrc_from_path(&safe_path) {
            return Some(lyrics);
        }
    }
    None
}

fn load_lrc_from_path(lrc_path: &Path) -> Option<LyricSource> {
    let bytes = match fs::read(lrc_path) {
        Ok(b) => b,
        Err(e) => {
            debug!("Failed to read lrc file {:?}: {}", lrc_path, e);
            return None;
        }
    };
    let content = decode_lrc_content(&bytes);

    if content.trim().is_empty() {
        return None;
    }

    Some(LyricSource {
        content,
        source: "external".to_string(),
    })
}

pub fn extract_embedded_lyrics(audio_path: &Path) -> Option<LyricSource> {
    let probe = match Probe::open(audio_path) {
        Ok(p) => p,
        Err(e) => {
            debug!(
                "Failed to open audio for lyrics extraction {:?}: {}",
                audio_path, e
            );
            return None;
        }
    };
    let tagged_file = match probe.read() {
        Ok(f) => f,
        Err(e) => {
            debug!("Failed to read audio tags {:?}: {}", audio_path, e);
            return None;
        }
    };

    let tag = tagged_file.primary_tag()?;

    if let Some(lyrics_content) = tag.get_string(&ItemKey::Lyrics) {
        let content = lyrics_content.to_string();

        if !content.trim().is_empty() {
            return Some(LyricSource {
                content,
                source: "embedded".to_string(),
            });
        }
    }

    None
}

pub fn get_lyrics(
    audio_path: &Path,
    music_folder: &str,
    secondary_targets: &[PathBuf],
) -> Option<LyricSource> {
    if let Some(lrc_lyrics) = load_lrc_file(audio_path, music_folder, secondary_targets) {
        return Some(lrc_lyrics);
    }

    extract_embedded_lyrics(audio_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_utf8_with_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, b'H', b'e', b'l', b'l', b'o'];
        let decoded = decode_lrc_content(&bytes);
        assert_eq!(decoded, "Hello");
    }

    #[test]
    fn test_decode_utf8_without_bom() {
        let bytes = b"Hello World";
        let decoded = decode_lrc_content(bytes);
        assert_eq!(decoded, "Hello World");
    }

    #[test]
    fn test_decode_gbk() {
        let (encoded, _, _) =
            encoding_rs::GBK.encode("[00:01.00]\u{4F60}\u{597D}\n[00:02.00]\u{4E16}\u{754C}");
        let decoded = decode_lrc_content(&encoded);
        assert_eq!(decoded, "[00:01.00]你好\n[00:02.00]世界");
    }

    #[test]
    fn test_decode_lrc_content() {
        let lrc = "[00:00.00]First line\n[00:05.50]Second line";
        let decoded = decode_lrc_content(lrc.as_bytes());
        assert!(decoded.contains("First line"));
        assert!(decoded.contains("Second line"));
    }
}
