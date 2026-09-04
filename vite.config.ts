import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // strictPort on purpose: without it Vite silently walks to the next port and
  // the tab already open keeps showing the OTHER server.
  server: { port: 5180, strictPort: true },
  build: { outDir: 'dist' },
})
