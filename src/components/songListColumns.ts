export interface SongListColumnConfig {
  showLike: boolean
  showHide: boolean
}

export function getSongListGridColumns({ showLike, showHide }: SongListColumnConfig): string {
  const columns = ['40px', '1fr', '128px']
  if (showLike) columns.push('40px')
  if (showHide) columns.push('40px')
  columns.push('64px')
  return columns.join(' ')
}
