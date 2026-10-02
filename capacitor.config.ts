import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.novakoko.app',
  appName: 'NOVAKOKO',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
