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
    #[error("Unsupported DSD sample rate: {0} Hz")]
    UnsupportedDsdSampleRate(u32),
    #[error("Unsupported channel configuration")]
    UnsupportedChannelConfiguration,
    #[error("Frame index overflow")]
    FrameIndexOverflow,
}

/// DSD → PCM 抽取后的输出采样率。
///
/// **为什么必须显式设置**：fork 的 DsdDecoder 有 PassThrough（默认）与 PCM 两种模式。
/// PassThrough 原样输出 1-bit DSD 字节（`AudioBuffer<u8>`），只适合支持原生 DSD 的声卡；
/// 必须通过 `CodecParameters::extra_data` 的前 4 字节（小端 u32）请求 PCM 输出率，
/// 才会启用 CIC + FIR 抽取（见 symphonia-codec-dsd 的 README「PCM Conversion Mode」）。
///
/// **不设置的实际后果**：本模块会把每个**字节**当成一个 8-bit PCM 采样转成 f32 帧，
/// 而 `sample_rate()` 返回的是 DSD 比特率（DSD64 = 2.8224MHz）→ kira 按比特率消费
/// 这些字节帧，播放速度变成 **8 倍**，且没有抽取低通 → 输出是刺耳噪声。
///
/// **为什么选 88.2kHz**：fork 的 `choose_decimation_ratios` 显式实现了 32 / 64 / 128 / 256
/// 四档抽取比，对应 DSD64 / DSD128 / DSD256 / DSD512 → 88.2kHz 全部命中已实现分支
/// （README 的支持列表也覆盖这四档）。而 176.4kHz 在 DSD64 下需要 16 倍抽取，
/// 只落在通用回退分支里，不在文档列出的支持集内。
const DSD_PCM_OUTPUT_RATE: u32 = 88_200;

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

        let input_rate = track
            .codec_params
            .sample_rate
            .ok_or(DsdDecoderError::UnknownSampleRate)?;
        let input_frames = track
            .codec_params
            .n_frames
            .ok_or(DsdDecoderError::UnknownFrameCount)?;
        let track_id = track.id;

        // 只有 DSD 轨道才改写 extra_data：其他格式的 extra_data 是解码器必需的私有
        // 初始化数据（如 AAC 的 AudioSpecificConfig），覆盖会破坏解码。
        let mut decoder_params = track.codec_params.clone();
        let is_dsd = track.codec_params.codec == symphonia::default::formats::CODEC_TYPE_DSD;
        let (sample_rate, num_frames) = if is_dsd {
            // 抽取比必须 ≥ 2 且能整除，否则 fork 的 DecimationConfig 会直接报错。
            // 与其让它以错误终止，不如在这里给出明确原因。
            if input_rate < DSD_PCM_OUTPUT_RATE * 2 || input_rate % DSD_PCM_OUTPUT_RATE != 0 {
                return Err(DsdDecoderError::UnsupportedDsdSampleRate(input_rate));
            }
            let total_decimation = (input_rate / DSD_PCM_OUTPUT_RATE) as u64;

            decoder_params.extra_data = Some(
                DSD_PCM_OUTPUT_RATE
                    .to_le_bytes()
                    .to_vec()
                    .into_boxed_slice(),
            );

            // n_frames 由 format-dsd 按 DSD 比特率给出（dff: bytes × 8 ÷ channels，
            // dsf: sample_count），抽取后帧数按抽取比缩小 —— 与 fork 内部对
            // output_params.n_frames 的处理保持一致。若不缩小，kira 算出的时长会短 8~256 倍。
            (DSD_PCM_OUTPUT_RATE, input_frames / total_decimation)
        } else {
            (input_rate, input_frames)
        };

        let decoder =
            symphonia::default::get_codecs().make(&decoder_params, &DecoderOptions::default())?;

        Ok(Self {
            format_reader,
            decoder,
            sample_rate,
            num_frames: num_frames
                .try_into()
                .map_err(|_| DsdDecoderError::FrameIndexOverflow)?,
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
        // 声道数为 0 才是真正的无效数据。
        0 => None,
        1 => Some(
            buffer
                .chan(0)
                .iter()
                .map(|s| Frame::from_mono((*s).into_sample()))
                .collect(),
        ),
        // 2 声道直接作为 L/R。
        // 3+ 声道（如 5.1 FLAC）有意简化为「取前两个声道作为 L/R」的下混，不做
        // center/LFE 加权：本播放器只输出立体声，加权收益有限且会改变已正确混音
        // 内容的听感。symphonia 的 `chan(i)` 仅在 `i >= 声道数` 时 assert，此分支
        // 已保证 `count() >= 2`，故 `chan(0)`/`chan(1)` 不会 panic。
        _ => Some(
            buffer
                .chan(0)
                .iter()
                .zip(buffer.chan(1).iter())
                .map(|(l, r)| Frame::new((*l).into_sample(), (*r).into_sample()))
                .collect(),
        ),
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

    /// 生成一个最小的有效 WAV 文件（44100Hz，16-bit，0.1 秒静音），`channels` 为声道数。
    ///
    /// 声道数 > 2 时写 WAVEFORMATEXTENSIBLE（fmt 块 40 字节，含 5.1 channel mask）；
    /// 单/双声道沿用普通 PCM fmt（16 字节），保持既有测试用例语义不变。
    fn create_test_wav(channels: u16) -> tempfile::NamedTempFile {
        use std::io::Write;
        const SAMPLE_RATE: u32 = 44_100;
        const BITS_PER_SAMPLE: u16 = 16;

        let num_frames = (SAMPLE_RATE as f64 * 0.1) as u32;
        let block_align: u16 = channels * (BITS_PER_SAMPLE / 8);
        let byte_rate: u32 = SAMPLE_RATE * block_align as u32;
        let data_size: u32 = num_frames * block_align as u32;

        let extensible = channels > 2;
        let fmt_size: u32 = if extensible { 40 } else { 16 };
        // "WAVE"(4) + fmt 头(8)+fmt_size + data 头(8) + data_size，再减去 RIFF 自身 8 字节
        let file_size: u32 = 20 + fmt_size + data_size;

        let mut buf = Vec::with_capacity((file_size + 8) as usize);
        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&file_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&fmt_size.to_le_bytes());
        buf.extend_from_slice(&if extensible { 0xFFFEu16 } else { 1u16 }.to_le_bytes()); // PCM / EXTENSIBLE
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes()); // bits per sample
        if extensible {
            // WAVEFORMATEXTENSIBLE 扩展：extra size=22、valid bits、channel mask、sub format GUID
            buf.extend_from_slice(&22u16.to_le_bytes());
            buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes()); // valid bits per sample
            buf.extend_from_slice(&0x3Fu32.to_le_bytes()); // 5.1: FL|FR|FC|LFE|RL|RR
                                                           // KSDATAFORMAT_SUBTYPE_PCM
            buf.extend_from_slice(&[
                0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38,
                0x9B, 0x71,
            ]);
        }
        // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        // 静音数据（全 0）
        buf.resize(buf.len() + data_size as usize, 0);

        let mut tmp = tempfile::NamedTempFile::new().expect("failed to create temp file");
        tmp.write_all(&buf).expect("failed to write wav");
        tmp.flush().expect("failed to flush");
        tmp
    }

    #[test]
    fn dsd_decoder_opens_wav_and_decodes() {
        let wav = create_test_wav(1);
        let path = wav.path().to_str().expect("non-utf8 temp path");

        let mut decoder = DsdDecoder::new(path).expect("failed to open wav");
        assert_eq!(decoder.sample_rate(), 44100);
        assert!(decoder.num_frames() > 0);

        // 解码第一个 packet，应返回非空 Vec<Frame>
        let frames = decoder.decode().expect("decode failed");
        assert!(!frames.is_empty(), "decode returned empty frame list");
    }

    #[test]
    fn dsd_decoder_downmixes_surround_wav_to_stereo() {
        // 回归：>2 声道（5.1）此前走 `_ => None` → decode 返回
        // UnsupportedChannelConfiguration → kira 置 encountered_error/mark_as_stopped →
        // 轮询误判为「正常结束」→ 前端 0 秒跳过下一首且播放次数 +1。
        // 现在应下混为立体声正常解码，且帧数与单声道一致。
        let mono = create_test_wav(1);
        let mut mono_decoder = DsdDecoder::new(mono.path().to_str().expect("non-utf8 temp path"))
            .expect("failed to open mono wav");
        let mono_frames = mono_decoder.decode().expect("mono decode failed");
        assert!(!mono_frames.is_empty());

        let wav = create_test_wav(6);
        let mut decoder = DsdDecoder::new(wav.path().to_str().expect("non-utf8 temp path"))
            .expect("failed to open 5.1 wav");
        let frames = decoder
            .decode()
            .expect("5.1 decode should downmix, not fail");

        assert!(!frames.is_empty(), "5.1 decode returned empty frame list");
        assert_eq!(frames.len(), mono_frames.len(), "下混后帧数应与单声道一致");
    }

    /// 生成一个最小的有效 DSF 文件（DSD64 立体声，2 个 block）。
    ///
    /// 用于回归「DSD 必须走 PCM 抽取模式」：PassThrough 模式下 decoder 报告的
    /// sample_rate 会是 DSD 比特率（2822400）而非抽取后的 88200。
    fn create_test_dsf() -> tempfile::NamedTempFile {
        use std::io::Write;

        const BLOCK_SIZE_PER_CHANNEL: u32 = 4096;
        const CHANNELS: u32 = 2;
        const DSD_RATE: u32 = 2_822_400; // DSD64
        const BLOCKS: u64 = 2;

        let block_size = (BLOCK_SIZE_PER_CHANNEL * CHANNELS) as u64; // 每 block 总字节数
        let data_size = block_size * BLOCKS;
        // DSF 的 sample_count 是「每声道 DSD 采样数」，即 bit 数
        let sample_count = data_size * 8 / CHANNELS as u64;
        let file_size = 28 + 52 + 12 + data_size;

        let mut buf = Vec::new();
        // DSD chunk (28 bytes)
        buf.extend_from_slice(b"DSD ");
        buf.extend_from_slice(&28u64.to_le_bytes());
        buf.extend_from_slice(&file_size.to_le_bytes());
        buf.extend_from_slice(&0u64.to_le_bytes()); // metadata pointer = 0
                                                    // fmt chunk (52 bytes)
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&52u64.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // format version
        buf.extend_from_slice(&0u32.to_le_bytes()); // format id = DSD Raw
        buf.extend_from_slice(&CHANNELS.to_le_bytes()); // channel type
        buf.extend_from_slice(&CHANNELS.to_le_bytes()); // channel num
        buf.extend_from_slice(&DSD_RATE.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // bits per sample
        buf.extend_from_slice(&sample_count.to_le_bytes());
        buf.extend_from_slice(&BLOCK_SIZE_PER_CHANNEL.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
                                                    // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(12 + data_size).to_le_bytes());
        // 0xAA = 交替位流，比全 0 更接近真实 DSD 数据
        buf.resize(buf.len() + data_size as usize, 0xAA);

        let mut tmp = tempfile::Builder::new()
            .suffix(".dsf")
            .tempfile()
            .expect("failed to create temp file");
        tmp.write_all(&buf).expect("failed to write dsf");
        tmp.flush().expect("failed to flush");
        tmp
    }

    #[test]
    fn dsd_file_decodes_as_pcm_not_passthrough() {
        // 回归：未设置 extra_data 时 fork 走 PassThrough，sample_rate 会报 DSD 比特率
        // （2822400），本模块再把每个字节当 8-bit PCM 采样 → 8 倍速 + 刺耳噪声。
        let dsf = create_test_dsf();
        let path = dsf.path().to_str().expect("non-utf8 temp path");

        let mut decoder = DsdDecoder::new(path).expect("failed to open dsf");

        assert_eq!(
            decoder.sample_rate(),
            DSD_PCM_OUTPUT_RATE,
            "DSD 必须走 PCM 抽取模式；报 2822400 说明退回了 PassThrough（8 倍速 + 噪声）"
        );

        // num_frames 必须按抽取比缩小：每声道 DSD 采样数 ÷ (2822400 / 88200) = ÷32
        let per_channel_samples = 2 * 4096 * 2 * 8 / 2; // 65536
        assert_eq!(decoder.num_frames(), per_channel_samples / 32); // 2048

        // PCM 模式下 decode 返回 F32 buffer，单 packet = 4096 字节/声道 → 32768 bit → ÷32
        let frames = decoder.decode().expect("decode failed");
        assert_eq!(frames.len(), 1024, "每 block 抽取后应为 1024 帧");
    }

    #[test]
    fn dsd_decoder_seek_returns_valid_index() {
        let wav = create_test_wav(1);
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

        let wav = create_test_wav(1);
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
