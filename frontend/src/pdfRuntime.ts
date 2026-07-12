// Android System WebView can trail desktop Chromium's newest typed-array APIs.
// PDF.js' legacy bundle supplies the same reader API plus the required
// standards polyfills (for example Uint8Array#toHex on WebView 133).
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export { getDocument }
export type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
