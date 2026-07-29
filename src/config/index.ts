export const APP_CONFIG = {
  version: '0.9.1',
  name: 'JlocalMusic',
  repository: 'https://github.com/JereoZero/JMusic',
  releasesUrl: 'https://github.com/JereoZero/JMusic/releases',

  player: {
    defaultVolume: 0.8,
    progressUpdateInterval: 500,
    coverCacheSize: 200,
    coverCacheTTL: 1000 * 60 * 60,
    volumeStep: 0.1,
    volumeWheelStep: 0.005,
    seekStepSecs: 5,
    seekWheelStepSecs: 0.5,
  },

  toast: {
    duration: 4000,
  },

  ui: {
    logFetchLimit: 100,
    historyFetchLimit: 100,
    songItemHeight: 56,
    virtualizerOverscan: 8,
  },

  theme: {
    primary: '#f97316',
    background: '#121212',
    surface: '#181818',
    surfaceLight: '#1a1a1a',
    border: '#2a2a2a',
    trackBackground: '#4a4a4a',
    iconInactive: '#71717a',
    text: {
      primary: '#ffffff',
      secondary: '#9ca3af',
      muted: '#6b7280',
    },
  },

  scan: {
    minDurationSecs: 30,
  },
} as const
