export type Twip = number

export type ReportTheme = {
  id: string
  name: string
  page: {
    size: "A4"
    margin: { top: Twip; right: Twip; bottom: Twip; left: Twip }
  }
  fonts: {
    body: string
    latin: string
    code: string
  }
  colors: {
    primary: string
    secondary: string
    muted: string
    border: string
    surface: string
    callout: string
    warning: string
    danger: string
    success: string
    codeBackground: string
  }
  styles: {
    normal: TextStyle
    heading1: TextStyle
    heading2: TextStyle
    heading3: TextStyle
    body: TextStyle
    muted: TextStyle
    coverTitle: TextStyle
    coverSubtitle: TextStyle
    header: TextStyle
    footer: TextStyle
    tableHeader: TextStyle
    tableCell: TextStyle
    ruleCardTitle: TextStyle
    ruleCardLabel: TextStyle
    code: TextStyle
    calloutTitle: TextStyle
    calloutBody: TextStyle
    references: TextStyle
    appendix: TextStyle
  }
  table: {
    borderSize: number
    cellMargin: Twip
    headerFill: string
  }
  ruleCard: {
    borderSize: number
    fill: string
    labelFill: string
  }
  codeBlock: {
    fill: string
    borderSize: number
  }
  callout: {
    borderSize: number
    fill: string
  }
  example: {
    borderSize: number
    preservedFill: string
    generatedFill: string
    labelFill: string
  }
}

export type TextStyle = {
  font?: string
  sizeHalfPoints: number
  color?: string
  bold?: boolean
  italic?: boolean
  spacingAfter?: Twip
  spacingBefore?: Twip
}
