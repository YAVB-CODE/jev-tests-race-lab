import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Backend (server/index.ts) holds the API keys and talks to OpenAI / OpenCode Zen.
      '/api': 'http://localhost:8787',
    },
  },
})
