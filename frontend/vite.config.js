import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'

const pdfStandardFontDir = new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
const pdfStandardFontFiles = new Set(readdirSync(pdfStandardFontDir))

function pdfStandardFonts() {
  return {
    name: 'folio-pdf-standard-fonts',
    configureServer(server) {
      server.middlewares.use('/pdfjs-standard-fonts', (request, response, next) => {
        const filename = decodeURIComponent((request.url || '').replace(/^\//, '').split('?')[0])
        if (!pdfStandardFontFiles.has(filename)) {
          next()
          return
        }
        response.setHeader('Content-Type', filename.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream')
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        response.end(readFileSync(new URL(filename, pdfStandardFontDir)))
      })
    },
    generateBundle() {
      for (const filename of pdfStandardFontFiles) {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs-standard-fonts/${filename}`,
          source: readFileSync(new URL(filename, pdfStandardFontDir)),
        })
      }
    },
  }
}

const tauriDevHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), pdfStandardFonts()],
  server: {
    // Tauri Android serves the dev page through its tauri.localhost origin.
    // Without an explicit HMR endpoint Vite derives `localhost` from that
    // origin, which points back at the emulator and leaves live reload offline.
    strictPort: true,
    hmr: tauriDevHost ? {
      protocol: 'ws',
      host: tauriDevHost,
      port: 5173,
    } : undefined,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        headers: {
          Origin: 'http://127.0.0.1:5173',
        },
      },
    },
  },
})
