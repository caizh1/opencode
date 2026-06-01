import type { FileContent } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import {
  dataUrlFromMediaValue,
  documentBytesFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  type MediaKind,
  mediaKindFromPath,
  normalizeMimeType,
  svgNaturalSizeFromValue,
  textFromMediaValue,
} from "../pierre/media"
import { MermaidPreview, ZoomableMediaPreview } from "./mermaid-viewer"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  deleted?: boolean
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: MediaKind }) => void
}

function mediaValue(cfg: FileMediaOptions) {
  if (cfg.current !== undefined) return cfg.current
  return cfg.after ?? cfg.before
}

function DocxPreview(props: { bytes: Uint8Array; label: string; onLoad?: () => void; onError?: () => void }) {
  let body!: HTMLDivElement
  let style!: HTMLDivElement
  const i18n = useI18n()
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")

  createEffect(() => {
    const bytes = props.bytes
    let active = true
    setState("loading")
    body.replaceChildren()
    style.replaceChildren()

    void import("docx-preview")
      .then((docx) =>
        docx.renderAsync(bytes, body, style, {
          breakPages: true,
          className: "docx",
          inWrapper: true,
          useBase64URL: true,
        }),
      )
      .then(
        () => {
          if (!active) return
          setState("ready")
          props.onLoad?.()
        },
        () => {
          if (!active) return
          setState("error")
          props.onError?.()
        },
      )

    onCleanup(() => {
      active = false
      body.replaceChildren()
      style.replaceChildren()
    })
  })

  return (
    <div class="relative overflow-x-auto bg-background-stronger px-4 py-4">
      <Show when={state() === "loading"}>
        <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
          {i18n.t("ui.fileMedia.state.loading", { kind: props.label })}
        </div>
      </Show>
      <Show when={state() === "error"}>
        <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
          {i18n.t("ui.fileMedia.state.error", { kind: props.label })}
        </div>
      </Show>
      <div classList={{ hidden: state() === "error" }}>
        <div ref={(el) => (style = el)} />
        <div ref={(el) => (body = el)} />
      </div>
    </div>
  )
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
  const cfg = () => props.media
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (media.deleted) return true
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio" && k !== "svg")) return
    return dataUrlFromMediaValue(mediaValue(media), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio" && k !== "svg" && k !== "document")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (k !== "document" && direct()) return
    if (!media.path || !media.readFile) return

    return {
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    }
  })

  const [loaded] = createResource(request, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        if (input.kind === "document") {
          const document = documentBytesFromMediaValue(result)
          if (!document) {
            input.onError?.({ kind: input.kind })
            return { key: input.key, error: true as const }
          }
          return { key: input.key, document }
        }

        const src = dataUrlFromMediaValue(result, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          return { key: input.key, error: true as const }
        }

        return {
          key: input.key,
          src,
          mime: input.kind === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
          size: input.kind === "svg" ? svgNaturalSizeFromValue(result) : undefined,
        }
      },
      () => {
        input.onError?.({ kind: input.kind })
        return { key: input.key, error: true as const }
      },
    )
  })

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })
  const documentBytes = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "document") return
    const value = remote()
    return documentBytesFromMediaValue(mediaValue(media)) ?? (value && "document" in value ? value.document : undefined)
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (documentBytes()) return "ready" as const
    if (!request()) return "idle" as const
    if (loaded.loading) return "loading" as const
    if (remote()?.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })

  const svgSize = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    const value = remote()
    return svgNaturalSizeFromValue(mediaValue(media)) ?? (value && "size" in value ? value.size : undefined)
  })

  const mermaidSource = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "mermaid") return
    return textFromMediaValue(media.current !== undefined ? media.current : media.after ?? media.before)
  })

  const kindLabel = (value: MediaKind) => {
    if (value === "image") return i18n.t("ui.fileMedia.kind.image")
    if (value === "audio") return i18n.t("ui.fileMedia.kind.audio")
    if (value === "svg") return i18n.t("ui.fileMedia.kind.svg")
    if (value === "document") return i18n.t("ui.fileMedia.kind.document")
    return i18n.t("ui.fileMedia.kind.mermaid")
  }

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              return (
                <ZoomableMediaPreview
                  src={value()}
                  alt={cfg()?.path}
                  class="bg-background-stronger px-6 py-4"
                  onLoad={onLoad}
                />
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={audioMime()} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            if (!media || kind() !== "svg") return props.fallback()
            const label = kindLabel("svg")

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const size = svgSize()
            return (
              <ZoomableMediaPreview
                src={value()}
                alt={cfg()?.path}
                naturalWidth={size?.width}
                naturalHeight={size?.height}
                class="bg-background-stronger px-6 py-4"
                onLoad={onLoad}
              />
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "mermaid"}>
        <Show when={mermaidSource()} fallback={props.fallback()}>
          {(source) => (
            <MermaidPreview
              code={source()}
              class="bg-background-stronger px-6 py-4"
              onLoad={onLoad}
              loading={
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: kindLabel("mermaid") })}
                </div>
              }
              fallback={() => props.fallback()}
            />
          )}
        </Show>
      </Match>
      <Match when={kind() === "document"}>
        <Show
          when={documentBytes()}
          fallback={(() => {
            const media = cfg()
            if (!media || kind() !== "document") return props.fallback()
            const label = kindLabel("document")

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(bytes) => (
            <DocxPreview
              bytes={bytes()}
              label={kindLabel("document")}
              onLoad={onLoad}
              onError={() => cfg()?.onError?.({ kind: "document" })}
            />
          )}
        </Show>
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
