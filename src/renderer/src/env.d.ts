/// <reference types="vite/client" />

import type { WorkLensApi } from '@shared/contracts'

declare global {
  interface Window {
    worklens: WorkLensApi
  }
}

export {}
