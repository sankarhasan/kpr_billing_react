import type { KprApi } from './index'

declare global {
  interface Window {
    /** KPR Billing secure IPC bridge (exposed by the preload script). */
    kpr: KprApi
  }
}

export {}
