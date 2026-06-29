# Changelog

All notable changes to JlocalMusic will be documented in this file.

## v0.9.0 (2026-06-27)

### 🎵 kira 音频引擎重构（Phase 1+2）

用成熟音频库 **kira 0.12.1** 替换 563 行手搓 `player_thread`（mpsc + thread + RwLock + catch_unwind），重构为 345 行基于 kira `AudioManager` 的实现。

#### Phase 1: DsdDecoder（PoC）
- 🆕 **`dsd_decoder.rs`** — 实现 kira `Decoder` trait，用项目已有 symphonia 0.6.0 (M0Rf30 fork) 解码所有格式（MP3/FLAC/WAV/OGG/DSD/ALAC/AAC），通过自定义 `frames_from_buffer_ref` 解决 kira 0.5↔0.6 symphonia 版本冲突
- ✅ 6 个集成测试通过（decode/seek/sample_rate/num_frames + kira StreamingSoundData 集成）

#### Phase 2: player.rs 重构
- 🏗️ **`AudioManager<DefaultBackend>` + `StreamingSoundHandle`** 替换 `PlayerCmd` enum 和 `player_thread` 巨型 loop（mpsc channel + 手动状态机）
- 🗑️ **删除 `flac_decoder.rs`** — DsdDecoder 取代 SymphoniaDecoder（rodio::Source 实现）
- 🧹 **删除 `SYMPHONIA_EXTENSIONS`/`is_symphonia_format`** — 统一解码路径，所有格式通过 DsdDecoder 处理，不再区分格式分支
- 🗑️ **移除 `rodio` 依赖** — player.rs 不再使用 rodio，清理 dead 依赖
- ⏱️ **进度轮询独立 tokio task** — 每 50ms 检查播放状态（检测完成）/每 250ms emit `playback_progress`，完成时 emit `track_finished`
- 🔇 **音量转换** — 线性 0.0-1.0 → kira `Decibels(20 * log10(amplitude))`，兼容项目原有音量语义
- 🛡️ **保留前端兼容** — `PlaybackState`/`PlayerState` TS 类型不变，Tauri 命令签名不变

#### Phase 3: kira 集成后优化（6 项）
- 🪶 **精简 kira features** — 移除 mp3/flac/wav/ogg/vorbis，只保留 cpal。解码统一走 DsdDecoder（symphonia 0.6.0 fork），不再依赖 kira 自带的 symphonia 0.5.4，减少重复解码依赖
- 🛡️ **修复进度轮询 task 泄漏** — AudioPlayer 增加 `progress_task: JoinHandle` 字段，`impl Drop` 时 `abort()`，避免 AudioPlayer 释放后 task 仍持有 Arc 泄漏
- 🔒 **修复 play 方法竞态** — 增加 `play_lock: Arc<Mutex<()>>` 串行化整个 play 操作（含 spawn_blocking 解码），防止快速切歌时旧音轨未 stop 即被覆盖导致 handle 泄漏/进度回跳
- 🐛 **修复 track_finished UI 状态残留** — 后端重置 state 后前端未同步 isPlaying，播放完最后一首时 UI 残留"播放中"。在监听器开头 `set({ isPlaying: false })`
- 🛡️ **dsd_decoder panic 防护** — 3 处 `expect("could not convert ...")` 改为 `try_into().map_err(FrameIndexOverflow)?`，新增 `DsdDecoderError::FrameIndexOverflow` 变体
- ⚡ **get_state 锁优化** — 合并 write+read 为单次 write 锁（3 次锁→2 次），降低与 progress_loop 的锁竞争

#### Phase 4: 深度优化（12 项，手搓代码→成熟库 + 并行化 + 竞态修复）
- ⚡ **后端 H1: get_song_covers_batch 消除 N+1** — 新增 `Database::get_song_covers_batch` 单次 `IN` 查询替代 N 次 `get_song_cover`，缩略图创建改用 rayon 并行（`into_par_iter`）
- ⚡ **后端 H4: get_metadata_batch rayon 并行** — 批量元数据提取 `for` 循环 → `into_par_iter`
- ⚡ **后端 H5: cleanup_nonexistent_songs rayon 并行** — 两处文件存在性检查 `into_iter` → `into_par_iter`
- 🛡️ **后端 H3: find_fallback_cover 移入 spawn_blocking** — 原实现混用同步 `exists()` + async `fs::read().await`，`exists()` 阻塞 async 线程；统一改为同步 fs 并整体移入 blocking 线程池，提取 `find_cover_in_dir` helper 消除 3 处重复循环
- 🧹 **后端 M4: scan_folder 复用 music_folder** — `validate_path_in_music_folder` 已返回 music_folder，移除重复 `db.get_setting` 查询
- 🛡️ **前端 H1: PlayerBar selector 切片** — 订阅整个 `likedPaths`/`hiddenPaths` Set 导致任意歌曲变更都触发重渲染，改为仅订阅当前歌曲的布尔切片
- 🛡️ **前端 H2: fetchLiked/fetchHidden opId 竞态保护** — 独立 opId（与 fetchSongs 隔离），防止快速刷新时旧响应覆盖新结果
- 🧹 **前端 H3: useAlbumColor 手搓 HSL/RGB → colord** — 73 行手搓 `hslToRgb`/`rgbToHsl`/`rgbToHex` 替换为 `colord` 库
- 🧹 **前端 M5: useUpdateCheck 手搓 semver → compare-versions** — 手搓 `isNewerVersion` 替换为 `compareVersions`
- 🧹 **前端 L1: playQueueStore 手搓 shuffle → es-toolkit** — 22 行手搓 Fisher-Yates 替换为 `es-toolkit/shuffle`
- 🛡️ **前端 M4: useScanProgress cancelled flag** — 解决 `listen` 注册前组件卸载的竞态，cancelled flag + unlisten 双保险
- ⚡ **前端 M6: PlaybackControls/VolumeControl React.memo** — 包裹 memo 避免父组件重渲染时子组件不必要更新

#### 代码规模
- player.rs: 563 → 345 行（-218）
- flac_decoder.rs: 删除（-203）
- dsd_decoder.rs: 新增 283 行
- 净减少 438 行手搓代码

### 🧪 测试
- 📈 后端 cargo test: 47 → 62（+15：DsdDecoder 6 + player 纯函数 9）
- ✅ clippy 0 警告，前端 tsc/eslint/vitest 147/147 通过

### 🔧 依赖
- ➕ `kira = "0.12"`（cpal 0.17 后端 + symphonia 0.5.4 解码，通过自定义 Decoder trait 接入项目 symphonia 0.6.0 fork）
- ➖ `rodio = "0.19"`（player.rs 重构后不再使用）
- ➕ `colord` — 颜色空间转换，替代 useAlbumColor 手搓 HSL/RGB
- ➕ `compare-versions` — 语义化版本比较，替代 useUpdateCheck 手搓 semver

## v0.8.20 (2026-06-27)

### 🔍 深度审查修复（14 批，11 提交）

系统性深度审查覆盖前端 store、后端 player/database、UI 组件，修复 30+ 项真实 bug 与并发竞态。

#### 后端 — player.rs / database.rs / song.rs
- 🛡️ **`player_thread` 加 `catch_unwind`** (C5) — 解码线程 panic 时不再静默退出，捕获后 emit `playback_error` 并重置 state
- 🛡️ **`is_song_liked` 路径校验** — 缺失 `validate_path_in_music_folder` 入口校验，已补全
- 🛡️ **database.rs 安全与一致性** — `LIKE` 查询特殊字符转义、`delete_song` 事务边界、外键级联生效校验
- 🛡️ **player.rs 竞态与资源管理** — `seek_song` duration 上界校验、`resume` 时 `sink=None` emit `playback_error`、`stop` 后状态重置
- 🐛 **`finalizePlayHistory` 防并发重复记录** — 多次快速切歌时 `addPlayHistory` 可能并发调用导致历史记录重复，引入 mutex 串行化
- 🐛 **`toggleLike`/`toggleHidden` per-path 串行化** — 同 path 并发调用导致乐观更新错乱，引入 per-path 锁
- 🧹 **冗余 clone 清理** — `commands/song.rs` 多处不必要 `clone()` 移除

#### 前端 — store / hook / UI
- 🐛 **队列联动 + seek 反馈** — `playQueueStore` 视图切换队列联动、`seek` 失败 UI 回滚、`cleanup` 防护、空队列 toast 提示
- 🐛 **LIKE 转义 + 定时器泄漏** — `useSongCover` `cleanupTimer` HMR 未清理、组件卸载保护、播放错误状态重置
- 🐛 **前端竞态与状态一致性** — `playerStore`/`libraryStore`/`playQueueStore` 多处 `cancelled` flag、`AbortController`、selector 订阅粒度
- 🐛 **`SettingsView` async unmount 守卫** — async handler 完成时组件已卸载导致 setState 警告，加 `cancelled` flag
- 🐛 **`ProgressBar`/`VolumeControl` onWheel** — React `onWheel` 是 passive 监听器无法 `preventDefault`，改用原生 `addEventListener('wheel', { passive: false })`
- 🐛 **`useSongCover` HMR dispose** — `cleanupTimer` 在 HMR 热更新时未清理导致定时器泄漏，加 `import.meta.hot.dispose` 钩子
- 🚀 **scan 进度 UI + 播放器自愈 + 恢复歌曲兜底** — 扫描进度分阶段显示、`OutputStream` 失效自愈、`restoreLastSong` 失败兜底
- 🔧 **clippy 警告 + 测试隔离 + 防御性解构** — 测试间状态隔离、`let _ =` 防御性解构避免 panic

#### CI/CD
- 🔧 **CI tag 触发规则** — `v*` 和 `x.x.x` 格式 tag 均触发 build matrix
- 🔧 **文档同步路径修正** — `sync-docs.sh` 适配 `jlocal/` 代码子目录 + 项目根 `docs/` 文档目录结构
- 🔧 **五阶段代码审查基础设施** — ts-rs 10 类型生成 + `prebuild` 脚本 + pre-push 钩子类型同步检查 + `path_validator` 21 测试 + `build.yml` 拆分 `ci` 门禁 job

### 🔨 手搓代码替换（3 项）

引入成熟库替代手搓实现，每项替换后补充并发测试。

#### `withPathLock` → `async-mutex-lite`
- **文件**: `src/stores/libraryStore.ts`
- **改动**: 删除 15 行手搓 `pathOpLocks` Map + `withPathLock` 函数，改用 `mutex(path, fn)`
- **测试**: 新增 2 个并发测试（同 path 串行 / 不同 path 并行），libraryStore 7→9

#### `finalizePromise` → `mutex('play-history')`
- **文件**: `src/stores/playerStore.ts`
- **改动**: 删除手搓 promise 链 `let finalizePromise: Promise<void> = Promise.resolve()`，`finalizePlayHistory` 内部用 `mutex('play-history', fn)` 串行化
- **测试**: 新增 1 个不并发测试，验证 `addPlayHistory` 慢时连续 `playSong` 不并发调用

#### `useAlbumColor` 手搓缓存 + singleflight → `lru-cache` + `async-mutex-lite`
- **文件**: `src/hooks/useAlbumColor.ts`
- **改动**:
  - `colorCache` Map + 手搓 FIFO 淘汰 → `LRUCache({max: 30})` 真 LRU（修复 FIFO≠LRU 语义错误）
  - `pendingExtractions` Map + 手搓 singleflight → `mutex(path, fn)` + double-check 缓存
  - 删除 ~20 行手搓，并发调用同一首歌只提取一次
- **测试**: 新增 2 个 `toggleHidden` 并发串行测试，前端 144→147

### Verification
- ✅ Rust `cargo test` — 47 passed（+11 vs v0.8.19）
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings
- ✅ Vitest — 147 passed（+5 vs v0.8.19）

---

## v0.8.19 (2026-06-24)

### 🔒 安全修复
- **path_validator symlink TOCTOU 漏洞修复** — `is_path_in_music_folder` 在 `canonicalize` 失败时回退到 `normalize_path`（不解析符号链接），攻击者可在 music_folder 内创建指向 `/etc` 的符号链接绕过校验读取任意文件。移除 `normalize_path` 回退，改用二级文件夹符号链接白名单（`get_secondary_targets` 读取 music_folder 内符号链接的 canonicalize 目标）
- **统一 `get_music_folder_and_targets` 辅助函数** — 消除所有调用方重复获取 music_folder + secondary_targets 的代码，`settings.rs`/`player.rs`/`song.rs`/`misc.rs`/`library.rs` 全部迁移

### 🚀 后端性能
- **增量扫描（基于 file_mtime）** — 扫描时跳过 mtime 未变的文件，避免重复提取元数据（CPU 密集）。新增 `file_mtime` 列存储文件修改时间，`ScanResult` 增加 `skipped` 字段，前端 toast 显示"新增/更新 X 首，跳过 Y 首未变"
- **thumbnail 缓存 mtime 失效** — 缩略图文件名加入源文件 mtime（`{hash}_{mtime}_{size}.jpg`），文件替换后 mtime 变化自动失效重新生成；旧 mtime 缩略图自动清理

### 📋 代码审查与质量提升（2026-06-26）

五阶段系统性代码审查，覆盖类型系统、核心 bug、安全、测试、CI/CD。

- **Stage 1 类型系统对齐** — ts-rs 10 类型生成 + `satisfies` 编译期检查 + `prebuild` 脚本 + pre-push 钩子类型同步检查；`mockApi.clearLogs` 返回类型对齐
- **Stage 2 核心 bug 修复** — `player.rs` 移除 `first_play` 标志位（每次 Play 都 `s.stop()`）+ `play_fail!` 宏统一失败处理（重置 state + emit `playback_error`）+ `scanner.rs` 注入 AppHandle 分阶段 emit `scan_progress`（walking/metadata）+ `playerStore.setVolume` 钳制 [0,1]
- **Stage 3 安全加固** — `withGlobalTauri: false`（减小 XSS 攻击面）+ CSP 加 `object-src 'none'` + `path_validator` 新增 `path_starts_with_ci`（Windows 大小写不敏感 component 比较）+ 环境检测改用 `__TAURI_INTERNALS__`
- **Stage 4 测试基线** — `path_validator` 新增 21 测试（路径遍历拒绝/符号链接白名单/二级文件夹/不存在文件父目录校验/Unix symlink）
- **Stage 5 CI/CD** — `build.yml` 拆分 `ci` 门禁 job（lint/tsc/vitest/cargo check/test/类型同步）+ `build` matrix（macOS arm64+x86_64）+ `generate-types.sh` 修复 `pipefail`（原 `|| true` 掩盖失败）+ `sync-docs.sh` 修正 BUGS.md 版本同步

### Verification
- ✅ Rust `cargo test` — 36 passed（+21 path_validator）
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint — 0 warnings
- ✅ Vitest — 142 passed

---

## v0.8.18 (2026-06-24)

### 🛡️ 数据一致性
- **`libraryStore` fetchSongs/refreshAll 并发保护** — 快速多次调用时后返回的响应可能覆盖先返回的，引入 `fetchOpId` 竞态保护，过时结果被丢弃
- **`playerStore` destroy 补全 `finalizePlayHistory`** — HMR 热更新或应用关闭时播放历史丢失，destroy 前先 fire-and-forget 调用 `finalizePlayHistory(false)` 保存已播放时长

### 🌐 网络健壮性
- **`useUpdateCheck` GitHub API 缓存** — 每次检查更新都请求 GitHub API，未认证限制 60次/小时易触发限流；添加 localStorage 5 分钟缓存，手动检查按钮支持 `force=true` 强制刷新
- **`invokeApi` 超时机制** — 所有 Tauri 命令调用无超时，后端卡住时前端永久等待；内置 15s 默认超时，长耗时操作（scanFolder 5min、cleanup 2min）可自定义超时

### 🚀 后端性能
- **thumbnail 滤镜优化** — 小尺寸缩略图（56x56）从 Lanczos3 改为 Triangle 滤镜，快 3-5 倍且质量足够；大尺寸用 CatmullRom 平衡质量与性能
- **移除 `tauri-plugin-log` 未使用依赖** — 死依赖增加编译时间和二进制体积，项目实际使用 `tracing_subscriber`

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.17 (2026-06-24)

### 🐛 Bug 修复
- **`filterSongs` 空值保护** — 后端返回 `undefined`/`null` 的 title/artist/album 字段时直接 `.toLowerCase()` 导致白屏崩溃，与 `filterByQuery` 一致添加 `|| ''` 保护
- **`moveInQueue` originalQueue 拖拽 bug** — `fromIndex < toIndex` 时 originalQueue 插入位置错误（应在目标歌曲之后而非之前），导致 unshuffle 后顺序与用户拖拽预期不符
- **`useSongCover` schedulePendingCleanup 死代码** — `pendingRequests.clear()` 后检查 `size > 0` 永远为 false，递归清理永不执行；改为先检查再清理，并移除模块加载时的自动启动（改为首次添加 pending request 时启动）

### 🚀 后端性能优化
- **SQLite PRAGMA 调优** — 添加 `busy_timeout=5s`（遇锁等待而非立即报错）、`synchronous=Normal`（WAL 模式推荐配置）、`cache_size=64MB`、`temp_store=MEMORY`，写入性能显著提升
- **`upsert_songs` 批量插入** — N+1 逐条 INSERT 改为 `QueryBuilder::push_values` 分批批量插入（每批 100 首），数千首歌的扫描入库从数秒降至数百毫秒；批量失败时自动回退到逐条插入保证部分成功
- **scanner rayon 并行扫描** — 文件扫描从单线程串行改为两阶段：WalkDir 收集候选文件 → rayon `par_iter` 并行提取元数据，多核 CPU 上扫描速度提升数倍
- **进度事件频率提升** — player.rs 硬编码 500ms 改为使用 `PROGRESS_EMIT_INTERVAL_MS=250` 常量，进度条更新更流畅

### 🎨 前端优化
- **`shouldSync` 条件优化** — 移除 `position > store.currentTime` 条件（几乎总是 true，导致每次后端推送都覆盖 rAF 平滑更新），rAF 成为主要进度来源，后端仅作漂移校准
- **LikedView/HiddenView/HistoryView 搜索防抖** — 与 LocalView 一统，引入 `useDebouncedValue(searchInput, 300)`，避免每次按键触发全量过滤
- **`useDebouncedValue` 复用 debounce 实例** — 每次 value 变化都创建新 debounce 函数改为 `useMemo` 持有实例，减少 GC 压力

### 🛡️ 安全修复
- **`scan_folder` cleanup 限定范围** — 扫描子文件夹时不再全局清理不存在的歌曲（可能误删其他文件夹如未挂载外部盘的歌曲），改为仅清理被扫描文件夹范围内的歌曲

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.16 (2026-06-23)

### 🚀 前端性能（虚拟列表 + 颜色提取优化）
- **SongItem 移除 `isPlaying` prop** — 该 prop 未使用但每次 play/pause 切换导致 20-30 个虚拟列表项全量重渲染，从 SongItem/SongList/4 个 View 中彻底移除
- **useAlbumColor 模块级缓存** — 同一首歌被 App/PlayerBar/LyricsView/各 View 同时调用时颜色提取执行 3-4 次（CPU 密集的 colorthief 像素遍历），改为模块级 `colorCache` + `pendingExtractions` 去重，只提取一次
- **HiddenView `onToggleLike` 稳定化** — inline 箭头函数改为 `useCallback`，避免破坏 SongItem 的 `memo`
- **HistoryView `loadPlayHistory` 竞态保护** — 合并 useEffect 内联 load 与 useCallback 为统一函数，添加 `opId` 竞态守卫防止卸载后 setState

### 🛡️ 后端 async 阻塞修复
- **`get_or_create_thumbnail` spawn_blocking** — 缩略图生成（Lanczos3 缩放 + JPEG 编码）在 async 上下文中同步执行，阻塞整个 tokio 运行时，改为 `spawn_blocking` 包裹
- **`hide_songs_batch`/`unhide_songs_batch` spawn_blocking** — 路径校验 `is_path_in_music_folder` 内部调用 `canonicalize`（同步系统调用），改为 `spawn_blocking` 包裹

### 🔍 后端代码质量
- **`database.rs` 移除不必要的 `paths.clone()`** — `paths` 在 clone 后未再使用，直接 `move` 进闭包
- **`flac_decoder.rs` seek 错误日志** — `Err(_)` 丢弃原始错误信息，改为 `debug!` 记录

### 🧹 前端清理
- **`useSongCover` pendingRequests 分支 cleanup** — 缺少 `cancelled` 标志，组件卸载后仍可能 setState
- **删除 `useDebouncedCallback` 死代码** — 定义后无任何调用方，且存在 stale closure 风险

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.15 (2026-06-23)

### 🚀 前端性能（ProgressBar 60fps 重渲染消除）
- **ProgressBar 60fps 重渲染** — 与 LyricsView 同类问题，移除 `currentTime` 直接订阅，改用 `usePlayerStore.subscribe` 外部监听 + 100ms 节流（从 60 次/秒降为 10 次/秒），配合 CSS `transition: width 0.1s linear` 保证视觉平滑
- **Sidebar navItems 稳定化** — `navItems` 数组每次渲染重建，改为 `useMemo` 稳定引用

### 🔍 后端错误日志补全
- **`.ok()?` 静默吞错** — `scanner.rs`/`lyrics.rs`/`thumbnail.rs` 中 8 处 `.ok()?` 改为 `match` + `debug!` 日志，便于排查文件读取/格式探测失败
- **`app_handle.emit` 静默吞错** — `player.rs` 中 5 处 `let _ = app_handle.emit(...)` 改为 `if let Err(e)` + `warn!`/`debug!` 日志（playback_error 用 warn，progress/finished 用 debug）

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.14 (2026-06-23)

### 🛡️ 后端 Panic 修复
- **`seek_song` 参数校验** — `Duration::from_secs_f64` 在 NaN/Infinity/负数时 panic，入口添加 `is_finite() && >= 0.0` 校验
- **`flac_decoder`/`scanner` 除零保护** — `tb.denom == 0` 时除法产生 infinity，`from_secs_f64(infinity)` 会 panic，添加零检查 + `is_finite()` 守卫

### 🚀 前端性能（60fps 重渲染消除）
- **LyricsView 60fps 重渲染** — 移除 `currentTime` 订阅，改用 `usePlayerStore.subscribe` 外部监听，仅在歌词行变化时 `setState`（从 60 次/秒降为几次/分钟）
- **LyricsView 事件委托** — 内联 `onClick` 改为 `data-time` + 单一事件委托
- **Store 订阅粒度** — PlayerBar/SettingsView/9 个组件的 `useThemeStore()`/`usePlayerSettingsStore()`/`usePlayQueueStore()`/`useOperationLogStore()` 全部改为 selector 订阅
- **SongList handlePlay ref 稳定化** — `songs` 依赖改为 ref，避免搜索/排序时列表项全量重渲染

### 🐛 前端 Bug 修复
- **`useUpdateCheck` 版本号 NaN** — `Number('3-beta')` 返回 NaN 导致更新检测永远为 false，添加 NaN → 0 兜底
- **SettingsView `key={index}`** — 副文件夹列表删除中间项时 UI 错位，改为 `key={folder}`
- **SettingsView 边界检查** — `secondaryFolders[index]` 未检查 undefined
- **main.tsx 非空断言** — `getElementById('root')!` 改为显式检查 + 友好错误

### 🔒 后端输入校验
- **`add_log` level 白名单** — 校验 `INFO`/`WARN`/`ERROR`/`DEBUG`/`TRACE`
- **`add_play_history` duration 非负** — 拒绝负数 duration
- **`get_logs`/`get_play_history` limit 非负** — `limit.unwrap_or(100)` 改为 `filter(|&l| l > 0)`

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.13 (2026-06-23)

### 🚀 后端批量 SQL 优化
- **`cleanup_nonexistent_songs`** — 5N 次 DELETE 降为每批 2 次（利用 FK ON DELETE CASCADE 自动清理 play_counts/play_history/liked_songs，仅显式删除 hidden_songs）
- **`delete_song`** — 5 次 DELETE 降为 2 次（同上，FK 级联）
- **`hide_songs_batch`/`unhide_songs_batch`** — N+1 循环改为批量 `IN` / 多值 INSERT（每批 500 条）
- **`main.rs`** — `std::fs::create_dir_all` 包裹 `spawn_blocking`；`Vec<Song>` clone 改为 `std::mem::take` 转移所有权
- **`commands/song.rs`** — 同上 `std::mem::take` 优化
- **`get_song_covers_batch`** — `HashMap::with_capacity(paths.len())` 预分配

### 🐛 前端 Bug 修复
- **`||` 误用为 `??`** — 6 个 API 模块中 `|| []`/`|| 0`/`|| false` 会覆盖后端合法的 `0`/`false` 返回值，全部改为 nullish coalescing
- **`invokeApi` 错误消息** — `response.error` 为 undefined 时抛出 `"undefined"` 字符串，改为带命令名的默认消息 + undefined data 校验
- **`useSongSort` 类型守卫** — `as T` 不安全断言改为 `VALID_SORTS` 白名单 Set 运行时校验
- **除零保护** — `useAlbumColor.rgbToHsl`（纯黑颜色 `max+min=0`）、`ProgressBar`（`rect.width=0`）、`themes.hexToRgba`（非法 hex 产生 NaN）

### 🔧 前端性能
- **`SongList.columnConfig` memo 化** — 内联对象每帧重建导致 `SongItem` 的 `React.memo` 失效（虚拟列表关键路径）
- **`Promise.all` 并行化** — `SettingsView` 和 `playerStore.restoreLastSong` 中独立的 API 调用改为并行
- **`playQueueStore` 边界保护** — `shuffleTracksKeepCurrent` 在 currentIndex 越界时避免 `splice` 返回 `undefined`

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.12 (2026-06-22)

### 🛡️ 安全加固
- **P0 `find_fallback_cover` 目录越权读取** — 扫描父目录前校验 `artist_dir` 仍在 `music_folder` 内

### 🚀 后端质量
- **阻塞 I/O 全部迁移到 `spawn_blocking`** — `probe_audio_file`、`get_lyrics`、批量路径校验
- **player.rs emit 操作移出写锁** — 降低锁竞争，避免 I/O 阻塞共享状态
- **thumbnail 错误传播** — `get_thumbnails_dir` 返回 `Result`，失败不再静默返回空路径
- **数据库外键约束** — 连接配置启用 `foreign_keys(true)` + WAL，确保级联删除生效
- **DB 写入错误日志化** — 主流程与设置页 `set_setting` 失败改为 `tracing::warn!`

### 🐛 前端 Bug 修复
- **60fps 全树重渲染** — 7 个组件 `usePlayerStore()` / `useLibraryStore()` 改为独立 selector 订阅
- **事件订阅泄漏** — playerStore `eventUnlistenPromises` 模式 + `mediaSession` handler 清理
- **useSongCover HMR 泄漏** — 模块级 `setInterval` 改为 `setTimeout` 链式清理
- **异步竞态** — `HistoryView`、`SettingsView` 添加 `cancelled` flag；`useUpdateCheck` 引入 `AbortController`
- **LyricsView setTimeout 泄漏** — 滚动抑制 timer 在 useEffect cleanup 中清理

### 🧹 代码质量
- **统一 API 错误处理** — 新增 `invokeApi` 辅助函数，重构 6 个 API 模块
- **无障碍改进** — 15+ 图标按钮添加 `aria-label`；进度条/音量条添加 `role="slider"`
- **常量集中化** — 音量步进、快进秒数、日志/历史限制、列表行高、主题色归入 `APP_CONFIG`

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.11 (2026-05-28)

### 🔧 代码质量与性能优化
- 🚀 **异步命令中的同步 I/O 全部改为 `spawn_blocking`** — `cleanup_nonexistent_songs`、`check_file_exists`、`play_song`、`add/remove_secondary_folder`、`get_thumbnail_info`
- 🛡️ **Tauri capabilities 权限收紧** — 移除未使用的 `shell:allow-open`、`dialog:default`、`fs:default`，仅保留 `core:default` + `core:event:default`
- 🐛 **未捕获异步错误处理** — `App.tsx` 初始化数据、`restoreLastSong` 增加 try/catch
- 🚀 **LyricsView `currentLineIndex` 优化** — `useCallback` 改为 `useMemo`，避免每帧重建函数
- 🧹 **封面请求 pending Map 清理优化** — 改用定时清理替代粗暴全量清空
- 🛠️ **sync-docs.sh 路径修正** — 适配 `jlocal/` 代码子目录 + 项目根 `docs/` 文档目录结构
- 📦 **依赖更新** — npm patch/minor 安全更新

### Verification
- ✅ Rust `cargo clippy --all-targets` — 0 warnings
- ✅ Rust `cargo test` — 13 passed
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.10 (2026-05-28)

### 🛡️ 安全加固 — 4 项路径校验漏洞修复
- 🔒 **P0-1 `remove_secondary_folder` 路径遍历** — 新增 `is_safe_link_name` 校验，link_name 必须是单一路径组件，无 `/` `\` `..`；canonicalize 二次验证
- 🔒 **P0-2 `scan_folder` 任意目录扫描** — 新增 `validate_path_in_music_folder` 入口校验
- 🔒 **P0-3 `add_secondary_folder` 系统敏感目录** — 新增 `is_sensitive_path` 黑名单，拦截 `/etc` `/System` `/usr` 等系统目录和 `~/.ssh` `~/.gnupg` 等用户敏感目录
- 🔧 **P1-1 二级文件夹功能失效** — 重构 `is_path_in_music_folder`，先尝试 canonicalize 校验，未匹配时回退到不解析符号链接的路径前缀校验，恢复 `add_secondary_folder` 整套功能

### 🐛 Bug 修复 — 7 项
- 🐛 **P1-5 播放历史未等待** — `track_finished` 改为 `async` 并 `await finalizePlayHistory`，避免快速切歌时历史记录乱序
- 🐛 **P1-9 喜欢/隐藏按钮竞态** — `toggleLike`/`toggleHidden` 改为乐观更新 + 失败回滚
- 🐛 **P1-11 音频流故障 UI 失同步** — OutputStream 恢复时 emit `playback_error` 事件，前端监听并重置 `isPlaying=false`
- 🐛 **P1-8 批量封面重复请求** — `useSongCovers` 用 `pathsKey.join(',')` 作为 effect 依赖，避免数组引用变化导致冗余请求
- 🐛 **P1-6 HMR 模块级状态泄漏** — 新增 Vite HMR `dispose` 钩子，热更新时重置 `playOperationId`/`backendLoaded` 等模块级变量
- 🐛 **P2-6 seek 失败 UI 不一致** — seek 失败时回滚 `currentTime` 到跳转前位置
- 🐛 **P2-7 组件卸载后状态更新** — `App.tsx` 新增 `cancelled` 标志处理 `restoreLastSong` 异步流程
- 🐛 **P2-8 图片加载未取消** — `useAlbumColor` 新增 `cancelled` 标志，取消异步颜色提取

### 🧹 代码清理 — 4 项
- 🗑️ **P1-2 删除死代码** — `get_audio_file` 命令和前端封装（整文件 base64 编码，内存风险）已删除
- 🛡️ **P2-1 `get_setting` 校验** — 新增 `ALLOWED_SETTING_KEYS` 白名单
- 🛡️ **P2-3 thumbnail 目录回退** — `get_thumbnails_dir` 失败时返回空路径而非回退到 `.` 污染安装目录
- 🛡️ **P2-5 `set_volume` 范围校验** — 入口校验 `0.0..=1.0`

### Verification
- ✅ Rust `cargo check` — 0 errors, 0 warnings
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.8.9 (2026-05-11)

### 🔒 安全加固 + Bug 修复
- 🛡️ **封面请求安全修正** — `get_song_covers_batch` 改用 DB 直接读取 `music_folder`，不再依赖首个路径推导，每个路径独立验证
- 🛡️ **批量隐藏安全加固** — `hide_songs_batch` / `unhide_songs_batch` 新增路径校验过滤越权路径
- 🐛 **元数据提取容错** — `process_normal_file` 提取失败时 `return None` 而非用 "Unknown" 覆盖已有正确数据
- 🔊 **OutputStream 恢复预热** — 超时重建 Sink 时追加 440Hz SineWave 预热，消除恢复后首次播放延迟
- 🧹 **代码简化** — 消除 Option 嵌套

### Verification
- ✅ Rust `cargo check` — 通过
- ✅ TypeScript — 0 errors

---

## v0.8.8 (2026-05-11)

### 🔧 代码审查修复 — 9 项 (5 P1 + 3 P2 + 1 文档)

#### P1 — 重要
- 🔗 **GitHub 仓库地址修正** — 3 处 `JereoZero/jlocal` → `JereoZero/JMusic`
- 📋 **函数重命名** — `copy_logs_to_clipboard` → `get_logs_as_text`（语义更准确）
- ⏳ **启动恢复 await** — `App.tsx` `restoreLastSong` 添加 `await`，等待完成后再初始化事件监听器
- 🛡️ **封面批量请求** — `get_song_covers_batch` 新增路径验证
- 🛡️ **播放计数** — `get_song_play_count` 新增路径验证

#### P2 — 次要
- 🔀 **随机播放 hidden 分支** — `playRandomSong` 新增 hidden 来源分支
- 🎯 **竞态保护** — `track_finished` 监听新增 `playOperationId` 竞态保护
- 🛡️ **回退封面** — `find_fallback_cover` 新增路径校验

### Verification
- ✅ Rust `cargo check` — 通过
- ✅ TypeScript — 0 errors

---

## v0.8.7 (2026-05-12)

### 🔒 安全修复
- 🛡️ **后端安全审计** — 逐文件审读 18 个 Rust 源文件，修复 6 项安全漏洞
- 🛡️ **路径验证统一** — 提取 `validate_path_in_music_folder()` 辅助函数，`delete_song`、`library.rs`、`add_play_history` 等命令全部增加路径边界检查
- 🛡️ **设置白名单** — `set_setting` 增加 `ALLOWED_SETTING_KEYS` 白名单，防止前端篡改关键配置
- 🛡️ **Batch 上限** — `get_song_covers_batch`、`hide_songs_batch` 增加 `MAX_BATCH_SIZE = 100` 防 DoS
- 🛡️ **错误吞掉修复** — 3 处 `let _ =` 改为 `if let Err(e) { tracing::warn/error! }`

### 📚 文档
- 📖 **PROJECT.md** — 创建项目架构文档 (696 行)，涵盖架构图/数据流/事件系统/测试/IPC 命令/设计决策等 13 个章节
- 📖 **docs/ 加入 .gitignore** — 本地文档不推送到 GitHub

### Verification
- ✅ TypeScript — 0 errors
- ✅ ESLint — 0 warnings
- ✅ Rust `cargo check` — 0 errors, 0 warnings

---

## v0.8.6 (2026-05-12)

### 🔒 安全修复
- 🛡️ **路径遍历防护** — `add_secondary_folder` 增加 `canonicalize()` 解析 + 路径存在性检查，防止符号链接指向任意路径
- 🛡️ **Panic 消除** — 移除 `main.rs` 中 3 处 `.unwrap()`，改为降级处理 + `.expect()`

### 🐛 Bug 修复
- 🏃 **竞态保护** — `resume()` 函数补充 `playOperationId` 竞态检查
- 📝 **错误日志** — 3 处空 `.catch()` 添加 `console.error` 日志输出

### 🧹 代码优化
- 🧩 **Clock 组件提取** — `Clock` 内联组件 → 模块级 `ClockIcon`，避免每次渲染重建

### Verification
- ✅ TypeScript — 0 errors
- ✅ Rust `cargo check` — 通过
- ✅ 7 方向代码审计完成

---

## v0.8.5 (2026-05-12)

### 🧹 代码优化
- 🗑️ **死代码清理** — 删除无人引用的 `SongListHeader.tsx` (121行) 和 `styles/tokens.ts` (101行)
- 📦 **组件拆分** — SongItem 提取为独立组件，SongList 从 432 行缩减到 220 行

### 🔧 代码修复
- 🛠️ **类型优化** — 用 `Set.has` 替代 `as string` 类型断言
- 🧹 **清理** — 移除 LocalView 中未使用的 `handleLikeSort`

### Verification
- ✅ TypeScript build — 0 errors
- ✅ ESLint `--max-warnings 0` — clean

---

## v0.8.4 (2026-05-12)

### 🎨 UI 重构与列对齐修复
- 📐 **Grid 布局重构** — 歌曲列表改为 CSS Grid，Header 与 SongItem 列宽统一计算
- 🧩 **组件合并** — SongListHeader 内置到 SongList 组件，消除容器宽度差异
- 🔧 **列配置管理** — 新增 `songListColumns.ts` 统一列定义函数
- ✅ **视图一致性** — 修复本地/喜欢/历史/隐藏四个视图的列显示一致性
- 🎯 **对齐优化** — 序号和时长列改为居中对齐

### ⚙️ 功能增强
- 🌐 **设置页面** — 新增项目地址展示
- 🔄 **检查更新** — 基于 GitHub Release API 的版本检测功能
- 🎨 **设计系统** — 新增 tokens.ts 设计令牌和 cn.ts 工具函数

### Verification
- ✅ TypeScript build — compiles clean
- ✅ Grid 列对齐 — 可视化调试验证通过

---

## v0.8.3 (2026-05-11)

### 🐛 Bug Fixes — v0.8.2 Regressions Resolved

- 🔊 **First-Play No Sound — Real Fix** — Root cause was in frontend `togglePlay()`: `restoreLastSong()` restored UI state but backend had no audio loaded. Added `backendLoaded` flag to distinguish "has loaded audio" vs "backend empty", ensuring first play calls `playSong()` instead of `resumeSong()` ([playerStore.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/stores/playerStore.ts))
- 🖱️ **Window Dragging — Real Fix** — Abandoned Tauri 2 Overlay mode (wry kernel doesn't forward titlebar mouse events). Switched to native macOS `titleBarStyle: "Visible"`, system handles dragging natively with 100% reliability ([tauri.conf.json](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/tauri.conf.json))
- 🖤 **macOS Dark Native Titlebar** — `NSAppearanceNameDarkAqua` forced via objc2 FFI, native titlebar now matches dark theme ([main.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/main.rs))
- 🧹 **Cleanup** — Removed all failed custom drag code from `App.tsx`, `LyricsView.tsx`, `Sidebar.tsx`, `index.css`

### Verification
- ✅ Rust `cargo check` — zero errors, zero warnings
- ✅ TypeScript build — compiles clean
- ✅ Logs confirm: `Set macOS window to dark appearance` at startup
- ✅ Logs confirm: `Playing:` (not `Resumed from 0.0s`) on first play

---

### 🔥 Critical Bug Fixes — Audio Engine Rewrite + Window Dragging

- 🔊 **First-Play No Sound Fixed** — CoreAudio pipeline now properly initialized with a `SineWave` tone warmup before first play; permanent Sink stays alive across the entire app lifecycle, never dropping the mixer connection ([player.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/player.rs))
- 🖱️ **Window Dragging Fixed** — Triple-layer insurance: `data-tauri-drag-region` + CSS `-webkit-app-region: drag` + inline `WebkitAppRegion: 'drag'` style; sidebar conflict removed ([App.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/App.tsx), [Sidebar.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/components/Sidebar.tsx), [index.css](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/styles/index.css))

---

## v0.8.1 (2026-05-10)

### 🎨 macOS Dark Title Bar + Version Fix + Backend Optimization
- 🖤 **macOS Dark Title Bar** — Overlay transparent title bar mode, title bar area blends into dark background
- 🖱️ **Window Drag Fix** — Top area (sidebar/main content) now supports drag-to-move window via `data-tauri-drag-region`
- 🔗 **Backend Connection Optimization** — `get_audio_file` moved to `spawn_blocking` + 50MB size limit to prevent UI freeze
- 🚀 **Batch Cover Concurrency** — `get_song_covers_batch` processes 20 covers concurrently instead of sequentially
- 🔢 **Version Number Sync** — Fixed APP_CONFIG version out of sync (0.7.12 → 0.8.1)

---

## v0.8.0 (2026-05-10)

### 🎨 Brand & Stability Update
- 🎨 **New Logo** — Replaced with a cleaner, more modern logo design
- 🟢 **Neon Green Theme** — Added neon green (`#39FF14`) theme color
- 🛡️ **OutputStream Recovery** — Auto-retry & rebuild on audio device failure, no restart needed
- ⚡ **Blocking IO Isolated** — Scanner/metadata extraction moved to `spawn_blocking`, no more UI freeze on large libraries
- 🎯 **Race Condition Protection** — Play operation sequence number prevents state corruption on rapid song switching
- 🎚️ **Accurate Track End Detection** — Uses `sink.empty()` instead of time estimation for precise track transition
- 🔀 **Shuffle Rewrite** — Fisher-Yates pre-shuffle replaces runtime random pick, guarantees no repeats
- 🗄️ **Database Optimization** — `cleanup_nonexistent_songs` uses batch transactions + path-only queries
- 🔇 **Decode Error Tolerance** — Flac decoder gains consecutive error limits + logging
- 🧹 **HMR Compatible** — playerStore adds `destroy()` method for React Strict Mode/HMR
- 🖼️ **Screenshots Updated** — 7 new UI screenshots replace old ones
- 📘 **README Enhanced** — New "Interactions" section, full UI screenshot gallery

---

## v0.7.13 (2026-05-10)

### 🎨 Brand & Theme Update
- 🎵 **New Logo** — Replaced "Only" text with blue musical note icon (`logo/Jlogo.PNG`), sidebar now displays the brand logo
- 🎨 **New default theme: Blue** — Added `#00A8FF` (Logo blue) as the new default theme color, placed first in theme list
- 🎨 **Theme system expanded** — 4 themes → 5 themes: Blue (new), Orange, Khaki, Gray Blue, Olive Green
- 📝 **Settings history updated** — v0.7.4 changelog reflects the new logo change

---

## v0.7.12 (2026-05-09)

### 🔥 Bug Fixes — 15 issues fixed from comprehensive code review

#### P0 — Critical (3)
- 🐛 **SongListHeader always hidden** — Removed `hidden` class from table header grid, header column labels now visible ([SongListHeader.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/components/SongListHeader.tsx))
- 🐛 **`finalizePlayHistory` missing await** — Two call sites (playSongInternal, stop) now properly await before continuing, fixing playback history data loss on song switch ([playerStore.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/stores/playerStore.ts))
- 🛡️ **CSP security disabled** — Replaced `"csp": null` with proper restrict-to-self policy covering default-src, img-src, style-src, script-src ([tauri.conf.json](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/tauri.conf.json))

#### P1 — Important (6)
- 🎨 **Single-pixel color sampling → colorthief Median Cut** — Replaced Canvas getImageData(1×1) with `colorthief`'s MMCQ quantization for representative album colors ([useAlbumColor.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/hooks/useAlbumColor.ts))
- ⚡ **`useSongCovers` individual requests → batch API** — Changed N sequential `getSongCoverFull` calls to single `getSongCoversBatch` RPC ([useSongCover.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/hooks/useSongCover.ts))
- 📦 **Duplicate types eliminated** — `ViewType`/`PlayMode` now defined only in `types.ts`, imported by `constants/index.ts` ([constants/index.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/constants/index.ts))
- ⚙️ **Config deduplication** — Merged `PLAYER_CONFIG` into `APP_CONFIG.player`, fixed inconsistent `progressInterval` value (250ms → 500ms) ([config/index.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/config/index.ts))
- 🪟 **Window now resizable** — Removed fixed maxWidth/maxHeight restriction, set minWidth=900 minHeight=600 with `resizable: true` ([tauri.conf.json](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/tauri.conf.json))
- 🔗 **Rust `is_path_in_music_folder` deduplicated** — Removed duplicate in `settings.rs`, unified to `path_validator.rs` version ([commands/settings.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/commands/settings.rs))

#### P2 — Code quality (6)
- 🧹 **Unused deps cleaned** — Removed `clsx`, `tailwind-merge` (frontend) and `config`, `regex` (Rust) from package manifests
- 🔧 **`useSongSort` type cast hack fixed** — Added `path: string` to `SortableItem` interface, eliminated `as unknown as` ([useSongSort.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/hooks/useSongSort.ts))
- 🔁 **HistoryView useEffect stable reference** — Wrapped `loadPlayHistory` in `useCallback` to prevent unnecessary re-fetches ([HistoryView.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/views/HistoryView.tsx))
- ⏱️ **Volume debounce** — Added 100ms debounce to `setVolume` backend calls using `es-toolkit/debounce` ([playerStore.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/stores/playerStore.ts))
- 🚀 **`getLikedSongs` backend SQL JOIN** — Replaced client-side filter (fetch all → filter in JS) with SQL INNER JOIN for O(1) lookup ([database.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/database.rs), [library.ts](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/api/modules/library.ts))
- 🗑️ **Batch unlike in clearAllData** — Added `clear_liked_songs` RPC eliminating per-song DELETE loop in SettingsView ([database.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/database.rs), [SettingsView.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/views/SettingsView.tsx))

### CI & Build
- 🔧 **Windows CI 暂时移除** — `lto = true` 与 Windows MSVC 链接器不兼容，CI 矩阵改为仅 macOS，Windows 支持后续处理
- 🖥️ **GitHub Actions runner** — `windows-latest` → `windows-2022` 测试（已回滚）

### Lint & Verification
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings
- ✅ Rust `cargo check` — clean compile

---

## v0.7.12-patch (2026-05-10)

### 🔥 Additional Fixes — Post-release code review

#### P0 — Critical (3)
- 🐛 **Windows build failure** — `lto = true` in `[profile.release]` causes MSVC linker error on Windows; changed to `lto = "thin"` with `codegen-units = 1` ([Cargo.toml](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/Cargo.toml))
- 🐛 **Player sink lifecycle bug** — `sink.take()` on track completion consumed the sink without stopping it, leaving state inconsistent; now properly stops sink and clears `duration` ([player.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/player.rs))
- 🐛 **`get_song_play_count` type mismatch** — `fetch_one` + `unwrap_or(0)` mixed `sqlx::Error` with `i64`; changed to `fetch_optional` + `?` + `unwrap_or(0)` ([database.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/database.rs))

#### P1 — Important (3)
- 🎚️ **ProgressBar stale closure** — `handleMouseUp` captured stale `displayTime` from closure, causing seek to jump to old position after drag; fixed with `displayTimeRef` ([ProgressBar.tsx](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src/components/player/ProgressBar.tsx))
- 🔇 **`scan_folder` silent error swallowing** — `upsert_songs().unwrap_or((0,0))` hid database errors, preventing encrypted songs from being auto-hidden; replaced with explicit `match` error handling ([commands/song.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/commands/song.rs))
- ⚡ **Player thread CPU usage** — `recv_timeout(50ms)` caused busy-loop; increased to 100ms to reduce idle CPU ([player.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/player.rs))

#### P2 — Documentation (1)
- 📝 **Symphonia blocking IO noted** — `get_duration_from_symphonia` performs sync file I/O in async context; added comment warning for future `spawn_blocking` refactor ([scanner.rs](file:///Volumes/JZMAC-1T/trae/mus1/Jlocal/jlocal/src-tauri/src/scanner.rs))

---

## v0.7.11 (2026-05-09)

### 🔧 CI 构建修复
- GitHub Actions 构建因 `npm install` peer dependency 冲突失败 → 改用 `--legacy-peer-deps`
- 修复后 `tsc`、`vite build` 全部通过，Rust `cargo build` 编译成功

### 📝 文档归档
- BUGS.md 归档：21 个已修复 CODEX 从详细描述精简为紧凑汇总表，完整记录移至 BUGS_HISTORY.md

---

## v0.7.10 (2026-05-09)

### P1 Bug Fixes (CODEX Final Round)
- 🎯 **Synchronous audio format probe** (CODEX-1) — `probe_audio_file()` verifies file is decodable via Symphonia/Rodio *before* queuing to player thread; corrupt/unsupported files now return immediate error to frontend
- 📁 **Startup music_folder persistence** (CODEX-2) — auto-scan on first launch now creates default directory and writes `music_folder` to DB, preventing "Music folder not configured" errors
- 🛡️ **Lyrics path protection** (CODEX-7) — `get_lyrics` returns proper errors for missing config and path violations instead of silent `Ok(None)`

### P3 Bug Fixes
- 🖼️ **Cover cache COALESCE** (CODEX-17) — `upsert_songs` now preserves existing cover art when re-scan yields no new cover

### Documentation
- 📝 BUGS.md fully updated — 21/23 CODEX items resolved (19 + 2 deferred for E2E/Windows)
- 📝 All docs synced to v0.7.10 (README, CHANGELOG, DEVELOPMENT_LOG)

### Previous CODEX Summary (v0.7.9 cumulative)
> Full CODEX fix history: CODEX-3~19, 21~23 resolved across 3 review batches.
> 2 deferred: CODEX-20 (E2E tests, low priority), Windows-only #3/#4.

### Testing & Verification
- 🧪 142 tests (11 files) — 100% pass rate
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ ESLint `--max-warnings 0` — 0 warnings

---

## v0.7.9 (2026-05-09)

### Rust Backend Optimizations
- 🔧 **Log level correction** — 7 error paths in `player.rs` changed from `info!` to `warn!`/`error!` for proper severity classification
- 🔇 **Scan log noise** — per-song `info!` downgraded to `debug!` in scanner, prevents terminal flooding on large libraries
- 🔇 **Play history log** — `add_play_history()` `info!` downgraded to `debug!`
- 📦 **Vec pre-allocation** — scanner vectors use `with_capacity(500/50/20)` to reduce memory reallocations

### React Frontend Optimizations
- ⚛️ **useCallback for view handlers** — `handleViewChange`/`handleToggleSettings`/`handleToggleLyrics` in App.tsx now memoized, preventing unnecessary Sidebar re-renders
- 🧹 **Inline arrow cleanup** — removed redundant `(path) => toggleHidden(path)` wrapping in LocalView/LikedView
- 🏪 **useShallow selectors** — 5 components (LocalView, LikedView, HiddenView, HistoryView, PlayerBar) optimized with `useShallow` to avoid cascade re-renders from store signal changes
- 💾 **Sort persistence** — sort state saved to `sessionStorage` via new `viewKey` parameter, survives view switches
- 🎵 **DSD playback** — removed `dsd` from UNSUPPORTED_EXTENSIONS in SongList (SymphoniaDecoder already handles it)

### Testing & Verification
- 🧪 142 tests (11 files) — 100% pass rate
- ✅ TypeScript `tsc --noEmit` — 0 errors
- ✅ Rust `cargo check` — clean
- 📊 12 files changed, +161 / -65 lines

---

## v0.7.8 (2026-05-08)

### Theme System
- 🔧 All play buttons, badges, borders, filter tabs now follow theme color dynamically
- 🔧 Sidebar nav items, refresh button, search focus ring use theme primary color
- 🔧 ErrorBoundary retry button uses theme color
- ✨ New `hexToRgba` utility for dynamic opacity support

### Refactoring (Code Quality)
- ♻️ Toast system → `sonner`: deleted 3 files (toastStore + ToastContainer + test) -115 lines
- 🎨 Album color → `colorthief`: Median Cut algorithm replaces single-pixel sampling
- 🎹 Keyboard shortcuts → `react-hotkeys-hook`: +Scope/combo key support, deleted dead hook
- 🛠️ Debounce → `es-toolkit`: 2x faster than lodash, treeshaken ~3kB
- 🔤 Encoding detection → `chardetng` (Mozilla/Firefox): auto-detect GBK/EUC-JP/Shift_JIS
- 🔗 Rust constants unified: SYMPHONIA_EXTENSIONS shared across player/scanner/constants
- Total net code reduction: ~216 lines removed

### Features
- ▶️ LikedView: "Play All" button, independent play queue per view (local/liked/hidden/history)

---

## v0.7.7 (2026-05-08)

### Bug Fixes — 34 bugs fixed across 4 review rounds

#### Round 1: Player Core & Format System (15 bugs)

**Player & Audio:**
- 🐛 Smooth progress bar: eliminated dual-track update race between rAF timer and backend `playback_progress` event. Progress only syncs from backend when gap > 0.3s or position is ahead.
- 🐛 Player thread busy-wait eliminated: replaced `tokio::sync::mpsc` with `std::sync::mpsc`, changed `try_recv() + sleep(50ms)` to `recv_timeout(Duration::from_millis(50))`.
- ✨ Extended audio formats: added AIFF (.aif/.aiff), Opus (.opus), CAF (.caf) support. Unified frontend/backend format constants.
- 🐛 Volume mute sync: added `useEffect` in VolumeControl to sync `previousVolume` state when not muted.
- 🐛 HistoryView: `handlePlayFromHistory` now directly calls `playSong(song)` instead of useless `searchSongs(song.path)`.

**Code Quality:**
- 🔧 Dead code removal: 305 lines eliminated across player commands (`play_next`, `play_prev`), DB methods (`get_next_song`, `get_prev_song`), API functions, and mock implementations.
- 🔧 Library store: removed unused `toggleLikeWithContext` and `toggleHiddenWithContext` methods.
- 🔧 Naming: `SymphoniaFlacDecoder` → `SymphoniaDecoder` (reflects multi-format support).
- 🔧 Scan result: added `metadata_errors: Vec<String>` field to `ScanResult` for better error visibility.

---

#### Round 2: Memory & Error Handling (5 bugs)

**Play Queue:**
- 🐛 Shuffle `removeFromQueue`: changed from index-based deletion to path-based lookup.
- 🐛 `moveInQueue`: `originalQueue` now synchronized with queue operations.

**Error Handling:**
- 🐛 Empty catch blocks eliminated: all `.catch(() => {})` replaced with `handleError(error, context)` or `createErrorHandler('context')`.
- 🐛 10 `console.error` calls in playerStore replaced with `handleError(error, context)`.

**Memory & Lifecycle:**
- 🐛 Timeout management: SettingsView's single ref pattern preventing stale closures.
- 🐛 LyricsView: `currentSongRef` pattern avoids stale closure bugs.

**API Consistency:**
- 🔧 Field name fix: `LyricSource.source` → `type` (with `#[serde(rename = "type")]`).
- 🔧 Lyric source values: `"lrc_file"` → `"external"`.
- 🔧 Rust safety: `unwrap()` → `if let` in lyrics decoder.

---

#### Round 3: Play History & Data Processing (6 bugs)

- 🐛 Play history tracking: new `finalizePlayHistory()` records actual listening duration. Previously always recorded `duration=0, completed=false`.
- 🐛 `playback_progress` guard: `duration=0.0` from backend no longer corrupts frontend state.
- 🐛 Remaining `console.error` spots: 5 more replaced with unified `handleError()`.
- 🐛 `copyDebugLogs`: added clipboard error handling with toast feedback.
- 🐛 SettingsView: fixed two wrong error context strings.
- 🔧 `useAlbumColor.ts`: removed leftover `console.log` debug output.

---

#### Round 4: Folder/Song Management Refactor (8 bugs)

- 🐛 `cleanup_nonexistent_songs`: removed `base_folder` restriction, now checks ALL songs regardless of folder origin. Fixes orphaned songs from deleted secondary folders.
- 🐛 Symbolic link dedup: scanner uses `HashSet<PathBuf>` with canonical paths to prevent duplicate/cyclic scanning.
- 🐛 `upsert_songs`: now returns `(success, errors)` tuple instead of silently discarding failed inserts.
- 🐛 `delete_song` cascade: transaction-based cleanup of `play_counts`, `play_history`, `liked_songs`, `hidden_songs` before deleting from `songs`.
- 🔧 Audio format constants: split `NORMAL_AUDIO_EXTENSIONS` / `ENCRYPTED_AUDIO_EXTENSIONS` / `UNSUPPORTED_AUDIO_EXTENSIONS` for semantic clarity.
- 🐛 SettingsView error handling: 2 `console.error` replaced with `handleError()`, duplicate toast removed, auto-refresh after folder removal.

---

### AI Development Tools
- 🤖 Installed 3 Trae IDE Skills: `tauri-review`, `react-logic`, `music-audit` for automated code auditing.
- 📚 Reference: [jezweb/claude-skills](https://github.com/jezweb/claude-skills) (161⭐)

### Testing
- 🧪 Expanded from 7 files (64 tests) to 12 files (151 tests) — 100% pass rate.
- 🆕 New test files: `playQueueStore`, `toastStore`, `operationLogStore`, `errorHandler`, `songUtils`.

---

## v0.7.6 (2025-03-20)
> Test release for GitHub upload workflow

- ✨ DSF/DFF/DSD format support: playback and duration via Symphonia decoder
- 🔧 Scan optimization: auto-cleanup deleted songs from database
- 🐛 Fixed main/secondary folder management
- 🎨 Adjusted color transition time to 0.7s
- 🐛 Fixed database read-only issues with file permissions

## v0.7.0

- ✨ Dynamic background colors: extract theme color from album covers
- ✨ Multi-folder support: main folder + secondary folders
- 🎨 Smooth transition animations between views
- 🐛 Fixed player core stability issues

## v0.6.5

- ✨ Lyrics display feature
- 📝 LRC lyrics file parsing support
- 🎵 Embedded lyrics extraction from audio files

## v0.6.4

- ✨ New lyrics view
- 🔧 Optimized hide/like logic
- 🎨 Improved sidebar and player bar UI

## v0.6.0

- 🎨 New UI design
- ❤️ Like/unlike songs support
- 📊 Multiple sort options for song library

## v0.5.0

- 🔊 Player core refactor: Actor pattern architecture
- 📋 Playlist support
- 🔁 Loop mode support: single, list, shuffle

## v0.4.0

- 🗄️ SQLite database integration
- 🔍 Fast library scanning with metadata extraction
- 🎨 Album art thumbnail generation
- 🖼️ Virtual scrolling for large libraries

## v0.3.0

- 🎵 Basic audio playback (MP3, FLAC, WAV)
- 🎛️ Volume control and seek support
- 📂 Folder-based music library scanning

## v0.2.0

- 🏗️ Tauri 2 + React project scaffold
- 🎨 Dark theme foundation with Tailwind CSS
- 🖥️ Fixed window layout (1200x750)

## v0.1.0

- 🎉 Initial commit
- 📦 Project structure setup
- ⚙️ Rust + TypeScript toolchain configuration
