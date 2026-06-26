import { describe, expect, test } from "bun:test"
import {
  ANSI_BOLD,
  ANSI_CYAN,
  renderTerminalBox,
  stripAnsi,
  styled,
  visibleWidth,
  wrapTerminalText,
} from "../src/terminal-ui"

describe("renderTerminalBox", () => {
  test("renders a closed box with Chinese wide characters", () => {
    const output = renderTerminalBox({
      title: "ChipMate 准备执行：统计代码行数",
      width: 54,
      sections: [
        { label: "将要执行的命令：", body: "  $ cloc .", bodyStyle: [ANSI_BOLD, ANSI_CYAN] },
        { label: "为什么执行：", body: "统计当前仓库源代码行数，并按语言汇总。" },
      ],
      footer: "确认前请检查上面的命令。",
    })
    const plain = stripAnsi(output)
    const lines = plain.split("\n")

    expect(plain).toContain("╭─ ChipMate 准备执行：统计代码行数")
    expect(plain).toContain("│ 将要执行的命令：")
    expect(plain).toContain("│   $ cloc .")
    expect(plain).toContain("确认前请检查上面的命令。")
    expect(lines.at(-1)).toMatch(/^╰─+╯$/)
    expect(new Set(lines.map((line) => visibleWidth(line))).size).toBe(1)
  })

  test("wraps long commands without dropping content", () => {
    const command = `python -c "print('${"x".repeat(120)}')"`
    const output = renderTerminalBox({
      title: "长命令",
      width: 50,
      sections: [{ label: "将要执行的命令：", body: `  $ ${command}` }],
    })
    const plain = stripAnsi(output)

    expect(plain).toContain("将要执行的命令：")
    expect(plain).toContain("  $ python -c")
    expect(plain.replace(/\n│ |\n╰.*$/g, "")).toContain("x".repeat(40))
    expect(plain).toContain("')")
  })

  test("keeps ANSI styled text measurable", () => {
    const styledText = styled("风险：high", ANSI_BOLD, ANSI_CYAN)
    const output = renderTerminalBox({
      title: "风险提示",
      tone: "danger",
      width: 46,
      sections: [{ body: styledText }],
    })

    expect(output).toContain(ANSI_BOLD)
    expect(stripAnsi(output)).toContain("风险：high")
    expect(visibleWidth(styledText)).toBe(10)
  })
})

describe("wrapTerminalText", () => {
  test("wraps mixed Chinese and English by visible width", () => {
    expect(wrapTerminalText("统计 QEMU source lines", 10)).toEqual([
      "统计 QEMU ",
      "source lin",
      "es",
    ])
  })
})
