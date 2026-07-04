import type { WordDesignPreset, WordDocLayoutSpec, WordHeaderPattern, WordPresetAlias } from "../types"
import type { ReportTheme } from "./ReportTheme"
import { TeamGuidelineReportTheme } from "./TeamGuidelineReportTheme"

const LETTER_WIDTH_TWIPS = 12_240
const LETTER_HEIGHT_TWIPS = 15_840
const A4_WIDTH_TWIPS = 11_906
const A4_HEIGHT_TWIPS = 16_838
const ONE_INCH_TWIPS = 1_440
const MIN_TABLE_HEADER_CONTRAST = 4.5
const DEFAULT_TABLE_HEADER_FILL = "1F4E79"
const DEFAULT_TABLE_HEADER_TEXT = "FFFFFF"
const LIGHT_TABLE_HEADER_FILL = "EAF3FF"
const LIGHT_TABLE_HEADER_TEXT = "24292F"

export const DEFAULT_WORD_DESIGN_PRESET: WordDesignPreset = "standard_business_brief"

export type WordPresetTokenMap = {
  preset: WordDesignPreset
  alias?: WordPresetAlias
  page: {
    size: "Letter" | "A4"
    width: number
    height: number
    margins: { top: number; right: number; bottom: number; left: number }
    header: number
    footer: number
    contentWidth: number
  }
  typography: {
    bodyFont: string
    codeFont: string
    bodySizeHalfPoints: number
    bodySpacingAfter: number
    lineSpacing?: number
  }
  headings: {
    h1: { sizeHalfPoints: number; color: string; before: number; after: number; bold?: boolean }
    h2: { sizeHalfPoints: number; color: string; before: number; after: number; bold?: boolean }
    h3: { sizeHalfPoints: number; color: string; before: number; after: number; bold?: boolean }
  }
  lists: {
    markerAlignedTwips: number
    textIndentTwips: number
    hangingTwips: number
    spacingAfter: number
  }
  tables: {
    widthTwips: number
    indentTwips: number
    cellMarginTwips: number
    borderSize: number
    headerFill?: string
  }
  callouts: {
    fill: string
    borderSize: number
  }
  headers: {
    enabled: boolean
    quietLabel?: string
  }
  footers: {
    enabled: boolean
    quietLabel?: string
  }
  colors: {
    primary: string
    secondary: string
    muted: string
    border: string
    surface: string
  }
}

export const WORD_PRESET_ALIAS_BASE: Record<WordPresetAlias, WordDesignPreset> = {
  rfi_response: "standard_business_brief",
  decision_memo: "standard_business_brief",
  launch_messaging_guide: "compact_reference_guide",
  contract_negotiation_brief: "compact_reference_guide",
  neighborhood_business_proposal: "narrative_proposal",
  grant_proposal: "narrative_proposal",
}

export function resolveWordDesignPreset(layout?: WordDocLayoutSpec): WordDesignPreset {
  return layout?.preset ?? (layout?.presetAlias ? WORD_PRESET_ALIAS_BASE[layout.presetAlias] : undefined) ?? DEFAULT_WORD_DESIGN_PRESET
}

export function resolveWordHeaderPattern(layout?: WordDocLayoutSpec): WordHeaderPattern {
  const preset = resolveWordDesignPreset(layout)
  if (preset === "google_docs_default") return "none"
  if (layout?.headerPattern) return layout.headerPattern
  if (layout?.presetAlias === "grant_proposal" || layout?.presetAlias === "neighborhood_business_proposal") return "proposal_centerpiece"
  if (layout?.presetAlias === "launch_messaging_guide") return "editorial_cover"
  if (layout?.presetAlias === "contract_negotiation_brief") return "memo_masthead"
  if (layout?.presetAlias === "decision_memo" || layout?.presetAlias === "rfi_response") return "memo_masthead"
  return "none"
}

export function resolveWordPresetTokenMap(layout?: WordDocLayoutSpec): WordPresetTokenMap {
  const preset = resolveWordDesignPreset(layout)
  const base = baseTokenMap(preset)
  const alias = layout?.presetAlias
  const mapped = alias ? applyAliasTokens(base, alias) : base
  const pageSize = layout?.page?.size
  const page = {
    ...mapped.page,
    size: pageSize === "a4" ? "A4" as const : pageSize === "letter" ? "Letter" as const : mapped.page.size,
    width: pageSize === "a4" ? A4_WIDTH_TWIPS : pageSize === "letter" ? LETTER_WIDTH_TWIPS : mapped.page.width,
    height: pageSize === "a4" ? A4_HEIGHT_TWIPS : pageSize === "letter" ? LETTER_HEIGHT_TWIPS : mapped.page.height,
    margins: {
      ...mapped.page.margins,
      ...(layout?.page?.marginTwips ?? {}),
    },
  }
  return { ...mapped, page }
}

export function resolveWordTheme(base: ReportTheme, layout?: WordDocLayoutSpec): ReportTheme {
  const tokens = resolveWordPresetTokenMap(layout)
  const tableHeader = ensureTableHeaderContrast({
    fill: tokens.tables.headerFill ?? base.table.headerFill,
    textColor: tokens.preset === "google_docs_default" ? LIGHT_TABLE_HEADER_TEXT : base.styles.tableHeader.color ?? DEFAULT_TABLE_HEADER_TEXT,
    preferLightHeader: tokens.preset === "google_docs_default",
  })
  return {
    ...base,
    id: themeId(tokens),
    name: themeName(tokens),
    page: {
      size: tokens.page.size,
      width: tokens.page.width,
      height: tokens.page.height,
      margin: tokens.page.margins,
    },
    fonts: {
      body: tokens.typography.bodyFont,
      latin: tokens.typography.bodyFont,
      code: tokens.typography.codeFont,
    },
    colors: {
      ...base.colors,
      primary: tokens.colors.primary,
      secondary: tokens.colors.secondary,
      muted: tokens.colors.muted,
      border: tokens.colors.border,
      surface: tokens.colors.surface,
      callout: tokens.callouts.fill,
    },
    styles: {
      ...base.styles,
      normal: { ...base.styles.normal, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.typography.bodySizeHalfPoints, color: tokens.colors.primary, spacingAfter: tokens.typography.bodySpacingAfter },
      body: { ...base.styles.body, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.typography.bodySizeHalfPoints, color: tokens.colors.primary, spacingAfter: tokens.typography.bodySpacingAfter },
      coverTitle: { ...base.styles.coverTitle, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.preset === "google_docs_default" ? 52 : base.styles.coverTitle.sizeHalfPoints, color: tokens.colors.primary, spacingAfter: tokens.preset === "google_docs_default" ? 60 : base.styles.coverTitle.spacingAfter },
      coverSubtitle: { ...base.styles.coverSubtitle, font: tokens.typography.bodyFont, color: tokens.colors.secondary },
      heading1: { ...base.styles.heading1, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.headings.h1.sizeHalfPoints, color: tokens.headings.h1.color, bold: tokens.headings.h1.bold ?? true, spacingBefore: tokens.headings.h1.before, spacingAfter: tokens.headings.h1.after },
      heading2: { ...base.styles.heading2, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.headings.h2.sizeHalfPoints, color: tokens.headings.h2.color, bold: tokens.headings.h2.bold ?? true, spacingBefore: tokens.headings.h2.before, spacingAfter: tokens.headings.h2.after },
      heading3: { ...base.styles.heading3, font: tokens.typography.bodyFont, sizeHalfPoints: tokens.headings.h3.sizeHalfPoints, color: tokens.headings.h3.color, bold: tokens.headings.h3.bold ?? true, spacingBefore: tokens.headings.h3.before, spacingAfter: tokens.headings.h3.after },
      tableHeader: { ...base.styles.tableHeader, color: tableHeader.textColor },
      calloutTitle: { ...base.styles.calloutTitle, color: tokens.colors.secondary },
    },
    table: {
      ...base.table,
      borderSize: tokens.tables.borderSize,
      cellMargin: tokens.tables.cellMarginTwips,
      headerFill: tableHeader.fill,
    },
    callout: {
      ...base.callout,
      borderSize: tokens.callouts.borderSize,
      fill: tokens.callouts.fill,
    },
  }
}

export function defaultWordThemeForSpec(layout?: WordDocLayoutSpec) {
  return resolveWordTheme(TeamGuidelineReportTheme, layout)
}

function baseTokenMap(preset: WordDesignPreset): WordPresetTokenMap {
  const shared = {
    page: {
      size: "Letter" as const,
      width: LETTER_WIDTH_TWIPS,
      height: LETTER_HEIGHT_TWIPS,
      margins: { top: ONE_INCH_TWIPS, right: ONE_INCH_TWIPS, bottom: ONE_INCH_TWIPS, left: ONE_INCH_TWIPS },
      header: 708,
      footer: 708,
      contentWidth: 9_360,
    },
    lists: { markerAlignedTwips: 360, textIndentTwips: 720, hangingTwips: 360, spacingAfter: 160 },
    tables: { widthTwips: 9_360, indentTwips: 120, cellMarginTwips: 120, borderSize: 8, headerFill: DEFAULT_TABLE_HEADER_FILL },
    callouts: { fill: "EAF3FF", borderSize: 8 },
    headers: { enabled: true, quietLabel: "Document" },
    footers: { enabled: true, quietLabel: "Page" },
    colors: { primary: "24292F", secondary: "2E74B5", muted: "667085", border: "D0D7DE", surface: "FFFFFF" },
  }
  if (preset === "google_docs_default") {
    return {
      preset,
      ...shared,
      typography: { bodyFont: "Arial", codeFont: "Courier New", bodySizeHalfPoints: 22, bodySpacingAfter: 160, lineSpacing: 276 },
      headings: {
        h1: { sizeHalfPoints: 40, color: "000000", before: 400, after: 120, bold: false },
        h2: { sizeHalfPoints: 32, color: "000000", before: 360, after: 120, bold: false },
        h3: { sizeHalfPoints: 28, color: "434343", before: 320, after: 80, bold: false },
      },
      tables: { ...shared.tables, indentTwips: 0, borderSize: 4, headerFill: LIGHT_TABLE_HEADER_FILL },
      callouts: { fill: "FFFFFF", borderSize: 0 },
      headers: { enabled: false },
      footers: { enabled: false },
      colors: { primary: "000000", secondary: "202124", muted: "555555", border: "DADCE0", surface: "FFFFFF" },
    }
  }
  if (preset === "compact_reference_guide") {
    return {
      preset,
      ...shared,
      typography: { bodyFont: "Calibri", codeFont: "Courier New", bodySizeHalfPoints: 20, bodySpacingAfter: 80, lineSpacing: 300 },
      headings: {
        h1: { sizeHalfPoints: 28, color: "2E74B5", before: 360, after: 200 },
        h2: { sizeHalfPoints: 24, color: "2E74B5", before: 280, after: 140 },
        h3: { sizeHalfPoints: 22, color: "1F4D78", before: 200, after: 100 },
      },
      lists: { markerAlignedTwips: 270, textIndentTwips: 540, hangingTwips: 270, spacingAfter: 80 },
      tables: { ...shared.tables, cellMarginTwips: 96, headerFill: DEFAULT_TABLE_HEADER_FILL },
      colors: { primary: "24292F", secondary: "2E74B5", muted: "596579", border: "C7D1DD", surface: "FFFFFF" },
    }
  }
  if (preset === "narrative_proposal") {
    return {
      preset,
      ...shared,
      typography: { bodyFont: "Calibri", codeFont: "Courier New", bodySizeHalfPoints: 23, bodySpacingAfter: 150, lineSpacing: 320 },
      headings: {
        h1: { sizeHalfPoints: 34, color: "23405C", before: 420, after: 180 },
        h2: { sizeHalfPoints: 27, color: "23405C", before: 300, after: 140 },
        h3: { sizeHalfPoints: 23, color: "576B7F", before: 180, after: 100 },
      },
      callouts: { fill: "F1F6FA", borderSize: 8 },
      colors: { primary: "24313D", secondary: "23405C", muted: "576B7F", border: "C9D6E2", surface: "FFFFFF" },
    }
  }
  return {
    preset,
    ...shared,
    typography: { bodyFont: "Calibri", codeFont: "Courier New", bodySizeHalfPoints: 22, bodySpacingAfter: 120, lineSpacing: 264 },
    headings: {
      h1: { sizeHalfPoints: 32, color: "2E74B5", before: 320, after: 160 },
      h2: { sizeHalfPoints: 26, color: "2E74B5", before: 240, after: 120 },
      h3: { sizeHalfPoints: 24, color: "1F4D78", before: 160, after: 80 },
    },
  }
}

function ensureTableHeaderContrast(input: { fill: string; textColor: string; preferLightHeader: boolean }) {
  const fill = normalizeHexColor(input.fill) ?? (input.preferLightHeader ? LIGHT_TABLE_HEADER_FILL : DEFAULT_TABLE_HEADER_FILL)
  const textColor = normalizeHexColor(input.textColor) ?? (input.preferLightHeader ? LIGHT_TABLE_HEADER_TEXT : DEFAULT_TABLE_HEADER_TEXT)
  if (contrastRatio(fill, textColor) >= MIN_TABLE_HEADER_CONTRAST && !isNearWhite(fill)) {
    return { fill, textColor }
  }
  if (input.preferLightHeader && contrastRatio(LIGHT_TABLE_HEADER_FILL, LIGHT_TABLE_HEADER_TEXT) >= MIN_TABLE_HEADER_CONTRAST) {
    return { fill: LIGHT_TABLE_HEADER_FILL, textColor: LIGHT_TABLE_HEADER_TEXT }
  }
  return { fill: DEFAULT_TABLE_HEADER_FILL, textColor: DEFAULT_TABLE_HEADER_TEXT }
}

function normalizeHexColor(value: string | undefined) {
  const raw = value?.trim().replace(/^#/, "")
  if (!raw) return undefined
  if (/^[\da-fA-F]{3}$/.test(raw)) return raw.split("").map((char) => `${char}${char}`).join("").toUpperCase()
  if (/^[\da-fA-F]{6}$/.test(raw)) return raw.toUpperCase()
  return undefined
}

function contrastRatio(left: string, right: string) {
  const leftLuminance = relativeLuminance(left)
  const rightLuminance = relativeLuminance(right)
  const lighter = Math.max(leftLuminance, rightLuminance)
  const darker = Math.min(leftLuminance, rightLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string) {
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  const [r, g, b] = [red, green, blue].map((component) => {
    const channel = component / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function isNearWhite(hex: string) {
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  return red >= 246 && green >= 246 && blue >= 246
}

function applyAliasTokens(tokens: WordPresetTokenMap, alias: WordPresetAlias): WordPresetTokenMap {
  const next: WordPresetTokenMap = { ...tokens, alias }
  if (alias === "decision_memo") {
    return {
      ...next,
      typography: { ...next.typography, bodyFont: "Arial", bodySpacingAfter: 120 },
      headings: {
        h1: { ...next.headings.h1, before: 240, after: 120 },
        h2: { ...next.headings.h2, before: 200, after: 100 },
        h3: { ...next.headings.h3, before: 160, after: 80 },
      },
    }
  }
  if (alias === "contract_negotiation_brief") {
    return {
      ...next,
      headings: {
        h1: { ...next.headings.h1, before: 280, after: 160 },
        h2: { ...next.headings.h2, before: 220, after: 120 },
        h3: { ...next.headings.h3, before: 160, after: 80 },
      },
    }
  }
  if (alias === "neighborhood_business_proposal") {
    return {
      ...next,
      typography: { ...next.typography, bodySpacingAfter: 160, lineSpacing: 320 },
      headings: {
        h1: { ...next.headings.h1, before: 360, after: 200 },
        h2: { ...next.headings.h2, before: 240, after: 120 },
        h3: { ...next.headings.h3, before: 160, after: 80 },
      },
    }
  }
  if (alias === "grant_proposal") {
    return {
      ...next,
      typography: { ...next.typography, bodySpacingAfter: 120, lineSpacing: 300 },
      headings: {
        h1: { ...next.headings.h1, before: 320, after: 160 },
        h2: { ...next.headings.h2, before: 240, after: 120 },
        h3: { ...next.headings.h3, before: 160, after: 80 },
      },
    }
  }
  return next
}

function themeId(tokens: WordPresetTokenMap) {
  return tokens.alias ? `${tokens.preset}-${tokens.alias}`.replace(/_/g, "-") : tokens.preset.replace(/_/g, "-")
}

function themeName(tokens: WordPresetTokenMap) {
  const base = tokens.preset.split("_").map(titleCase).join(" ")
  return tokens.alias ? `${base} / ${tokens.alias.split("_").map(titleCase).join(" ")}` : base
}

function titleCase(input: string) {
  return input.slice(0, 1).toUpperCase() + input.slice(1)
}
