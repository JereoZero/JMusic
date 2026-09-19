use base64::{engine::general_purpose, Engine as _};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Metadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub cover: Option<String>,
}

pub struct MetadataExtractor;

impl MetadataExtractor {
    pub fn new() -> Self {
        Self
    }

    pub async fn extract(&self, path: &str) -> anyhow::Result<Metadata> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || Self::extract_blocking(&path)).await?
    }

    pub fn extract_blocking(path: &str) -> anyhow::Result<Metadata> {
        let path = Path::new(path);

        let tagged_file = Probe::open(path)?.read()?;
        let properties = tagged_file.properties();

        let duration = properties.duration().as_secs_f64();
        let bitrate = properties.audio_bitrate();
        let sample_rate = properties.sample_rate();
        let channels = properties.channels();

        let (title, artist, album) = if let Some(tag) = tagged_file.primary_tag() {
            (
                tag.title().map(|s| s.to_string()),
                tag.artist().map(|s| s.to_string()),
                tag.album().map(|s| s.to_string()),
            )
        } else {
            (None, None, None)
        };

        let cover = Self::extract_cover(&tagged_file);

        Ok(Metadata {
            title,
            artist,
            album,
            duration,
            bitrate,
            sample_rate,
            channels,
            cover,
        })
    }

    fn extract_cover(tagged_file: &lofty::file::TaggedFile) -> Option<String> {
        if let Some(tag) = tagged_file.primary_tag() {
            if let Some(picture) = tag.pictures().first() {
                return encode_cover(picture.data());
            }
        }

        for tag in tagged_file.tags() {
            if let Some(picture) = tag.pictures().first() {
                return encode_cover(picture.data());
            }
        }

        None
    }
}

/// 单张嵌入封面允许的最大解码后字节数（5 MB）。
///
/// 封面随后会被 base64 编码（膨胀 ~33%）存入 SQLite 并经 IPC 传输到前端。
/// 不设上限时，损坏或刻意构造的音频源可携带数百 MB 的 APIC 帧，导致内存/IPC/DB
/// 一起膨胀甚至拖垮应用。超限的封面直接丢弃（返回 None），不影响其余元数据。
const MAX_EMBEDDED_COVER_BYTES: usize = 5 * 1024 * 1024;

fn encode_cover(data: &[u8]) -> Option<String> {
    if data.len() > MAX_EMBEDDED_COVER_BYTES {
        tracing::debug!(
            "Skipping embedded cover: {} bytes exceeds limit {}",
            data.len(),
            MAX_EMBEDDED_COVER_BYTES
        );
        return None;
    }
    Some(general_purpose::STANDARD.encode(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_cover_accepts_normal_size() {
        let data = vec![0u8; 1024];
        let encoded = encode_cover(&data).expect("正常尺寸封面应被编码");
        assert_eq!(
            general_purpose::STANDARD.decode(encoded).unwrap(),
            data,
            "编码结果应可还原"
        );
    }

    #[test]
    fn encode_cover_rejects_oversized() {
        // 超出上限的封面必须丢弃，避免 base64 后膨胀内存/DB/IPC
        let data = vec![0u8; MAX_EMBEDDED_COVER_BYTES + 1];
        assert!(encode_cover(&data).is_none());
    }

    #[test]
    fn encode_cover_accepts_exact_limit() {
        // 边界：恰好等于上限应放行（判断用 > 而非 >=）
        let data = vec![0u8; MAX_EMBEDDED_COVER_BYTES];
        assert!(encode_cover(&data).is_some());
    }
}
