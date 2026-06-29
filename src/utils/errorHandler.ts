import { toast } from 'sonner'

export class AppError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function handleError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : '操作失败'

  console.error(`[${context}]`, error)

  toast.error(message)
}

export function createErrorHandler(context: string) {
  return (error: unknown) => handleError(error, context)
}
