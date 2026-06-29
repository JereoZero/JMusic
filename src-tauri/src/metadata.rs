use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::Serialize;
use std::path::Path;
use base64::{Engine as _, engine::general_purpose};
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
                return Some(general_purpose::STANDARD.encode(picture.data()));
            }
        }

        for tag in tagged_file.tags() {
            if let Some(picture) = tag.pictures().first() {
                return Some(general_purpose::STANDARD.encode(picture.data()));
            }
        }

        None
    }
}
