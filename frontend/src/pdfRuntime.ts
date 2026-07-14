// Android System WebView can trail desktop Chromium's newest typed-array APIs.
// PDF.js' legacy bundle supplies the same reader API plus the required
// standards polyfills (for example Uint8Array#toHex on WebView 133).
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// PDF.js resolves the standard PostScript font filenames relative to this
// directory. Vite serves it from node_modules in development and emits the
// same stable directory into the packaged build (see vite.config.js).
// Use the document origin explicitly. A static `new URL()` expression is
// rewritten by Vite as a single file asset, which drops the required trailing
// directory slash and makes PDF.js reject the factory URL.
export const standardFontDataUrl = `${globalThis.location.origin}/pdfjs-standard-fonts/`

export { getDocument }
export type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
