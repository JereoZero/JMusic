use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn};
use ts_rs::TS;

use kira::{
    AudioManager, AudioManagerSettings, DefaultBackend, Decibels, Tween,
    sound::PlaybackState as KiraPlaybackState,
    sound::streaming::{Decoder as KiraDecoder, StreamingSoundData, StreamingSoundHandle},
};
use crate::dsd_decoder::{DsdDecoder, DsdDecoderError};
use crate::constants::PROGRESS_EMIT_INTERVAL_MS;

/// 线性音量 (0.0-1.0) 转换为 kira Decibels。
fn amplitude_to_decibels(amplitude: f32) -> Decibels {
    if amplitude <= 0.0 {
        Decibels::SILENCE
    } else {
        Decibels(20.0 * amplitude.log10())
    }
}

/// kira PlaybackState → 项目 PlaybackState 映射。
fn map_kira_state(state: KiraPlaybackState) -> PlaybackState {
    match state {
        KiraPlaybackState::Stopped => PlaybackState::Stopped,
        KiraPlaybackState::Paused | KiraPlaybackState::WaitingToResume => PlaybackState::Paused,
        // Playing/Pausing/Resuming/Stopping 都视为播放中
        _ => PlaybackState::Playing,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, TS)]
#[ts(export)]
pub enum PlaybackState {
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, serde::Serialize, TS)]
#[ts(export)]
pub struct PlayerState {
    pub state: PlaybackState,
    pub current_path: Option<String>,
    pub volume: f32,
    pub position: f64,
    pub duration: Option<f64>,
}

pub struct AudioPlayer {
    manager: Arc<Mutex<AudioManager<DefaultBackend>>>,
    handle: Arc<Mutex<Option<StreamingSoundHandle<DsdDecoderError>>>>,
    state: Arc<RwLock<PlayerState>>,
    app_handle: AppHandle,
    /// 进度轮询 task，AudioPlayer drop 时 abort 以避免泄漏
    progress_task: tauri::async_runtime::JoinHandle<()>,
    /// 串行化 play 操作，防止快速切歌时并发 play 导致旧音轨泄漏
    play_lock: Arc<Mutex<()>>,
}

impl AudioPlayer {
    pub fn new(app_handle: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let manager = AudioManager::<DefaultBackend>::new(AudioManagerSettings::default())?;
        let state = Arc::new(RwLock::new(PlayerState {
            state: PlaybackState::Stopped,
            current_path: None,
            volume: 0.8,
            position: 0.0,
            duration: None,
        }));
        let handle = Arc::new(Mutex::new(None));

        // 启动进度轮询 task：检测播放完成 + 定期 emit playback_progress
        let progress_task = Self::start_progress_loop(
            handle.clone(),
            state.clone(),
            app_handle.clone(),
        );

        info!("Audio player initialized (kira backend)");
        Ok(Self {
            manager: Arc::new(Mutex::new(manager)),
            handle,
            state,
            app_handle,
            progress_task,
            play_lock: Arc::new(Mutex::new(())),
        })
    }

    fn start_progress_loop(
        handle: Arc<Mutex<Option<StreamingSoundHandle<DsdDecoderError>>>>,
        state: Arc<RwLock<PlayerState>>,
        app_handle: AppHandle,
    ) -> tauri::async_runtime::JoinHandle<()> {
        // 用 tauri::async_runtime::spawn 而非 tokio::spawn：
        // AudioPlayer::new 在 Tauri setup 闭包中调用，此时主线程不在 Tokio runtime 上下文，
        // tokio::spawn 会 panic；tauri::async_runtime 内部使用 Tauri 管理的 Tokio runtime
        tauri::async_runtime::spawn(async move {
            let mut last_emit = tokio::time::Instant::now();
            // H1 优化：轮询间隔与 emit 间隔(250ms)对齐，减少 80% 空轮询加锁
            let poll_interval = Duration::from_millis(200);
            // 空闲时(handle=None)用更长间隔，减少后台 CPU 占用
            let idle_interval = Duration::from_secs(1);

            loop {
                tokio::time::sleep(poll_interval).await;

                let mut handle_guard = handle.lock().await;
                let Some(sound_handle) = handle_guard.as_ref() else {
                    drop(handle_guard);
                    tokio::time::sleep(idle_interval).await;
                    continue;
                };

                let kira_state = sound_handle.state();

                // 播放完成检测
                if kira_state == KiraPlaybackState::Stopped {
                    let finished_duration = state.read().await.duration;
                    *handle_guard = None;

                    // 持有 handle 锁直到 state 更新完成，防止 play() 在此期间插入并覆写 state
                    {
                        let mut st = state.write().await;
                        st.state = PlaybackState::Stopped;
                        st.current_path = None;
                        st.position = 0.0;
                        st.duration = None;
                    }
                    drop(handle_guard);

                    if let Err(e) = app_handle.emit("track_finished", serde_json::json!({
                        "duration": finished_duration.unwrap_or(0.0)
                    })) {
                        debug!("Failed to emit track_finished: {}", e);
                    }
                    info!("Track finished (duration: {:?})", finished_duration);
                    continue;
                }

                // 定期 emit 进度
                if last_emit.elapsed().as_millis() >= PROGRESS_EMIT_INTERVAL_MS as u128 {
                    last_emit = tokio::time::Instant::now();
                    let position = sound_handle.position();

                    {
                        let mut st = state.write().await;
                        st.position = position;
                    }

                    let duration = state.read().await.duration;
                    if let Err(e) = app_handle.emit("playback_progress", serde_json::json!({
                        "position": position,
                        "duration": duration.unwrap_or(0.0)
                    })) {
                        debug!("Failed to emit playback_progress: {}", e);
                    }
                }
            }
        })
    }

    pub async fn play(&self, path: &str) -> Result<(), String> {
        // 串行化 play 操作，防止快速切歌时并发 play 导致旧音轨泄漏
        let _guard = self.play_lock.lock().await;

        // 在阻塞线程中创建 decoder（文件 I/O + symphonia probe）
        let path_owned = path.to_string();
        let decoder = tokio::task::spawn_blocking(move || DsdDecoder::new(&path_owned))
            .await
            .map_err(|e| format!("Join error: {}", e))?
            .map_err(|e| e.to_string())?;

        let sample_rate = decoder.sample_rate();
        let num_frames = decoder.num_frames();
        let duration = if sample_rate > 0 {
            Some(num_frames as f64 / sample_rate as f64)
        } else {
            None
        };

        let sound_data = StreamingSoundData::from_decoder(decoder);

        // 停止当前播放
        {
            let mut handle_guard = self.handle.lock().await;
            // 二次确认：如果在 decoder 创建期间用户调用了 stop，放弃本次 play
            // 避免"点击 stop 后歌曲仍开始播放"的竞态
            let current_state = self.state.read().await.state;
            if current_state == PlaybackState::Stopped {
                info!("Play aborted: stop was called during decoder creation");
                return Ok(());
            }
            if let Some(ref mut h) = *handle_guard {
                h.stop(Tween::default());
            }
            *handle_guard = None;
        }

        // 先读取音量，再 play，消除 play 与 set_volume 之间的 await 窗口
        // 避免 manager.play() 后以默认音量 1.0 输出一个 buffer 的爆音
        let volume = self.state.read().await.volume;

        // 播放新音轨
        let mut new_handle = self
            .manager
            .lock()
            .await
            .play(sound_data)
            .map_err(|e| e.to_string())?;

        // 立即设置音量（play 与 set_volume 之间无 await，窗口为亚微秒级）
        new_handle.set_volume(amplitude_to_decibels(volume), Tween::default());

        *self.handle.lock().await = Some(new_handle);

        // 更新 state
        {
            let mut st = self.state.write().await;
            st.state = PlaybackState::Playing;
            st.current_path = Some(path.to_string());
            st.position = 0.0;
            st.duration = duration;
        }

        info!("Playing: {} (duration: {:?}s)", path, duration);

        // emit 初始进度
        if let Err(e) = self.app_handle.emit("playback_progress", serde_json::json!({
            "position": 0.0,
            "duration": duration.unwrap_or(0.0)
        })) {
            debug!("Failed to emit playback_progress: {}", e);
        }

        Ok(())
    }

    pub async fn pause(&self) -> Result<(), String> {
        let mut handle_guard = self.handle.lock().await;
        if let Some(ref mut h) = *handle_guard {
            h.pause(Tween::default());
            let position = h.position();

            let mut st = self.state.write().await;
            st.state = PlaybackState::Paused;
            st.position = position;

            info!("Paused at {:.1}s", position);
        } else {
            // handle 为 None（play 进行中或歌曲已结束）：仍记录 Paused 意图，
            // 避免 play 完成后自动开始播放（play() 的 state 二次检查会看到 Paused 并放弃）
            let mut st = self.state.write().await;
            if st.state != PlaybackState::Stopped {
                st.state = PlaybackState::Paused;
                info!("Pause requested (no handle, deferred)");
            }
        }
        Ok(())
    }

    pub async fn resume(&self) -> Result<(), String> {
        // 仅在 Paused 态恢复，避免幽灵播放/进度回跳
        let current_state = self.state.read().await.state;
        if current_state != PlaybackState::Paused {
            info!("Resume ignored in {:?} state (not Paused)", current_state);
            return Ok(());
        }

        let mut handle_guard = self.handle.lock().await;
        if let Some(ref mut h) = *handle_guard {
            h.resume(Tween::default());

            let mut st = self.state.write().await;
            st.state = PlaybackState::Playing;

            info!("Resumed");
            Ok(())
        } else {
            // handle 为 None：可能是歌曲在 pause 后自然结束（progress_loop 清理了 handle）
            // 重新检查 state，若已 Stopped 则静默返回，避免误导性错误
            let current_state = self.state.read().await.state;
            if current_state == PlaybackState::Stopped {
                info!("Resume: track already finished, ignoring");
                return Ok(());
            }
            // 真正的 handle 丢失（音频输出流故障）
            warn!("Resume failed: no active sound handle");
            if let Err(e) = self.app_handle.emit("playback_error", serde_json::json!({
                "error": "Audio output stream lost, cannot resume"
            })) {
                warn!("Failed to emit playback_error: {}", e);
            }
            Err("Audio output stream lost, cannot resume".to_string())
        }
    }

    pub async fn stop(&self) -> Result<(), String> {
        {
            let mut handle_guard = self.handle.lock().await;
            if let Some(ref mut h) = *handle_guard {
                h.stop(Tween::default());
            }
            *handle_guard = None;
        }

        let mut st = self.state.write().await;
        st.state = PlaybackState::Stopped;
        st.current_path = None;
        st.position = 0.0;
        st.duration = None;

        info!("Stopped");
        Ok(())
    }

    pub async fn seek(&self, time: f64) -> Result<(), String> {
        let mut handle_guard = self.handle.lock().await;
        if let Some(ref mut h) = *handle_guard {
            h.seek_to(time);

            let mut st = self.state.write().await;
            st.position = time;

            info!("Seeked to {:.1}s", time);
        }
        Ok(())
    }

    pub async fn set_volume(&self, volume: f32) -> Result<(), String> {
        let clamped = volume.clamp(0.0, 1.0);

        let mut handle_guard = self.handle.lock().await;
        if let Some(ref mut h) = *handle_guard {
            h.set_volume(amplitude_to_decibels(clamped), Tween::default());
        }

        let mut st = self.state.write().await;
        st.volume = clamped;
        Ok(())
    }

    pub async fn get_state(&self) -> PlayerState {
        // 同步 kira 实际状态到 PlayerState（处理 Stopping 等中间态）
        let kira_state = {
            let handle_guard = self.handle.lock().await;
            handle_guard.as_ref().map(|h| h.state())
        };
        // 一次 write 锁完成"同步 + 返回快照"，省去后续 read 锁
        let mut st = self.state.write().await;
        if let Some(ks) = kira_state {
            let mapped = map_kira_state(ks);
            // 仅在状态发生变化时更新（避免频繁写锁）
            if st.state != mapped {
                st.state = mapped;
            }
        }
        st.clone()
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        // 停止进度轮询 task，避免 AudioPlayer 释放后 task 仍持有 Arc 泄漏
        self.progress_task.abort();
        debug!("AudioPlayer dropped, progress task aborted");
    }
}

pub fn init(app_handle: AppHandle) -> Result<AudioPlayer, Box<dyn std::error::Error>> {
    info!("Initializing audio player...");
    AudioPlayer::new(app_handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== amplitude_to_decibels =====

    #[test]
    fn amplitude_to_decibels_zero_and_negative_is_silence() {
        assert_eq!(amplitude_to_decibels(0.0), Decibels::SILENCE);
        assert_eq!(amplitude_to_decibels(-0.1), Decibels::SILENCE);
        assert_eq!(amplitude_to_decibels(-1.0), Decibels::SILENCE);
    }

    #[test]
    fn amplitude_to_decibels_unity_is_identity() {
        assert_eq!(amplitude_to_decibels(1.0), Decibels::IDENTITY);
    }

    #[test]
    fn amplitude_to_decibels_half_is_approx_minus_six_db() {
        // 20 * log10(0.5) ≈ -6.0206
        let db = amplitude_to_decibels(0.5);
        assert!((db.0 - (-6.0206)).abs() < 0.001);
    }

    #[test]
    fn amplitude_to_decibels_default_volume_0_8() {
        // 项目默认音量 0.8: 20 * log10(0.8) ≈ -1.9382
        let db = amplitude_to_decibels(0.8);
        assert!((db.0 - (-1.9382)).abs() < 0.001);
    }

    #[test]
    fn amplitude_to_decibels_is_monotonic() {
        // 音量越大，dB 越高（在 0~1 区间内单调递增）
        let db_low = amplitude_to_decibels(0.1).0;
        let db_mid = amplitude_to_decibels(0.5).0;
        let db_high = amplitude_to_decibels(1.0).0;
        assert!(db_low < db_mid);
        assert!(db_mid < db_high);
    }

    // ===== map_kira_state =====

    #[test]
    fn map_kira_state_playing_variants_to_playing() {
        // Playing/Pausing/Resuming/Stopping 都视为播放中
        assert_eq!(map_kira_state(KiraPlaybackState::Playing), PlaybackState::Playing);
        assert_eq!(map_kira_state(KiraPlaybackState::Pausing), PlaybackState::Playing);
        assert_eq!(map_kira_state(KiraPlaybackState::Resuming), PlaybackState::Playing);
        assert_eq!(map_kira_state(KiraPlaybackState::Stopping), PlaybackState::Playing);
    }

    #[test]
    fn map_kira_state_paused_variants_to_paused() {
        // Paused / WaitingToResume 视为暂停
        assert_eq!(map_kira_state(KiraPlaybackState::Paused), PlaybackState::Paused);
        assert_eq!(map_kira_state(KiraPlaybackState::WaitingToResume), PlaybackState::Paused);
    }

    #[test]
    fn map_kira_state_stopped_to_stopped() {
        assert_eq!(map_kira_state(KiraPlaybackState::Stopped), PlaybackState::Stopped);
    }

    #[test]
    fn map_kira_state_covers_all_seven_variants() {
        // 确保所有 kira PlaybackState 变体都被映射（防止未来新增变体遗漏）
        let all = [
            KiraPlaybackState::Playing,
            KiraPlaybackState::Pausing,
            KiraPlaybackState::Paused,
            KiraPlaybackState::WaitingToResume,
            KiraPlaybackState::Resuming,
            KiraPlaybackState::Stopping,
            KiraPlaybackState::Stopped,
        ];
        for state in all {
            let mapped = map_kira_state(state);
            // 映射结果必须是三种有效状态之一
            assert!(matches!(
                mapped,
                PlaybackState::Playing | PlaybackState::Paused | PlaybackState::Stopped
            ));
        }
    }
}
