<div align="center">
  <img src="logo/Jlogo.PNG" alt="JlocalMusic Logo" width="120"/>
  <h1>JlocalMusic Music Player</h1>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)

<div align="right">
  <a href="README-zh.md">🇨🇳 中文</a>
</div>

A local music player built with Tauri 2 + React 19, focused on a clean and efficient local music management experience.

<div align="center">
  <table>
    <tr>
      <td><img src="screenshots/本地音乐.png" alt="Local Music" width="380"/></td>
      <td><img src="screenshots/我喜欢.png" alt="Liked Songs" width="380"/></td>
      <td><img src="screenshots/播放历史.png" alt="Play History" width="380"/></td>
    </tr>
    <tr>
      <td align="center"><b>🎵 Local Music</b></td>
      <td align="center"><b>❤️ Liked Songs</b></td>
      <td align="center"><b>📋 Play History</b></td>
    </tr>
    <tr>
      <td><img src="screenshots/歌词界面.png" alt="Lyrics View" width="380"/></td>
      <td><img src="screenshots/歌曲播放.png" alt="Playing" width="380"/></td>
      <td><img src="screenshots/歌曲暂停.png" alt="Paused" width="380"/></td>
    </tr>
    <tr>
      <td align="center"><b>🎤 Lyrics View</b></td>
      <td align="center"><b>▶️ Playing</b></td>
      <td align="center"><b>⏸️ Paused</b></td>
    </tr>
    <tr>
      <td><img src="screenshots/专辑封面改变背景颜色.png" alt="Album Cover Background" width="380"/></td>
      <td><img src="screenshots/不同颜色专辑的效果.png" alt="Different Album Colors" width="380"/></td>
      <td><img src="screenshots/设置.png" alt="Settings" width="380"/></td>
    </tr>
    <tr>
      <td align="center"><b>🎨 Album Cover Background</b></td>
      <td align="center"><b>🌈 Different Album Colors</b></td>
      <td align="center"><b>⚙️ Settings</b></td>
    </tr>
    <tr>
      <td><img src="screenshots/本地歌单.png" alt="Local Playlist" width="380"/></td>
      <td><img src="screenshots/隐藏歌曲.png" alt="Hidden Songs" width="380"/></td>
      <td></td>
    </tr>
    <tr>
      <td align="center"><b>📁 Local Playlist</b></td>
      <td align="center"><b>🙈 Hidden Songs</b></td>
      <td></td>
    </tr>
  </table>
</div>

## ✨ Features

- 🚀 **Lightweight & Fast** - Built with Tauri 2, small bundle size, quick startup
- 🎵 **Wide Format Support** - MP3, FLAC, WAV, DSF, DFF, OGG, AAC, M4A and more
- 🎤 **Lyrics Support** - LRC lyrics files and embedded lyrics with auto-scroll
- 🎨 **Theme System** - 5 themes (Blue, Orange, Khaki, Gray Blue, Olive Green, Neon Green), dynamic background colors
- 🔒 **Privacy First** - All data stored locally
- 📁 **Smart Management** - Multi-folder support, auto-cleanup deleted songs
- ▶️ **Independent Play Queues** - Each view (Local/Liked/Hidden/History) has its own play queue

## 🖱️ Interactions

- 🖱️ **Scroll to Seek** - Hover over the progress bar and scroll the mouse wheel to fast-forward/rewind
- 🔊 **Scroll to Adjust Volume** - Hover near the volume bar and scroll the mouse wheel to adjust volume
- 🎤 **Click Album to Play/Pause** - Click the album cover in the lyrics view to toggle play/pause
- 🔄 **Mini Icon for Lyrics** - Click the small album icon in the bottom-left to enter or exit the lyrics view
- 👁️ **Hover to Reveal Lyrics** - Hover the mouse over the lyrics view to display all lyrics clearly
- ✋ **Drag Lyrics to Seek** - Drag the lyrics to a specific line to start playing from that position

> 💡 Currently developed and tested on macOS Apple Silicon. Windows/Linux support coming soon.

## 🎼 Supported Formats

| Format | Extensions | Status |
|--------|------------|--------|
| MP3 | .mp3 | ✅ Full Support |
| FLAC | .flac | ✅ Full Support |
| WAV | .wav | ✅ Full Support |
| DSF/DSD | .dsf, .dff, .dsd | ✅ Full Support |
| OGG Vorbis | .ogg, .oga | ✅ Full Support |
| AAC/M4A | .aac, .m4a | ✅ Full Support |
| NCM | .ncm | ⚠️ Recognition only, auto-hidden |
| QMC | .qmc, .qmc0, .qmc3 | ⚠️ Recognition only, auto-hidden |

## 🛠️ Tech Stack

### Backend (Rust)
- **Tauri 2** - Cross-platform desktop framework
- **SQLite + sqlx** - Lightweight database
- **rodio + Symphonia** - Audio playback and decoding
- **lofty** - Audio metadata extraction
- **tokio** - Async runtime

### Frontend (React)
- **React 19** - UI library
- **TypeScript** - Type safety
- **Tailwind CSS** - Utility-first CSS
- **Zustand** - Lightweight state management
- **Lucide React** - Icon library
- **sonner** - Toast notifications
- **colorthief** - Album cover color extraction
- **react-hotkeys-hook** - Keyboard shortcuts
- **es-toolkit** - Debounce/throttle utilities

## 📦 Project Structure

```
Jlocal/
├── src/                    # Frontend code
│   ├── api/                # API wrappers
│   ├── components/         # Reusable components
│   ├── stores/             # State management (Zustand)
│   ├── views/              # Page views
│   └── hooks/              # Custom hooks
├── src-tauri/              # Backend code (Rust)
│   ├── src/
│   │   ├── commands/       # Tauri commands
│   │   ├── database.rs     # Database operations
│   │   ├── player.rs       # Audio player
│   │   ├── scanner.rs      # Folder scanning
│   │   └── metadata.rs     # Metadata extraction
│   └── icons/              # App icons
├── public/                 # Static assets
└── docs/                   # Documentation
```

## 🚀 Development

### Prerequisites
- Node.js 18+
- Rust 1.70+
- macOS (Apple Silicon)

### Local Setup

```bash
# Clone repository
git clone https://github.com/your-username/jlocal.git
cd jlocal

# Install dependencies
npm install

# Development mode
npm run tauri:dev

# Build
npm run tauri:build
```

### Common Commands

```bash
npm run dev          # Frontend development
npm run typecheck    # Type checking
npm test             # Run tests
npm run lint         # Linting
```

## 🛠️ Built With

This project uses the following open source libraries:

### Frontend
- [React](https://react.dev) - UI Framework (MIT)
- [TypeScript](https://www.typescriptlang.org) - Programming Language (Apache 2.0)
- [Tailwind CSS](https://tailwindcss.com) - CSS Framework (MIT)
- [Zustand](https://zustand-demo.pmnd.rs) - State Management (MIT)
- [Lucide React](https://lucide.dev) - Icons (ISC)
- [sonner](https://sonner.emilkowal.ski) - Toast Notifications (MIT)
- [colorthief](https://github.com/lokesh/color-thief) - Color Extraction (MIT)
- [react-hotkeys-hook](https://github.com/JohannesKlauss/react-hotkeys-hook) - Keyboard Shortcuts (MIT)
- [es-toolkit](https://es-toolkit.slash.page) - Utilities (MIT)
- [Vite](https://vitejs.dev) - Build Tool (MIT)
- [Vitest](https://vitest.dev) - Testing Framework (MIT)

### Backend
- [Tauri](https://tauri.app) - Desktop Framework (MIT/APACHE-2.0)
- [Rust](https://www.rust-lang.org) - Programming Language (MIT/APACHE-2.0)
- [rodio](https://docs.rs/rodio/) - Audio Playback (MIT)
- [Symphonia](https://github.com/pcherten/Symphonia) - Audio Decoding (MPL 2.0)
- [lofty](https://docs.rs/lofty/) - Audio Metadata (MIT)
- [sqlx](https://github.com/launchbadge/sqlx) - Database (MIT/APACHE-2.0)
- [tokio](https://tokio.rs) - Async Runtime (MIT)
- [chardetng](https://docs.rs/chardetng) - Encoding Detection (MIT/APACHE-2.0)

## 🤝 Contributing

Issues and Pull Requests are welcome!

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## 📄 License

[MIT License](LICENSE)

---

*Made with ❤️ using Tauri + React*
