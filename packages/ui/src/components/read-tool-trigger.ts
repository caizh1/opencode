import { getFilename } from "@opencode-ai/core/util/path"
import type { UiI18n } from "../context/i18n"

export function readToolStatusTitle(status: string | undefined, i18n: Pick<UiI18n, "t">) {
  if (status === "pending" || status === "running") return i18n.t("ui.tool.read.running")
  if (status === "completed") return i18n.t("ui.tool.read.completed")
  if (status === "error") return i18n.t("ui.tool.read.error")
  return i18n.t("ui.tool.read")
}

export function readToolTrigger(
  input: Record<string, unknown>,
  status: string | undefined,
  title: string | undefined,
  i18n: Pick<UiI18n, "t">,
) {
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined
  const args: string[] = []
  if (offset !== undefined) args.push("offset=" + offset)
  if (limit !== undefined) args.push("limit=" + limit)

  return {
    title: readToolStatusTitle(status, i18n),
    subtitle: filePath ? getFilename(filePath) : title ? getFilename(title) : "",
    args,
  }
}
