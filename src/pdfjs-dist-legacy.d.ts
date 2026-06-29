declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export type PdfJsViewport = {
    width: number
    height: number
  }

  export type PdfJsRenderTask = {
    promise: Promise<void>
  }

  export type PdfJsPage = {
    getViewport(input: { scale: number }): PdfJsViewport
    render(input: { canvasContext: unknown; viewport: unknown; background?: string }): PdfJsRenderTask
    cleanup?: () => void
  }

  export type PdfJsDocument = {
    numPages: number
    getPage(pageNumber: number): Promise<PdfJsPage>
    destroy?: () => Promise<void> | void
  }

  export function getDocument(input: unknown): {
    promise: Promise<unknown>
    destroy?: () => Promise<void> | void
  }
}
