import { invokeApi } from './types'
import type { BackendPlayerState, Metadata } from './types'

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

export async function getPlayerState(): Promise<BackendPlayerState> {
  return await invokeApi<BackendPlayerState>('get_player_state')
}

export async function getMetadata(path: string): Promise<Metadata> {
  return await invokeApi<Metadata>('get_metadata', { path })
}

export async function getMetadataBatch(
  paths: string[]
): Promise<Array<{ path: string; metadata: Metadata }>> {
  return (await invokeApi<Array<{ path: string; metadata: Metadata }>>('get_metadata_batch', { paths })) ?? []
}
