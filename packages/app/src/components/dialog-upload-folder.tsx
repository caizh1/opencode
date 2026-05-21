import { batch, createSignal, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useFile } from "@/context/file"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { readFileAsDataUrl, fileDisplayPath } from "@/utils/folder-traversal"

type UploadState = "select" | "uploading" | "done" | "error"

type UploadEntry = {
  file: File
  path: string
  size: number
  status: "pending" | "uploading" | "done" | "error"
  error?: string
}

export function DialogUploadFolder() {
  const sdk = useSDK()
  const fileContext = useFile()
  const dialog = useDialog()
  const language = useLanguage()

  const [state, setState] = createSignal<UploadState>("select")
  const [entries, setEntries] = createSignal<UploadEntry[]>([])
  const [targetDir, setTargetDir] = createSignal("")
  const [currentIndex, setCurrentIndex] = createSignal(0)
  const [errorMessage, setErrorMessage] = createSignal("")

  const reset = () => {
    batch(() => {
      setState("select")
      setEntries([])
      setTargetDir("")
      setCurrentIndex(0)
      setErrorMessage("")
    })
  }

  const handleFolderPick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const files = input.files
    if (!files || files.length === 0) return

    const uploadEntries: UploadEntry[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const path = fileDisplayPath(file)
      uploadEntries.push({ file, path, size: file.size, status: "pending" })
    }
    uploadEntries.sort((a, b) => a.path.localeCompare(b.path))
    setEntries(uploadEntries)
    setState("select")
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    const dataTransfer = e.dataTransfer
    if (!dataTransfer?.items) return

    const { traverseDataTransfer } = await import("@/utils/folder-traversal")
    const files = await traverseDataTransfer(dataTransfer)
    if (files.length === 0) return

    const uploadEntries: UploadEntry[] = []
    for (const file of files) {
      const path = fileDisplayPath(file)
      uploadEntries.push({ file, path, size: file.size, status: "pending" })
    }
    uploadEntries.sort((a, b) => a.path.localeCompare(b.path))
    setEntries(uploadEntries)
    setState("select")
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
  }

  const uploadFiles = async () => {
    const items = entries()
    if (items.length === 0) {
      showToast({ title: language.t("dialog.uploadFolder.empty") })
      return
    }

    setState("uploading")
    setErrorMessage("")

    let done = 0
    let failed = 0

    for (let i = 0; i < items.length; i++) {
      setCurrentIndex(i)
      const entry = items[i]
      setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, status: "uploading" } : e)))

      try {
        const dataUrl = await readFileAsDataUrl(entry.file)
        if (!dataUrl) throw new Error("Failed to read file")

        const dir = targetDir().trim()
        const filePath = dir ? `${dir}/${entry.path}` : entry.path

        const result = await sdk.client.file.write({
          path: filePath,
          content: dataUrl,
          encoding: "base64",
        })

        if (result.error) throw new Error(String(result.error))
        setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, status: "done" } : e)))
        done++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setEntries((prev) =>
          prev.map((e, idx) => (idx === i ? { ...e, status: "error", error: message } : e)),
        )
        failed++
      }
    }

    if (failed === 0) {
      setState("done")
      fileContext.tree.refresh("")
    } else if (done === 0) {
      setErrorMessage(language.t("dialog.uploadFolder.allFailed"))
      setState("error")
    } else {
      setState("done")
      fileContext.tree.refresh("")
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const totalSize = () => entries().reduce((sum, e) => sum + e.size, 0)
  const doneCount = () => entries().filter((e) => e.status === "done").length
  const errorCount = () => entries().filter((e) => e.status === "error").length

  return (
    <Dialog
      title={language.t("dialog.uploadFolder.title")}
      action={
        <Show when={state() !== "uploading"}>
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              dialog.close()
            }}
          >
            <Icon name="close" size="small" />
          </Button>
        </Show>
      }
    >
      <div
        class="flex flex-col gap-3 min-w-0"
        onDragOver={handleDragOver}
        onDrop={state() === "select" ? handleDrop : undefined}
      >
        <Show when={state() === "select" || (state() === "done" && entries().length > 0)}>
          <div class="flex items-center gap-2">
            <label class="flex-1 flex flex-col gap-1">
              <span class="text-12-regular text-text-weak">
                {language.t("dialog.uploadFolder.target.label")}
              </span>
              <input
                type="text"
                class="w-full h-8 px-2 text-13-regular rounded bg-background-base border border-border-weaker-base text-text-base placeholder:text-text-weak focus:outline-none focus:border-border-focus"
                placeholder={language.t("dialog.uploadFolder.target.placeholder")}
                value={targetDir()}
                onInput={(e) => setTargetDir(e.currentTarget.value)}
              />
            </label>
          </div>
        </Show>

        <Show when={state() === "select"}>
          <div
            class="flex flex-col items-center justify-center gap-2 p-6 border border-dashed border-border-weaker-base rounded cursor-pointer hover:border-border-default transition-colors"
          >
            <input
              type="file"
              {...({ webkitdirectory: "" }) as any}
              class="hidden"
              id="folder-upload-input"
              onChange={handleFolderPick}
            />
            <label for="folder-upload-input" class="flex flex-col items-center gap-2 cursor-pointer">
              <div class="flex items-center justify-center size-10 rounded bg-background-stronger">
                <Icon name="folder" size="medium" />
              </div>
              <span class="text-13-regular text-text-weak text-center">
                {language.t("dialog.uploadFolder.dropHint")}
              </span>
            </label>
          </div>
        </Show>

        <Show when={entries().length > 0}>
          <div class="flex items-center justify-between text-12-regular text-text-weak px-1">
            <span>
              {entries().length} {language.t("dialog.uploadFolder.fileCount")}
            </span>
            <span>{formatSize(totalSize())}</span>
          </div>
          <div class="max-h-40 overflow-y-auto border border-border-weaker-base rounded bg-background-base">
            <For each={entries().slice(0, 100)}>
              {(entry) => (
                <div class="flex items-center gap-2 px-2 py-1 text-12-regular border-b border-border-weaker-base last:border-b-0">
                  <Show
                    when={entry.status === "done"}
                    fallback={
                      <Show when={entry.status === "error"}>
                        <div class="size-3 shrink-0 rounded-full bg-red-500" />
                      </Show>
                    }
                  >
                    <div class="size-3 shrink-0 rounded-full bg-green-500" />
                  </Show>
                  <span class="truncate flex-1 min-w-0">{entry.path}</span>
                  <span class="shrink-0 text-text-weak">{formatSize(entry.size)}</span>
                </div>
              )}
            </For>
            <Show when={entries().length > 100}>
              <div class="px-2 py-1 text-12-regular text-text-weak">
                {language.t("dialog.uploadFolder.moreFiles").replace("{count}", String(entries().length - 100))}
              </div>
            </Show>
          </div>
        </Show>

        <Show when={state() === "uploading"}>
          <div class="text-13-regular text-text-weak text-center">
            {language.t("dialog.uploadFolder.progress")
              .replace("{current}", String(doneCount() + errorCount()))
              .replace("{total}", String(entries().length))}
          </div>
          <div class="h-1 rounded-full bg-background-stronger overflow-hidden">
            <div
              class="h-full bg-blue-500 transition-all duration-200"
              style={{ width: `${((doneCount() + errorCount()) / Math.max(1, entries().length)) * 100}%` }}
            />
          </div>
        </Show>

        <Show when={state() === "done"}>
          <div class="text-13-regular text-text-weak text-center">
            {language.t("dialog.uploadFolder.success")
              .replace("{count}", String(doneCount()))}
            <Show when={errorCount() > 0}>
              {" "}
              {language.t("dialog.uploadFolder.partialError")
                .replace("{count}", String(errorCount()))}
            </Show>
          </div>
        </Show>

        <Show when={state() === "error"}>
          <div class="text-13-regular text-red-500 text-center">{errorMessage()}</div>
        </Show>

        <div class="flex items-center justify-end gap-2 pt-2">
          <Show when={state() === "select" || state() === "error"}>
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("dialog.uploadFolder.action.cancel")}
            </Button>
          </Show>
          <Show when={state() === "select" && entries().length > 0}>
            <Button onClick={uploadFiles}>
              {language.t("dialog.uploadFolder.action.upload")}
            </Button>
          </Show>
          <Show when={state() === "done" || state() === "error"}>
            <Button
              onClick={() => {
                reset()
              }}
            >
              {language.t("dialog.uploadFolder.action.another")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
