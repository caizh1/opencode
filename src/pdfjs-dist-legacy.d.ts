declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export function getDocument(input: unknown): {
    promise: Promise<unknown>
    destroy?: () => Promise<void> | void
  }
}
