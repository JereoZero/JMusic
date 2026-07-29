use std::convert::TryInto;
use std::fs::File;

use kira::sound::streaming::Decoder as KiraDecoder;
use kira::Frame;
use symphonia::core::{
    audio::{AudioBuffer, AudioBufferRef, Signal},
    codecs::{Decoder as SymphoniaDecoder, DecoderOptions, CODEC_TYPE_NULL},
    conv::IntoSample,
    errors::Error as SymphoniaError,
    formats::{FormatReader, SeekMode, SeekTo},
    io::MediaSourceStream,
    probe::Hint,
    sample::Sample,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DsdDecoderError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Symphonia error: {0}")]
    Symphonia(#[from] SymphoniaError),
    #[error("No audio track found")]
    NoAudioTrack,
    #[error("Unknown sample rate")]
    UnknownSampleRate,
    #[error("Unknown frame count")]
    UnknownFrameCount,
    #[error("Unsupported channel configuration")]
    UnsupportedChannelConfiguration,
    #[error("Frame index overflow")]
    FrameIndexOverflow,
}

/// 使用项目已有的 symphonia 0.6.0 (M0Rf30 fork dsd-support 分支) 实现 kira Decoder trait。
///
/// kira 自带的 SymphoniaDecoder 用 symphonia 0.5.4，不支持 DSD。
/// 本 DsdDecoder 用 0.6.0 fork，支持 DSD 解码，可接入 kira 流式播放。
pub struct DsdDecoder {
    format_reader: Box<dyn FormatReader>,
    decoder: Box<dyn SymphoniaDecoder>,
    sample_rate: u32,
    num_frames: usize,
    track_id: u32,
}

impl DsdDecoder {
    pub fn new(path: &str) -> Result<Self, DsdDecoderError> {
        let file = File::open(path)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
        {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe().format(
            &hint,
            mss,
            &Default::default(),
            &Default::default(),
        )?;
        let format_reader = probed.format;

        let track = format_reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or(DsdDecoderError::NoAudioTrack)?;

        let sample_rate = track
            .codec_params
            .sample_rate
            .ok_or(DsdDecoderError::UnknownSampleRate)?;
        let num_frames = track
            .codec_params
            .n_frames
            .ok_or(DsdDecoderError::UnknownFrameCount)?
            .try_into()
            .map_err(|_| DsdDecoderError::FrameIndexOverflow)?;
        let track_id = track.id;

        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())?;

        Ok(Self {
            format_reader,
            decoder,
            sample_rate,
            num_frames,
            track_id,
        })
    }
}

impl KiraDecoder for DsdDecoder {
    type Error = DsdDecoderError;

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn num_frames(&self) -> usize {
        self.num_frames
    }

    fn decode(&mut self) -> Result<Vec<Frame>, Self::Error> {
        let packet = loop {
            let packet = self.format_reader.next_packet()?;
            if self.track_id == packet.track_id() {
                break packet;
            }
        };
        let buffer = self.decoder.decode(&packet)?;
        frames_from_buffer_ref(&buffer).ok_or(DsdDecoderError::UnsupportedChannelConfiguration)
    }

    fn seek(&mut self, index: usize) -> Result<usize, Self::Error> {
        let seeked_to = self.format_reader.seek(
            SeekMode::Accurate,
            SeekTo::TimeStamp {
                ts: index
                    .try_into()
                    .map_err(|_| DsdDecoderError::FrameIndexOverflow)?,
                track_id: self.track_id,
            },
        )?;
        // 清空 decoder 内部缓冲，避免 seek 后残留的旧 packet 导致原音重叠
        self.decoder.reset();
        seeked_to
            .actual_ts
            .try_into()
            .map_err(|_| DsdDecoderError::FrameIndexOverflow)
    }
}

/// 将 symphonia 0.6.0 的 AudioBufferRef 转换为 kira Frame 向量。
///
/// 不能复用 kira 自带的 load_frames_from_buffer_ref，因为 kira 用 symphonia 0.5.4，
/// 类型不兼容（0.6.0 的 AudioBufferRef 变体是 Cow，0.5.4 是 &）。
fn frames_from_buffer_ref(buffer: &AudioBufferRef) -> Option<Vec<Frame>> {
    match buffer {
        AudioBufferRef::U8(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::U16(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::U24(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::U32(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::S8(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::S16(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::S24(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::S32(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::F32(buf) => frames_from_buffer(&**buf),
        AudioBufferRef::F64(buf) => frames_from_buffer(&**buf),
    }
}

fn frames_from_buffer<S: Sample + IntoSample<f32>>(buffer: &AudioBuffer<S>) -> Option<Vec<Frame>> {
    match buffer.spec().channels.count() {
        1 => Some(
            buffer
                .chan(0)
                .iter()
                .map(|s| Frame::from_mono((*s).into_sample()))
                .collect(),
        ),
        2 => Some(
            buffer
                .chan(0)
                .iter()
                .zip(buffer.chan(1).iter())
                .map(|(l, r)| Frame::new((*l).into_sample(), (*r).into_sample()))
                .collect(),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsd_decoder_error_display() {
        let err = DsdDecoderError::NoAudioTrack;
        assert_eq!(err.to_string(), "No audio track found");

        let err = DsdDecoderError::UnsupportedChannelConfiguration;
        assert_eq!(err.to_string(), "Unsupported channel configuration");

        let err = DsdDecoderError::FrameIndexOverflow;
        assert_eq!(err.to_string(), "Frame index overflow");
    }

    #[test]
    fn dsd_decoder_error_from_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let dsd_err: DsdDecoderError = io_err.into();
        assert!(matches!(dsd_err, DsdDecoderError::Io(_)));
    }

    #[test]
    fn dsd_decoder_open_nonexistent_file_fails() {
        let result = DsdDecoder::new("/nonexistent/path/to/file.dsf");
        match result {
            Err(DsdDecoderError::Io(_)) => {}
            other => panic!(
                "expected DsdDecoderError::Io, got {:?}",
                other.as_ref().err()
            ),
        }
    }

    /// 生成一个最小的有效 WAV 文件（单声道，44100Hz，16-bit，0.1 秒静音）。
    fn create_test_wav() -> tempfile::NamedTempFile {
        use std::io::Write;
        let sample_rate: u32 = 44100;
        let duration_secs = 0.1;
        let num_samples = (sample_rate as f64 * duration_secs) as u32;
        let data_size = num_samples * 2; // 16-bit = 2 bytes per sample
        let file_size = 36 + data_size; // RIFF header (12) + fmt chunk (24) + data chunk header (8)

        let mut buf = Vec::with_capacity(44 + data_size as usize);
        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&file_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM format
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
                                                     // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        // 静音数据（全 0）
        buf.resize(44 + data_size as usize, 0);

        let mut tmp = tempfile::NamedTempFile::new().expect("failed to create temp file");
        tmp.write_all(&buf).expect("failed to write wav");
        tmp.flush().expect("failed to flush");
        tmp
    }

    #[test]
    fn dsd_decoder_opens_wav_and_decodes() {
        let wav = create_test_wav();
        let path = wav.path().to_str().expect("non-utf8 temp path");

        let mut decoder = DsdDecoder::new(path).expect("failed to open wav");
        assert_eq!(decoder.sample_rate(), 44100);
        assert!(decoder.num_frames() > 0);

        // 解码第一个 packet，应返回非空 Vec<Frame>
        let frames = decoder.decode().expect("decode failed");
        assert!(!frames.is_empty(), "decode returned empty frame list");
    }

    #[test]
    fn dsd_decoder_seek_returns_valid_index() {
        let wav = create_test_wav();
        let path = wav.path().to_str().expect("non-utf8 temp path");

        let mut decoder = DsdDecoder::new(path).expect("failed to open wav");
        let target = 1000usize; // seek 到第 1000 个采样
        let seeked_to = decoder.seek(target).expect("seek failed");
        // seek 到的位置应该 <= 目标位置（kira Decoder trait 语义：可以 seek 到更早的样本）
        assert!(
            seeked_to <= target,
            "seeked_to ({}) should be <= target ({})",
            seeked_to,
            target
        );
    }

    #[test]
    fn kira_streaming_sound_data_accepts_dsd_decoder() {
        use kira::sound::streaming::StreamingSoundData;

        let wav = create_test_wav();
        let path = wav.path().to_str().expect("non-utf8 temp path");

        let decoder = DsdDecoder::new(path).expect("failed to open wav");
        let expected_sample_rate = decoder.sample_rate();
        let sound_data: StreamingSoundData<DsdDecoderError> =
            StreamingSoundData::from_decoder(decoder);

        // 验证 kira 能读取 DsdDecoder 的元数据
        assert!(sound_data.num_frames() > 0);
        // duration = num_frames / sample_rate，应接近 0.1 秒
        let duration = sound_data.duration().as_secs_f64();
        assert!(
            duration > 0.0,
            "duration should be positive, got {}",
            duration
        );
        let expected_duration = sound_data.num_frames() as f64 / expected_sample_rate as f64;
        assert!(
            (duration - expected_duration).abs() < 0.001,
            "duration {} should match expected {}",
            duration,
            expected_duration
        );
    }
}
