import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/hota-voice-translator/',
  server: {
    host: '0.0.0.0',
    port: 5174
  }
  // PWA plugin will be added in Phase 3
})
