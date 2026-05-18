/// <reference types="vitest" />
// @ts-nocheck

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { UserConfig as VitestUserConfig } from 'vitest/config'

// Inject defaults for the %VITE_DEFAULT_TITLE% / %VITE_DEFAULT_DESCRIPTION%
// placeholders in index.html when the env vars aren't set (#521). Without
// this, Vite would leave the literal "%VITE_DEFAULT_TITLE%" string in the
// built HTML, breaking the link-preview fallback we're trying to create.
//
// Self-hosters override by exporting the env vars at build time
// (typical Docker build pattern: --build-arg VITE_DEFAULT_TITLE="My Brand").
function htmlTitleDefaults(mode: string) {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const title = env.VITE_DEFAULT_TITLE || 'PicPeak'
  const description = env.VITE_DEFAULT_DESCRIPTION || 'Photo gallery shared with PicPeak.'
  return {
    name: 'html-title-defaults',
    transformIndexHtml(html: string) {
      return html
        .replaceAll('%VITE_DEFAULT_TITLE%', title)
        .replaceAll('%VITE_DEFAULT_DESCRIPTION%', description)
    },
  }
}

// https://vite.dev/config/
const config: VitestUserConfig = {
  plugins: [react(), htmlTitleDefaults(process.env.NODE_ENV || 'production')],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': ['lucide-react', 'react-toastify'],
        },
      },
    },
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    globals: true
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
      '/photos': {
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
    },
  }
}

export default defineConfig(config as any)
