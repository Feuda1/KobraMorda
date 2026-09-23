import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/ws/dashboard': { target: 'ws://localhost:7130', ws: true },
      '/printer': 'http://localhost:7130',
      '/server': 'http://localhost:7130',
    },
  },
})
