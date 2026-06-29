use std::path::Path;
use std::fs;
use lofty::probe::Probe;
use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use chardetng::EncodingDetector;
use tracing::debug;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LyricSource {
    pub content: String,
    #[serde(rename = "type")]
    pub source: String,
}

fn decode_lrc_content(bytes: &[u8]) -> String {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let (encoding, _confident) = detector.guess_assess(None, true);
    let (decoded, _, _) = encoding.decode(bytes);
    decoded.to_string()
}

pub fn load_lrc_file(audio_path: &Path) -> Option<LyricSource> {
    let lrc_path = audio_path.with_extension("lrc");

    if !lrc_path.exists() {
        let alt_lrc_path = audio_path.with_extension("LRC");
        if !alt_lrc_path.exists() {
            return None;
        }
        return load_lrc_from_path(&alt_lrc_path);
    }

    load_lrc_from_path(&lrc_path)
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
            debug!("Failed to open audio for lyrics extraction {:?}: {}", audio_path, e);
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

pub fn get_lyrics(audio_path: &Path) -> Option<LyricSource> {
    if let Some(lrc_lyrics) = load_lrc_file(audio_path) {
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
        let (encoded, _, _) = encoding_rs::GBK.encode("[00:01.00]\u{4F60}\u{597D}\n[00:02.00]\u{4E16}\u{754C}");
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
