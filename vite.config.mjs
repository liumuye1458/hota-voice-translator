import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/hota-voice-translator/',
  define: {
    // Inject build timestamp so user can verify they're on the latest deployment
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' '))
  },
  server: {
    host: '0.0.0.0',
    port: 5174
  }
})
