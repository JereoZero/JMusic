# JlocalMusic 历史 Bug 修复记录

> 已修复 Bug 归档文档，供后续参考

---

## v0.9.3 深度复审修复 + 错误隔离 + CI 修复（2026-09-19）

> v0.9.2 的 tag 曾指向 CI 故障的 commit，release 未产出；以下修复实际随 v0.9.3 首次发布。

### 🔴 数据一致性（深度复审）

- **外键约束导致喜欢 / 播放历史 / 播放次数写入失败** (`database.rs`): `liked_songs` / `play_counts` / `play_history` 三表 `path` 均外键指向 `songs(path) ON DELETE CASCADE`，连接池开启了 `foreign_keys(true)`，但写入前只校验「路径在音乐文件夹内」、未校验歌曲已入库 → 播放未入库文件时抛 `FOREIGN KEY constraint failed`。**注意 SQLite 的 `INSERT OR IGNORE` 不适用于 FK 冲突，无法抑制该错误**。修复：改为 `INSERT ... SELECT ? WHERE EXISTS (SELECT 1 FROM songs WHERE path = ?)`，把存在性判断原子化进单条 SQL。影响：播放次数此前会静默丢失。补 3 个回归测试（`test_toggle_like_unknown_song_ignored` / `test_increment_play_count_unknown_song_ignored` / `test_add_play_history_unknown_song_ignored`）
- **二级文件夹建在错误目录、路径白名单失效** (`paths.rs` + `misc.rs` + `main.rs`): 写入侧硬编码 `app_data/jmusic-file`，校验侧读 DB 设置 `music_folder`，**存在两个真源**；`main.rs` 还有第三份重复兜底逻辑。用户在设置里改过音乐文件夹后，二级文件夹仍建到旧目录，导致新目录下的歌曲被路径白名单判定为越权。修复：新增 `paths::resolve_music_folder(app, db)` 作为唯一真源（读 DB `music_folder` → 不存在则回退默认目录并写回 DB），`misc.rs` 四处 + `main.rs` 一处全部改走该函数，删除 `ensure_music_folder_exists`

### 🎨 界面缩放

- **缩放时 px 元素不跟随** (`uiStore.ts` + `App.tsx` + `SongList.tsx` + `index.css` + `SettingsView.tsx`): 原方案用 `<html>` font-size 驱动 Tailwind rem 缩放，只覆盖 rem，约 78 处 px（lucide `size={N}`、歌词封面 280px、内联 gap）不跟随，放大档位表现为「文字变大、图标不变」。修复：改用 Tauri webview 原生缩放 `getCurrentWebview().setZoom()`（等价浏览器 Ctrl +/-），新增 `core:webview:allow-set-webview-zoom` 权限。同时清理三处**二次缩放**补偿：虚拟列表行高 `* factor`、`[data-ui-scale]` padding 覆盖、`text-safe-*` 字号下限

### 🟠 错误隔离

- **单个 View 崩溃导致整页白屏** (`ErrorBoundary.tsx` + `App.tsx`): 全应用只有顶层一处 `<ErrorBoundary>` 包裹 `AppContent`，任一 View 抛错会把 **Sidebar + PlayerBar 一并替换**为全屏错误页 —— 音乐仍在响但用户失去播放控制，且没有视图级 retry。修复：`ErrorBoundary` 新增 `fullScreen`（默认 `true`）/ `title` / `description` prop；`<main>` 内新增视图级边界（`fullScreen={false}` + `key={showLyrics ? 'lyrics' : currentView}`），只替换内容区，切视图自动重置错误态。新增 6 个测试用例

### 🔧 CI/CD

- **所有 Release 无产物** (`.github/workflows/build.yml`): `ci` job 跑在 `ubuntu-22.04`，而 `npm run gen:types`（`scripts/generate-types.sh` 第 24 行）会 `cargo test export_bindings` 编译**整个 crate**。Linux 上 tauri 依赖链拉入 `gdk-sys`（GTK3），runner 未装 GTK → `The system library 'gdk-3.0' required by crate 'gdk-sys' was not found` → 退出码 101；`build` 因 `needs: ci` 被跳过。修复：`ci.runs-on` 由 `ubuntu-22.04` 改为 `macos-latest`，与 build 矩阵及「Linux 不支持」的平台策略对齐

---

## v0.9.1 性能、稳定性与 UI 优化（2026-07-29）

### 播放器状态机
- **`track_finished` 未重置 `backendLoaded`** (`playerStore.ts`): 歌曲播放完成后点击播放，UI 显示播放但实际无声音。修复：在 `track_finished` 事件处理中重置 `backendLoaded = false`，确保下次播放重新初始化后端。

### 队列与模式
- **播放模式按钮合并** (`PlaybackControls.tsx` + `playQueueStore.ts`): 原「随机」与「单曲循环」两个按钮状态互斥关系复杂。合并为单一档位按钮，循环切换 list → loop → shuffle，进入/退出 shuffle 时自动 shuffle/unshuffle 队列。

### UI/UX
- **小档位文字不可读** (`SongItem.tsx` + `PlayerBar.tsx` + `index.css`): UI 缩放到极小档时 `text-sm` 缩至 8.75px、`text-xs` 缩至 7.5px。新增 `.text-safe-sm` / `.text-safe-xs` 安全字号 class，使用 `max(rem, px)` 保证最小可读字号。
- **SongItem 高度未随缩放** (`SongItem.tsx`): 内部硬编码 `height: 56px` 未跟随 UI 缩放。改为 `height: 100%`，由外层虚拟列表统一控制。
- **Sidebar 快捷键按钮对齐** (`Sidebar.tsx`): 「快捷键」按钮使用 `text-sm` + `size={20}` + `py-2.5`，与 NavItem 不一致。统一为 `text-[15px]` + `size={22}` + `py-3`。

---

## v0.9.0 kira 音频引擎重构（2026-06-27）

### Phase 1+2：架构重构
用 kira 0.12.1 替换 563 行手搓 `player_thread`，重构为 345 行 kira `AudioManager` 实现，删除 `flac_decoder.rs`，移除 `rodio` 依赖，净减少 438 行。详见 [CHANGELOG.md](../../CHANGELOG.md)。

### Phase 3：kira 集成后优化（6 项）

#### Bug 修复
- **`track_finished` UI 状态残留** (`playerStore.ts`)：后端 progress_loop 检测到播放完成时重置 state（Stopped/current_path=None），但前端 `track_finished` 监听器未同步 `isPlaying`。播放完最后一首（队列空）或 `playNext` 失败时，UI 残留"播放中"状态。修复：监听器开头 `set({ isPlaying: false })`，`playNext` 成功会重新 set 为 true

#### 防御性加固
- **进度轮询 task 泄漏** (`player.rs`)：AudioPlayer 释放后 progress_loop task 仍持有 Arc<Mutex>/Arc<RwLock> 泄漏。增加 `progress_task: JoinHandle` 字段，`impl Drop` 时 `abort()`
- **play 方法竞态** (`player.rs`)：快速切歌时多个 play 并发到达后端，旧音轨未 stop 即被新音轨覆盖，导致 StreamingSoundHandle 泄漏或进度回跳。增加 `play_lock: Arc<Mutex<()>>` 串行化整个 play 操作
- **dsd_decoder panic 风险** (`dsd_decoder.rs`)：3 处 `expect("could not convert ...")` 在极端情况下会 panic。改为 `try_into().map_err(FrameIndexOverflow)?`，新增 `DsdDecoderError::FrameIndexOverflow` 变体

#### 代码质量
- **精简 kira features** (`Cargo.toml`)：移除未使用的 mp3/flac/wav/ogg/vorbis，只保留 cpal，减少 kira 的 symphonia 0.5.4 依赖
- **get_state 锁优化** (`player.rs`)：合并 write+read 为单次 write 锁（3 次锁→2 次），降低与 progress_loop 的锁竞争

### Phase 4：深度优化（12 项，2026-06-27）

系统性审查前后端代码，完成 12 项优化（手搓代码→成熟库 + rayon 并行化 + N+1 消除 + 前端竞态/渲染优化）。详见 [CHANGELOG.md](../../CHANGELOG.md) Phase 4 小节。

#### Bug 修复（竞态）
- **`fetchLikedPaths`/`fetchHiddenPaths` 竞态** (`libraryStore.ts`)：快速刷新时旧响应可能覆盖新结果。增加独立 opId（与 fetchSongs 的 fetchOpId 隔离，避免互相失效）
- **`useScanProgress` listen 注册前卸载竞态** (`useScanProgress.ts`)：`listen()` 返回 Promise，组件在 resolve 前卸载时 unlisten 为 null 导致泄漏。增加 cancelled flag + unlisten 双保险

#### 防御性加固
- **`find_fallback_cover` 阻塞 async 线程** (`commands/song.rs`)：原实现混用同步 `Path::exists()` + async `fs::read().await`，`exists()` 在 async 线程上阻塞。整体移入 `spawn_blocking`，统一改用同步 `std::fs::read`，提取 `find_cover_in_dir` helper 消除 3 处重复循环
- **`PlayerBar` 过度订阅** (`PlayerBar.tsx`)：订阅整个 `likedPaths`/`hiddenPaths` Set，任意歌曲喜欢/隐藏变更都触发重渲染。改为仅订阅当前歌曲的布尔切片（zustand 对基础类型自动 `Object.is` 比较）

#### 性能优化
- **`get_song_covers_batch` N+1 查询** (`commands/song.rs` + `database.rs`)：N 次 `get_song_cover` 单条查询 → 1 次 `IN` 批量查询（新增 `Database::get_song_covers_batch`），缩略图创建改用 rayon `into_par_iter` 并行
- **`get_metadata_batch` 串行提取** (`commands/player.rs`)：`for` 循环 → rayon `into_par_iter` 并行元数据提取
- **`cleanup_nonexistent_songs` 串行检查** (`database.rs`)：两处 `into_iter` → `into_par_iter` 并行文件存在性检查

#### 手搓代码→成熟库
- **`useAlbumColor` 手搓 HSL/RGB** (`useAlbumColor.ts`)：73 行手搓 `hslToRgb`/`rgbToHsl`/`rgbToHex` → `colord` 库
- **`useUpdateCheck` 手搓 semver** (`useUpdateCheck.ts`)：手搓 `isNewerVersion`（Number 解析 + 逐段比较）→ `compare-versions` 库
- **`playQueueStore` 手搓 Fisher-Yates** (`playQueueStore.ts`)：22 行手搓 shuffle → `es-toolkit/shuffle`

#### 代码质量
- **`scan_folder` 重复查询** (`commands/song.rs`)：`validate_path_in_music_folder` 已返回 music_folder，移除后续重复 `db.get_setting("music_folder")` 查询
- **`PlaybackControls`/`VolumeControl` 缺少 memo** (`components/player/`)：父组件重渲染时子组件不必要更新，包裹 `React.memo`

## v0.9.0 UI 流畅度优化（2026-06-28）

UI 流畅度优化期间深度审查修复的资源管理、缓存一致性、死代码与 hook 稳定性问题。提交 `5ca4b8a`。

### coverStore 资源管理与缓存一致性
- **coverStore HMR dispose 清理** (`coverStore.ts`)：热更新时未清理 playerStore 订阅与 pending 请求，导致旧订阅残留。添加 `import.meta.hot.dispose` 钩子清理
- **`clearCoverStoreCache` 补 `path: null`** (`coverStore.ts`)：清缓存时未重置当前 path，切歌后旧 path 命中缓存。补 `path: null` 重置
- **封面缓存写入顺序** (`coverStore.ts`)：先 set state 再写缓存导致并发请求命中缓存前触发二次加载。调整为先写缓存再 set state
- **复用 `pendingRequests`** (`coverStore.ts`)：同一 path 并发请求未复用 pending promise 导致双倍请求。复用 `pendingRequests` Map singleflight
- **rescan 触发清缓存** (`coverStore.ts`)：重新扫描后旧封面缓存未清理，切歌仍显示旧封面。rescan 完成后调用 `clearCoverStoreCache`

### 死代码与冗余清理
- **`useMainBgColor`/`useAlbumColor` 死代码删除** (`views/`)：背景层独立后 5 个 View 中的调用变为死代码，移除
- **`will-change` 移除** (`LyricsView.tsx`)：封面 `motion.div` 多余 `willChange` 占用 GPU 内存，移除

### Hook 稳定性
- **`onShowShortcuts` useCallback** (`SettingsView.tsx`)：内联函数导致子组件 memo 失效，提取 `useCallback`

## v0.8.20 深度审查修复 + 手搓代码替换（2026-06-27）

### 深度审查修复（14 批，11 提交）

系统性深度审查覆盖前端 store、后端 player/database、UI 组件，修复 30+ 项真实 bug 与并发竞态。

#### 后端 — player.rs / database.rs / song.rs
- **`player_thread` 加 `catch_unwind` (C5)**：解码线程 panic 时静默退出，前端永久等待。捕获 panic 后 emit `playback_error` 并重置 state
- **`is_song_liked` 路径校验缺失**：缺少 `validate_path_in_music_folder` 入口校验，已补全
- **database.rs 安全与一致性**：`LIKE` 查询特殊字符（`%`/`_`/`\`）未转义导致意外匹配、`delete_song` 事务边界不清、外键级联未校验
- **player.rs 竞态与资源管理**：`seek_song` duration 无上界校验、`resume` 时 `sink=None` 未 emit `playback_error`、`stop` 后状态未重置
- **`finalizePlayHistory` 并发重复记录**：多次快速切歌时 `addPlayHistory` 并发调用导致历史记录重复，引入 mutex 串行化
- **`toggleLike`/`toggleHidden` 乐观更新竞态**：同 path 并发调用导致乐观更新错乱，引入 per-path 锁
- **冗余 clone 清理**：`commands/song.rs` 多处不必要 `clone()` 移除

#### 前端 — store / hook / UI
- **队列联动 + seek 反馈**：`playQueueStore` 视图切换队列联动、`seek` 失败 UI 回滚、`cleanup` 防护、空队列 toast 提示
- **LIKE 转义 + 定时器泄漏**：`useSongCover` `cleanupTimer` HMR 未清理、组件卸载保护、播放错误状态重置
- **前端竞态与状态一致性**：`playerStore`/`libraryStore`/`playQueueStore` 多处 `cancelled` flag、`AbortController`、selector 订阅粒度
- **`SettingsView` async unmount 守卫**：async handler 完成时组件已卸载导致 setState 警告，加 `cancelled` flag
- **`ProgressBar`/`VolumeControl` onWheel passive**：React `onWheel` 是 passive 监听器无法 `preventDefault`，改用原生 `addEventListener('wheel', { passive: false })`
- **`useSongCover` HMR dispose**：`cleanupTimer` 在 HMR 热更新时未清理导致定时器泄漏，加 `import.meta.hot.dispose` 钩子
- **scan 进度 UI + 播放器自愈 + 恢复歌曲兜底**：扫描进度分阶段显示、`OutputStream` 失效自愈、`restoreLastSong` 失败兜底
- **clippy 警告 + 测试隔离 + 防御性解构**：测试间状态隔离、`let _ =` 防御性解构避免 panic

#### CI/CD
- **CI tag 触发规则**：`v*` 和 `x.x.x` 格式 tag 均触发 build matrix
- **文档同步路径修正**：`sync-docs.sh` 适配 `jlocal/` 代码子目录 + 项目根 `docs/` 文档目录结构
- **五阶段代码审查基础设施**：ts-rs 10 类型生成 + `prebuild` 脚本 + pre-push 钩子类型同步检查 + `path_validator` 21 测试 + `build.yml` 拆分 `ci` 门禁 job

### 手搓代码替换（3 项）

引入成熟库替代手搓实现，每项替换后补充并发测试。

- **`withPathLock` → `async-mutex-lite`** (`libraryStore.ts`)：删除 15 行手搓 `pathOpLocks` Map + `withPathLock` 函数，改用 `mutex(path, fn)`。新增 2 个并发测试
- **`finalizePromise` → `mutex('play-history')`** (`playerStore.ts`)：删除手搓 promise 链，`finalizePlayHistory` 内部用 `mutex('play-history', fn)` 串行化。新增 1 个不并发测试
- **`useAlbumColor` 手搓缓存 + singleflight → `lru-cache` + `async-mutex-lite`** (`useAlbumColor.ts`)：`colorCache` Map + 手搓 FIFO 淘汰 → `LRUCache({max: 30})` 真 LRU（修复 FIFO≠LRU 语义错误）；`pendingExtractions` Map + 手搓 singleflight → `mutex(path, fn)` + double-check 缓存。新增 2 个 `toggleHidden` 并发串行测试

### 测试增长
- 前端 Vitest：142 → 147（+5）
- 后端 cargo test：36 → 47（+11）

---

## v0.8.19 安全修复 + 性能优化 + 五阶段代码审查（2026-06-24 ~ 2026-06-26）

### 后端安全
- **`path_validator` symlink TOCTOU 漏洞修复**：`is_path_in_music_folder` 在 `canonicalize` 失败时回退到 `normalize_path`（不解析符号链接），攻击者可在 music_folder 内创建指向 `/etc` 的符号链接绕过校验读取任意文件。移除 `normalize_path` 回退，改用二级文件夹符号链接白名单（`get_secondary_targets` 读取 music_folder 内符号链接的 canonicalize 目标）
- **统一 `get_music_folder_and_targets` 辅助函数**：消除所有调用方重复获取 music_folder + secondary_targets 的代码，`settings.rs`/`player.rs`/`song.rs`/`misc.rs`/`library.rs` 全部迁移

### 后端性能
- **增量扫描（基于 file_mtime）**：扫描时跳过 mtime 未变的文件，避免重复提取元数据（CPU 密集）。新增 `file_mtime` 列存储文件修改时间，`ScanResult` 增加 `skipped` 字段，前端 toast 显示"新增/更新 X 首，跳过 Y 首未变"
- **thumbnail 缓存 mtime 失效**：缩略图文件名加入源文件 mtime（`{hash}_{mtime}_{size}.jpg`），文件替换后 mtime 变化自动失效重新生成；旧 mtime 缩略图自动清理

### 五阶段代码审查（2026-06-26）

#### Stage 1 类型系统对齐
- **`mockApi.clearLogs` 返回类型不匹配**：返回 `Promise<void>` 但 realApi 返回 `Promise<number>`，`satisfies` 检查失败。改为 `Promise<number> => 0`
- **类型生成未集成构建流程**：`package.json` 添加 `prebuild` 脚本自动生成类型；pre-push 钩子添加类型同步检查

#### Stage 2 核心 bug 修复
- **`player.rs` first_play 标志位不一致**：解码失败时 `first_play` 未正确重置，导致后续 Play 不调 `s.stop()`。移除标志位，每次 Play 都 `s.stop()`
- **`player.rs` 解码失败时 current_path 不更新**：各失败路径 state 不一致。新增 `play_fail!` 宏统一重置 state + emit `playback_error`
- **`scanner.rs` 扫描零进度反馈**：大库扫描黑盒。注入 AppHandle，阶段 1 每 200 文件 emit `scan_progress`，阶段 2 rayon 并行 + AtomicUsize 每 50 个 emit
- **`playerStore.setVolume` 无范围限制**：UI 可能传越界值到后端。添加 `Math.max(0, Math.min(1, volume))` 钳制

#### Stage 3 安全加固
- **`withGlobalTauri: true` 增大 XSS 攻击面**：改为 `false`，前端环境检测改用 `__TAURI_INTERNALS__`（IPC 底层机制，不受开关影响）
- **CSP 缺 `object-src 'none'`**：禁止 plugin/embed/flash 载体
- **`path_validator` Windows 大小写敏感隐患**：`Path::starts_with` 大小写敏感但 Windows 文件系统不敏感，合法路径被拒。新增 `path_starts_with_ci` 做 component 级大小写不敏感比较

#### Stage 5 CI/CD 脚本修复
- **`generate-types.sh` 掩盖 cargo test 失败**：`set -e` 无 `pipefail` + `cargo test | grep ... || true` 三重掩盖，编译错误时旧 bindings 通过后置检查。改为 `set -eo pipefail`，移除 grep 和 `|| true`
- **pre-push 钩子吞错误输出**：`>/dev/null 2>&1` 改为只吞 stdout 保留 stderr；`git diff --quiet` 改用 `git status --porcelain` 检查含 untracked
- **`sync-docs.sh` BUGS.md 同步失效**：查找 "UI 版本也已到" 但文件无此文本（dead code），真正需同步的 `> 版本：vX.X.X` 未更新。改为更新版本行 + 最后更新日期

---

## v0.8.14 性能大修与 Panic 修复（2026-06-23）

### 后端 Panic（可导致应用崩溃）
- **`seek_song` Duration panic**：`Duration::from_secs_f64(time)` 在 time 为 NaN/Infinity/负数时 panic，导致 player 线程崩溃。入口添加 `is_finite() && >= 0.0` 校验
- **`flac_decoder` 除零 panic**：`tb.denom == 0` 时 `frames * numer / denom` 产生 infinity，`Duration::from_secs_f64(infinity)` panic。添加零检查 + `is_finite()` 守卫
- **`scanner` 除零**：同上，duration 可能变为 infinity 传播到前端

### 前端性能（60fps 重渲染消除）
- **LyricsView 60fps 重渲染**：订阅 `currentTime`（requestAnimationFrame 60fps 更新）导致整个组件每秒重渲染 60 次。改用 `usePlayerStore.subscribe` 外部监听，仅在歌词行索引变化时 `setLineIndex`，重渲染频率从 60 次/秒降为几次/分钟
- **LyricsView 内联 onClick**：每行歌词内联箭头函数每帧重建。改为 `data-time` 属性 + 单一事件委托
- **Store 订阅粒度**：PlayerBar 订阅整个 `usePlayerSettingsStore`/`usePlayQueueStore`/`useThemeStore`，SettingsView 订阅整个 `useOperationLogStore`，9 个组件订阅整个 `useThemeStore`。全部改为 selector 订阅派生值
- **SongList handlePlay**：依赖 `songs` 数组导致搜索/排序时所有列表项因 `onPlay` 变化全量重渲染。改为 ref 持有最新 songs

### 前端 Bug
- **`useUpdateCheck` 版本号 NaN**：`Number('3-beta')` 返回 NaN，`NaN > c` 永远为 false，导致 `hasUpdate` 永远为 false。添加 `Number.isNaN(n) ? 0 : n` 兜底
- **SettingsView `key={index}`**：副文件夹列表删除中间项时 React 错误复用组件导致 UI 错位。改为 `key={folder}`
- **SettingsView 数组越界**：`secondaryFolders[index]` 未检查 undefined，添加边界保护
- **main.tsx 非空断言**：`getElementById('root')!` 在 DOM 缺失时崩溃，改为显式检查 + 友好错误消息

### 后端输入校验
- **`add_log` level 无校验**：前端可传任意字符串作为日志级别。添加 `INFO`/`WARN`/`ERROR`/`DEBUG`/`TRACE` 白名单
- **`add_play_history` duration 允许负数**：添加 `duration < 0` 拒绝
- **`get_logs`/`get_play_history` limit 负数**：SQLite `LIMIT -1` 返回 0 行，用户误以为无数据。改为 `filter(|&l| l > 0)`

---

## v0.8.13 深度优化扫描修复（2026-06-23）

### 前端 Bug
- **`||` 覆盖合法 `0`/`false` 返回值**：6 个 API 模块（library/logs/settings/song/player）中 `|| []`/`|| 0`/`|| false` 误用，改为 `??` nullish coalescing
- **`invokeApi` 错误消息为 `"undefined"`**：`response.error` 为 undefined 时抛出字符串 `"undefined"`，改为带命令名的默认消息 + undefined data 校验
- **`useSongSort` 不安全类型断言**：`as T` 改为 `VALID_SORTS` 白名单 Set 运行时校验
- **`rgbToHsl` 除零**：纯黑颜色 `max+min=0` 导致除零，添加 denomLow/denomHigh 零检查
- **`ProgressBar` 除零**：`rect.width=0` 时除法产生 `Infinity`/`NaN`，添加提前返回守卫
- **`hexToRgba` NaN**：非法 hex 字符串 `parseInt` 产生 NaN，添加 NaN 检查回退到 `rgba(0,0,0,alpha)`
- **`shuffleTracksKeepCurrent` 边界**：currentIndex 越界时 `splice` 返回 `undefined` 并被 `unshift`，添加边界保护分支

### 后端优化
- **`cleanup_nonexistent_songs` N+1 DELETE**：5N 次降为每批 2 次（FK CASCADE 自动清理 play_counts/play_history/liked_songs）
- **`delete_song` 冗余 DELETE**：5 次降为 2 次（FK CASCADE）
- **`hide/unhide_songs_batch` N+1 循环**：改为批量 `IN` / 多值 INSERT（每批 500 条）
- **`main.rs` 同步 fs 阻塞异步运行时**：`std::fs::create_dir_all` 包裹 `spawn_blocking`
- **`Vec<Song>` 整体 clone**：`main.rs`/`commands/song.rs` 改为 `std::mem::take` 转移所有权

---

## v0.8.12 全面代码审查与质量改进（2026-06-22）

### 后端安全与质量
- **P0 `find_fallback_cover` 目录越权读取**：扫描 `artist_dir` 前校验其仍在 `music_folder` 内
- **阻塞 I/O 未隔离**：`probe_audio_file`、`get_lyrics`、批量路径校验全部改为 `spawn_blocking`
- **写锁范围过大**：`player.rs` 中 `emit` 操作移出 `blocking_write()` 作用域
- **thumbnail 失败静默**：`get_thumbnails_dir` 返回 `Result`，错误可传播
- **外键约束未启用**：数据库连接启用 `foreign_keys(true)` + WAL，保证级联删除
- **DB 写入错误被忽略**：主流程与设置页 `set_setting` 失败改为 `tracing::warn!`

### 前端 Bug 修复
- **60fps 全树重渲染**：7 个组件 `usePlayerStore()` / `useLibraryStore()` 改为独立 selector 订阅
- **事件订阅泄漏**：`eventUnlistenPromises` 模式 + `mediaSession` handler 清理
- **useSongCover HMR 泄漏**：模块级 `setInterval` 改为 `setTimeout` 链式清理
- **异步竞态**：`HistoryView`、`SettingsView` 添加 `cancelled` flag；`useUpdateCheck` 引入 `AbortController`
- **LyricsView setTimeout 泄漏**：滚动抑制 timer 在 useEffect cleanup 中清理

### 代码质量
- **API 错误处理重复**：新增 `invokeApi` 辅助函数，重构 6 个 API 模块
- **无障碍缺失**：15+ 图标按钮添加 `aria-label`；进度条/音量条添加 `role="slider"`
- **魔法数字/颜色分散**：音量步进、快进秒数、日志/历史限制、列表行高、主题色归入 `APP_CONFIG`

---

## v0.8.11 全面代码审查修复（2026-05-28）

### 同步 I/O 阻塞 tokio 执行器
- **问题**: `cleanup_nonexistent_songs`、`check_file_exists`、`play_song`、`add/remove_secondary_folder`、`get_thumbnail_info` 等异步命令中直接执行 `std::fs` 同步 I/O
- **修复方案**: 统一改为 `tokio::task::spawn_blocking`，避免阻塞异步运行时

### Tauri capabilities 权限过宽
- **问题**: 默认 capabilities 授予了 `shell:allow-open`、`dialog:default`、`fs:default`，但前端 JS 并未使用这些插件 API
- **修复方案**: 仅保留 `core:default` + `core:event:default`

### 未捕获的异步错误
- **问题**: `App.tsx` 初始化数据、`restoreLastSong` 中异步 API 失败会抛出未处理异常
- **修复方案**: 增加 try/catch 并给用户 toast 提示

### LyricsView 歌词行计算性能
- **问题**: `currentLineIndex` 使用 `useCallback` 且依赖 `currentTime`，每帧变化都重建回调函数
- **修复方案**: 改为 `useMemo` 直接计算 `lineIndex`

### 文档同步脚本路径错误
- **问题**: `scripts/sync-docs.sh` 假设 docs 在 `jlocal/docs/`，实际在项目根 `docs/`
- **修复方案**: 修正 `PROJECT_DIR` 和 package.json 路径

---

## v0.8.10 代码审查修复（2026-05-28）

### 🛡️ P0 安全修复

#### #1. `remove_secondary_folder` 路径遍历漏洞
- **问题**: `link_name` 参数未校验，恶意前端可传入 `../../../tmp/link` 删除任意符号链接
- **修复方案**: 新增 `is_safe_link_name()` 辅助函数校验 link_name 为单一路径组件 + canonicalize 二次验证拼接结果仍在 primary_folder 内

#### #2. `scan_folder` 无路径校验
- **问题**: `path` 参数未校验，恶意前端可扫描 `/`、`/etc` 等任意目录
- **修复方案**: 命令入口新增 `validate_path_in_music_folder(&db, &path)` 调用

#### #3. `add_secondary_folder` 允许链接到系统敏感目录
- **问题**: `target_path` 仅校验存在性，可创建指向 `/etc` `/System` `~/.ssh` 等敏感目录的符号链接
- **修复方案**: 新增 `is_sensitive_path()` 黑名单，拦截常见系统目录和用户敏感目录

#### #4. `is_path_in_music_folder` 使二级文件夹功能完全失效
- **问题**: 函数对路径调用 `canonicalize()` 解析符号链接到真实路径，导致 `music_folder/mylink/song.mp3` 校验失败，二级文件夹中的歌曲无法播放
- **修复方案**: 重构为先尝试 canonicalize，未匹配时回退到不解析符号链接的路径前缀校验

### 🐛 P1 Bug 修复

#### #5. `track_finished` 未 await `finalizePlayHistory`
- **问题**: 异步操作未等待完成即调用 `playNext`，播放历史可能乱序
- **修复方案**: `track_finished` 监听回调改为 `async` 函数，先 `await finalizePlayHistory(true)` 再 `playNext`

#### #6. `libraryStore` toggle 竞态
- **问题**: 快速双击喜欢按钮时两次都基于旧快照操作，最终状态错误
- **修复方案**: `toggleLike`/`toggleHidden` 改为乐观更新模式——先 `set` UI 状态再调 API，失败时回滚

#### #7. OutputStream 故障后前端无感知
- **问题**: 音频输出流恢复并重置后端状态时未通知前端，UI 仍显示"播放中"但后端已停止
- **修复方案**: 状态重置后 emit `playback_error` 事件，前端监听并设置 `isPlaying=false`

#### #8. `useSongCovers` useEffect 依赖数组问题
- **问题**: 依赖为 `paths` 数组，每次渲染都是新引用，触发重复批量请求
- **修复方案**: 提取 `pathsKey = paths.join(',')` 字符串作为依赖

#### #9. 播放器模块级状态 HMR 泄漏
- **问题**: `playOperationId`/`backendLoaded` 等模块级变量在 HMR 热更新时保留旧值
- **修复方案**: 新增 `import.meta.hot.dispose()` 钩子，热更新时调用 `resetModuleState()`

### 🧹 P2 修复

#### #10. `get_audio_file` 死代码内存风险
- **修复方案**: 删除该命令和前端封装（前端从未调用）

#### #11. `get_setting` 未校验 key
- **修复方案**: 入口新增 `ALLOWED_SETTING_KEYS` 白名单校验

#### #12. thumbnail 目录回退污染安装目录
- **修复方案**: `dirs::data_local_dir()` 失败时返回空路径而非回退到 `.`

#### #13. `set_volume` 未校验范围
- **修复方案**: 入口校验 `volume` 在 `0.0..=1.0` 范围内

#### #14. `seek` 失败 UI 状态不一致
- **修复方案**: seek 前保存 prevTime，失败时回滚

#### #15. `restoreLastSong` 未处理组件卸载
- **修复方案**: 新增 `cancelled` 标志，组件卸载后不再 set 状态

#### #16. `useAlbumColor` 未取消图片加载
- **修复方案**: 新增 `cancelled` 标志，effect cleanup 时置位

---

## v0.8.9 安全加固 + 精细修复（2026-05-11）

### 🛡️ 安全修复

#### #1. `get_song_covers_batch` 封面路径推导不安全
- **修复方案**: 不再依赖 `paths.first()` 推导 `music_folder`，改为通过 `db.get_setting("music_folder")` 直接读取数据库，每个路径独立调用 `validate_path_in_music_folder` 验证

#### #2. `hide_songs_batch` / `unhide_songs_batch` 缺少路径过滤
- **修复方案**: 批量操作前增加路径校验过滤循环，仅保留通过验证的路径写入数据库

### 🐛 Bug 修复

#### #3. 元数据提取失败覆盖已有正确数据
- **修复方案**: `process_normal_file` 在 Symphonia/lofty 均提取失败时改为 `return None`，而非创建 title="Unknown" 的 Song 对象

#### #4. OutputStream 超时恢复后首次播放延迟
- **修复方案**: Sink 重建后追加 440Hz SineWave 预热（与初始启动相同机制），确保音频管线就绪

### 🧹 代码简化
- 消除 Option 嵌套，`process_normal_file` 返回类型简化

---

## v0.8.8 代码审查修复（2026-05-11）

### P1 — 重要修复

#### #1. GitHub 仓库地址错误（3处）
- **修复方案**: `JereoZero/jlocal` → `JereoZero/JMusic`

#### #2. `copy_logs_to_clipboard` 语义不准确
- **修复方案**: 重命名为 `get_logs_as_text`

#### #3. `restoreLastSong` 未等待完成即初始化事件监听器
- **修复方案**: `App.tsx` 添加 `await restoreLastSong()` 确保启动恢复完成后才绑定事件

#### #4-#5. `get_song_covers_batch` / `get_song_play_count` 缺少路径验证
- **修复方案**: 新增 `validate_path_in_music_folder` 调用

### P2 — 次要修复

#### #6. `playRandomSong` 缺少 hidden 来源分支
- **修复方案**: 新增 hidden 歌曲随机播放逻辑

#### #7. `track_finished` 缺少竞态保护
- **修复方案**: 新增 `playOperationId` 检查防止过期事件处理

#### #8. `find_fallback_cover` 缺少路径校验
- **修复方案**: 新增路径验证

---

## v0.7.11 CI 修复记录（2026-05-09）

### 🔧 CI 构建修复
- GitHub Actions 中 `npm install` 因 peer dependency 冲突失败，导致 `tsc`/`vite build` 被阻断
- 修复：`npm install --legacy-peer-deps` 跳过严格依赖校验
- 验证：typecheck ✅ / lint ✅ / test 142/142 ✅ / cargo build ✅

### 📝 文档归档
- BUGS.md 从 406 行精简至 193 行，21 个 CODEX 详细条目移至本文件

---

## v0.7.10 CODEX 审查修复记录（2026-05-09）

### 🎯 CODEX 第一轮修复（CODEX-1 ~ CODEX-10）

| ID | 描述 | 修复 |
|----|------|------|
| CODEX-1 | 播放命令无法确认实际播放是否成功 | `play_song` 增加 `probe_audio_file()` 同步 Symphonia/Rodio 格式探测 |
| CODEX-2 | 默认音乐目录未写入 music_folder | `get_primary_music_folder` + 启动扫描均写入 DB |
| CODEX-3 | 单曲循环被下一首/上一首改成列表循环 | playNext/playPrev 不再修改 playMode |
| CODEX-4 | 搜索/排序后播放队列不一致 | 4 个 View 统一使用 filteredAndSortedSongs |
| CODEX-5 | ESLint 5 warnings 阻断 check | 删除未用 import、提取 playModeUtils、ReadonlyArray 替代 as any |
| CODEX-6 | 无封面歌曲残留旧封面 | !path 清空 cover；新路径无缓存时先清空 |
| CODEX-7 | 多个命令缺少路径校验 | check_file_exists/get_metadata/get_metadata_batch/get_lyrics 补全校验 |
| CODEX-8 | get_metadata_batch 结构不一致 | Rust 新增 BatchMetadata struct |
| CODEX-9 | add_secondary_folder Unix API 无 cfg | symlink 引用移入 #[cfg(unix)] 块 |
| CODEX-10 | 扫描不存在目录返回成功 | scan 前检查路径存在性和目录类型 |

### 🔧 CODEX 第二轮修复（CODEX-11 ~ CODEX-15）

| ID | 描述 | 修复 |
|----|------|------|
| CODEX-11 | rAF 和后端双重自动切歌 | rAF 只做进度显示；track_finished 先 stopProgressTimer |
| CODEX-12 | 播放历史计入暂停时间 | rAF delta 累计 accumulatedPlayedMs 替代 Date.now() |
| CODEX-13 | 歌词自动滚动触发用户滚动暂停 | suppressScrollRef 标记区分程序/用户滚动 |
| CODEX-14 | 前端版本号仍为 0.7.8 | config/index.ts 更新为 0.7.9 |
| CODEX-15 | 启动恢复调用真实播放接口 | restoreLastSong 只设置本地状态 |

### 🛠️ CODEX 第三轮修复（CODEX-16 ~ CODEX-23）

| ID | 描述 | 修复 |
|----|------|------|
| CODEX-16 | 更换主文件夹旧歌曲残留 | SettingsView 更换后调用 fetchSongs |
| CODEX-17 | 重扫描空封面覆盖缓存 | upsert_songs cover 使用 COALESCE(excluded.cover, songs.cover) |
| CODEX-18 | gen:types 路径错误 | 路径改为 ../src-tauri + set -e |
| CODEX-19 | Prettier 43 文件格式不通过 | npx prettier --write 全量格式化 |
| CODEX-20 | E2E 断言旧版本 | 更新断言为当前版本和可访问名称；图标按钮补 `aria-label`，测试用 `getByTitle` / `getByRole` |
| CODEX-21 | check_file_exists 不支持不存在文件 | is_path_in_music_folder 父目录 canonicalize 回退 |
| CODEX-22 | get_lyrics 扩展名校验缺失 | validate_audio_extension + 配置缺失/越权返回 err |
| CODEX-23 | MediaMetadata 构造器未判断 | typeof MediaMetadata === 'undefined' 守卫 |

---

## v0.7.9 性能优化记录（2026-05-09）

### 🔧 Rust 后端优化

#### OPT-1. player.rs 日志级别混乱
- **修复方案**: 7 处 `info!()` 用于错误场景修正为 `warn!()`/`error!()`：
  - 输出流创建失败 → `warn!`
  - 文件不存在 → `warn!`
  - Sink 创建失败 → `error!`
  - Symphonia/rodio 解码失败 → `warn!`
  - 文件打开失败 → `warn!`
  - Seek 失败 → `warn!`

#### OPT-2. scanner.rs 每首歌 info! 刷屏
- **修复方案**: `info!()` → `debug!()`

#### OPT-3. database.rs 播放历史高频 info!
- **修复方案**: `add_play_history()` 中 `info!()` → `debug!()`

#### OPT-4. scanner.rs Vec 无容量预分配
- **修复方案**: `Vec::new()` → `Vec::with_capacity(500/50/20)`

### ⚛️ React 前端优化

#### OPT-5. App.tsx 视图切换函数未 memo
- **修复方案**: `handleViewChange`/`handleToggleSettings`/`handleToggleLyrics` → `useCallback` + functional updater + ref

#### OPT-6. LocalView/LikedView 无意义内联箭头
- **修复方案**: `(path) => toggleHidden(path)` → 直接传 `toggleHidden`

#### OPT-7. libraryStore Set selector 导致连锁重渲染
- **修复方案**: 5 组件使用 `useShallow` selector，拆分为细粒度选择器

#### OPT-8. useSongSort 切换视图丢失排序
- **修复方案**: 新增 `viewKey` 参数 + `sessionStorage` 持久化

#### OPT-9. DSD 误判为不可播放
- **修复方案**: 从 `UNSUPPORTED_EXTENSIONS` 移除 `dsd`

---

## v0.7.8 稳定性修复记录（2026-05-08）

### 🛡️ 稳定性 Bug 修复

#### S1. App.tsx useEffect 未 cleanup
- **修复方案**: 添加 `cleanupEventListeners()` 清理定时器和事件监听器

#### S2. rAF 进度跟踪异步调用未 catch
- **修复方案**: 添加 `.catch()` 处理异步异常

#### S3. duration=0 覆盖有效状态
- **修复方案**: 添加 `maxTime <= 0` guard

#### S4-S6. 3 处 async 函数缺少 cancelled flag
- **修复方案**: LyricsView、LocalView 等添加 cancelled flag 模式

#### S7. animationFrameId 未重置
- **修复方案**: cleanup 内 `cancelAnimationFrame` 后重置为 null

### 🎨 主题色统一
- 15+ 处硬编码橙色 `#f97316` → 主题色变量
- 新增 `hexToRgba` 动态透明度工具

### ♻️ 成熟库替换（6 项，-216 行）
- Toast → sonner（-115 行）
- 颜色提取 → colorthief
- 快捷键 → react-hotkeys-hook
- 防抖 → es-toolkit
- 编码检测 → chardetng
- Rust 常量统一

---

## v0.7.7 修复记录（2026-05-07）

### 🔴 高严重度

#### #1. 双路进度更新导致播放时间回跳
- **修复方案**: 后端 `playback_progress` 事件不再无条件覆盖前端 rAF 推算的进度，改为阈值过滤：
  - 后端位置与本地推算差距 > 0.3s 才校正
  - 后端位置超前时立即同步（本地估算慢了）
  - 每 3 秒强制同步一次防止累积漂移
  - 时长 `duration` 始终信任后端权威值

#### #2. SongList 前端格式白名单遗漏多种已支持格式
- **修复方案**: 
  - 前后端格式常量统一管理，`SongList.tsx` 从 `constants/index.ts` 导入 `AUDIO_FORMATS`，消除重复维护
  - 前后端同时添加缺失格式：`aif`、`aiff`、`opus`、`caf`
  - 移除 `wma`/`ape` 从前端可播放列表（后端 `is_unsupported_format` 禁止播放）
  - `SUPPORTED_FORMATS` 改用 `Set<string>` 提升查找性能

#### #5. HistoryView 播放逻辑永远走 fallback
- **修复方案**: 移除无效的 `searchSongs(song.path)` 搜索，直接调用 `playSong(song)` 播放当前歌曲对象

---

### 🟠 中严重度

#### #6. player.rs 线程忙等空转耗电
- **修复方案**: 将 `tokio::sync::mpsc` 替换为 `std::sync::mpsc`，`try_recv() + sleep(50ms)` 替换为 `recv_timeout(Duration::from_millis(50))`，线程在无命令时阻塞等待而非空转轮询

#### #7. SettingsView `timeoutRefs` 无限增长（内存泄漏）
- **修复方案**: 将数组 ref 替换为单例 timeout ref，每次 `showMessage` 先清除旧的再设置新的，组件卸载时一并清理

#### #8. VolumeControl `previousVolume` 不同步
- **修复方案**: 添加 `useEffect` 监听 `volume` 变化，非静音状态下自动同步 `previousVolume`，确保键盘快捷键改音量后静音恢复值正确

#### #9. LyricsView `useEffect` 缺少依赖导致闭包过期
- **修复方案**: 使用 `useRef` 保存 `currentSong` 引用并在 effect 内读取，消除闭包过期问题，移除 `eslint-disable`

#### #10. `LyricSource` 前后端字段名不一致
- **修复方案**: Rust 结构体添加 `#[serde(rename = "type")]` 使序列化字段名与前端 `LyricSource.type` 一致，同时将 `"lrc_file"` 改为 `"external"` 对齐前端联合类型

---

### 🟡 低严重度

#### #11. `libraryStore.ts` 冗余代码
- **修复方案**: 删除 `toggleLikeWithContext` 和 `toggleHiddenWithContext` 冗余方法，更新 HiddenView/LocalView/LikedView 直接使用 `toggleLike`/`toggleHidden`

#### #12. 前后端音频格式常量不同步
- **修复方案**: 前端 `AUDIO_FORMATS.normal` 移除 `wma`/`ape`/`dsd`（不可播放），同步添加 `aif`/`aiff`/`opus`/`caf`；SongList 从 constants 统一导入

#### #13. 元数据提取失败静默忽略
- **修复方案**: `ScanResult` 新增 `metadata_errors: Vec<String>` 字段，`process_normal_file` 提取失败时记录详细错误信息并返回给前端

#### #14. `SymphoniaFlacDecoder` 命名误导
- **修复方案**: 全局重命名为 `SymphoniaDecoder`（flac_decoder.rs, player.rs）

#### #15. `database.rs` / `commands/player.rs` 无用代码
- **修复方案**: 前端从未调用 `play_next`/`play_prev` Tauri 命令，整条死代码链已删除：`api/modules/player.ts` → `commands/player.rs` → `database.rs`。同时清理 `main.rs` invoke_handler 引用和 `mock-api.ts` 对应方法

---

### 🔍 第二轮审查修复记录

#### #16. `removeFromQueue` 在 shuffle 模式下误删 `originalQueue`
- **修复方案**: `originalQueue` 从按 index 删除改为按 `path` 查找删除，确保 shuffle 模式下删除正确的歌曲

#### #17. 多处空 catch 块静默吞异常
- **修复方案**: LyricsView `seek()` 和 App `setVolume()` 的空 catch 替换为 `createErrorHandler()`，错误通过 toast 可见

#### #18. `console.error` 替代统一错误处理
- **修复方案**: playerStore.ts 和 SettingsView.tsx 共 19 处 `console.error` 全部替换为 `handleError(error, context)`，通过 toast 系统可见

#### #19. LyricsView `useEffect` 依赖列不完整
- **评估结论**: `api` 是模块级 `import * as api from`，运行时不可变。`currentSongRef` 模式已通过 ref 获取最新值，代码安全，无需修复

#### #20. `moveInQueue` 不更新 `originalQueue`
- **修复方案**: `moveInQueue` 同步更新 `originalQueue`，拖拽排序后取消 shuffle 不会恢复到旧顺序

#### #21. `lyrics.rs` 中可用 `if let` 替代 `is_ok() + unwrap()`
- **修复方案**: 改为 `if let Ok(utf8_str) = utf8_result { return utf8_str; }` 消除 `unwrap()`

---

### 🔍 第三轮审查修复记录（2026-05-08）

#### #22. 播放历史永远记录 duration=0, completed=false
- **修复方案**: 
  - 新增 `finalizePlayHistory(completed)` 函数，在切歌/停止时计算实际收听时长并写入数据库
  - `track_finished` 事件调用 `finalizePlayHistory(true)` 标记完整播放
  - `playSongInternal` 切歌前调用 `finalizePlayHistory(false)` 记录上一首实际收听时长
  - `stop()` 调用 `finalizePlayHistory(false)` 记录停止时的收听时长
  - 删除旧的无意义 `addPlayHistory(path, 0, false)` 调用

#### #23. `playback_progress` 发送 duration=0.0 损坏前端状态
- **修复方案**: 后端无法确定歌曲时长时发送 `duration: 0.0`，前端 `playback_progress` 处理器只在 `duration > 0` 时更新状态中的 duration，避免将正确的时长覆盖为 0

#### #24. playerStore.ts 剩余 console.error 替代统一错误处理
- **修复方案**: `resume()`、`setVolume()`、`updateMediaSession()`、`restoreLastSong()`、`playRandomSong()` 共 5 处 `console.error` 全部替换为 `handleError(error, context)`

#### #25. `copyDebugLogs` 缺少错误处理
- **修复方案**: `navigator.clipboard.writeText()` 改为 Promise 链式调用，`.catch()` 中显示 toast 错误提示

#### #26. SettingsView 两处错误上下文写错
- **修复方案**: `handleClearAllData` 中 `'清除缩略图'` → `'清除全部数据'`；`handleClearHiddenSongs` 中 `'清空数据库'` → `'清空隐藏列表'`

#### #27. `useAlbumColor.ts` console.log 留在生产代码
- **修复方案**: 移除 `console.log('Album colors - lyrics:', ...)` 调试输出

### 🔍 第四轮审查修复记录 — 文件夹/歌曲管理系统重构（2026-05-08）

#### #28. 删除副文件夹后歌曲成为孤儿数据永不清除

- **修复方案**（三处联动）:
  1. `database.rs` `cleanup_nonexistent_songs` 签名从 `(&self, base_folder: &str)` 改为 `(&self)`，去掉 `song.path.starts_with(base_folder)` 条件限制，改为全量检查所有歌曲文件是否存在
  2. `commands/song.rs` 调用处去掉 `base_folder` 参数
  3. `main.rs` 启动扫描调用处去掉 `base_folder` 参数
- **影响**: 副文件夹的歌曲路径不满足 `starts_with(base_folder)` 条件导致永不清理 → 修复后所有歌曲统一全量检查

#### #29. 符号链接 + `follow_links(true)` 可能导致重复扫描

- **修复方案**: `scanner.rs` 新增 `use std::collections::HashSet; use std::path::PathBuf;`，scan 函数中添加 `let mut visited: HashSet<PathBuf> = HashSet::new();`，对每个文件 `path.canonicalize()` 后 `visited.insert(canonical)` 去重。已存在的路径跳过处理。

#### #30. `upsert_songs` 静默丢弃插入失败的歌曲

- **修复方案**: `database.rs` `upsert_songs` 返回类型从 `Result<usize>` 改为 `Result<(usize, usize)>`，返回 `(成功数, 失败数)` 元组。调用方（`main.rs`, `commands/song.rs`）解构元组并 warn 错误数。

#### #31. `delete_song` 不级联清理关联表

- **修复方案**: `database.rs` `delete_song` 改为事务操作，先清理 `play_counts`, `play_history`, `liked_songs`, `hidden_songs` 四个关联表，再删除 `songs` 主表记录。

#### #32. 后端常量 `wma`/`ape` 前后矛盾

- **修复方案**: `constants.rs` 从 `NORMAL_AUDIO_EXTENSIONS` 移除 `wma`/`ape`；新增 `UNSUPPORTED_AUDIO_EXTENSIONS` 常量（`wma`, `ape`, `wv`, `wvc`, `tta`）；`is_audio_extension()` 增加检查 UNSUPPORTED 列表。

#### #33. SettingsView 两处 `console.error` 未替换为 `handleError`

- **修复方案**: `handleRemoveSecondaryFolder` 和 `handleRescan` 中的 `console.error(error)` 替换为 `handleError(error, '删除副文件夹')` / `handleError(error, '重新扫描')`。

#### #34. `addSecondaryFolder` 双重 toast 消息

- **修复方案**: 删除 `addSecondaryFolder` 中第一条 `showMessage('success', '已添加副文件夹')`，只保留扫描结果 toast。

#### #35. `removeSecondaryFolder` 后不自动清理歌曲

- **修复方案**: `handleRemoveSecondaryFolder` 删除副文件夹链接后，自动调用 `scanFolder(musicFolder)` + `fetchSongs()` 刷新歌曲列表。

---

## v0.8.0 Windows 平台修复记录（归档）

> 以下 Bug 因当前无 Windows 开发环境，状态为「跳过/未修复」，但已从活跃跟踪中归档。

| ID | 描述 | 文件 | 状态 |
|----|------|------|------|
| #3 | Windows 误判 junction 目录 | commands/misc.rs | 跳过（无 Windows 环境） |
| #4 | mklink 不检查退出码 | commands/misc.rs | 跳过（无 Windows 环境） |

---

## 修复统计

| 类别 | 数量 |
|------|------|
| 已修复（v0.7.7 第一轮） | 15 |
| 已修复（v0.7.7 第二轮） | 5 |
| 已修复（第三轮） | 6 |
| 已修复（第四轮 — 文件夹/歌曲管理） | 8 |
| 无需修复（误报） | 1 |
| 总计 | 35 |
| 代码净减少 | -190 行 |
| 死代码清除 | -305 行 |
