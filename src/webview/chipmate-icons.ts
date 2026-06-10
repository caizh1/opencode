import { liquidIcon, type LiquidIconName } from "./liquid-icons"

export const chipmateIconNames: LiquidIconName[] = [
  "chat",
  "sparkle",
  "send",
  "add",
  "attach",
  "discard",
  "history",
  "refresh",
  "settings",
  "database",
  "key",
  "shield",
  "file",
  "stop",
  "retry",
  "apply",
  "agent",
  "server",
  "beaker",
  "diagnostics",
  "diff",
  "references",
  "sync",
  "pause",
  "play",
  "save",
  "more",
  "selection",
  "copy",
]

export const chipmateIcons = Object.fromEntries(
  chipmateIconNames.map((name) => [name, liquidIcon(name)]),
) as Record<LiquidIconName, string>
