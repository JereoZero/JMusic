import { invokeApi } from './types'

export async function playSong(path: string): Promise<void> {
  await invokeApi<void>('play_song', { path })
}

export async function pauseSong(): Promise<void> {
  await invokeApi<void>('pause_song')
}

export async function resumeSong(): Promise<void> {
  await invokeApi<void>('resume_song')
}

export async function stopSong(): Promise<void> {
  await invokeApi<void>('stop_song')
}

export async function seekSong(time: number): Promise<void> {
  await invokeApi<void>('seek_song', { time })
}

export async function setVolume(volume: number): Promise<void> {
  await invokeApi<void>('set_volume', { volume })
}
