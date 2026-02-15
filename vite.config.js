import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'public',
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8090',
      '/hls': 'http://localhost:8090',
      '/webrtc': 'http://localhost:8090',
      '/sources': 'http://localhost:8090',
      '/streams': 'http://localhost:8090',
      '/ogc': 'http://localhost:8090',
    }
  }
})