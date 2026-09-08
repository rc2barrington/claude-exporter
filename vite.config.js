import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { localSessionsMiddleware } from './server/localSessions.js'

// `npm run build`            -> GitHub Pages bundle under /ai-chat-exporter/
// `npm run build:standalone` -> single self-contained dist/index.html for fully offline use
export default defineConfig(({ mode }) => {
  const isStandalone = mode === 'standalone'
  return {
    plugins: [react(), { name: 'local-session-reader', configureServer(server) {
      server.middlewares.use(localSessionsMiddleware())
    } }, ...(isStandalone ? [viteSingleFile()] : [])],
    base: isStandalone ? './' : '/ai-chat-exporter/',
    build: isStandalone
      ? {
          outDir: 'dist-standalone',
          assetsInlineLimit: 100000000,
          chunkSizeWarningLimit: 100000000,
          cssCodeSplit: false,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {},
    test: {
      environment: 'node',
      include: ['tests/**/*.test.js'],
    },
  }
})
