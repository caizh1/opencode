import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentTerminalCommandInput,
  AgentTerminalCommandResult,
} from "../src/agent-terminal"
import type { TerminalProjectContext } from "../src/agent-terminal-project-context"
import type {
  TerminalCommandPlan,
  TerminalCommandPlanInput,
  TerminalCommandResultSummary,
  TerminalCommandResultSummaryInput,
} from "../src/direct-agent-client"
import { stripAnsi } from "../src/terminal-ui"

const {
  AgentTerminalPty,
  classifyAgentTerminalInput,
  decodeAgentTerminalOutputChunk,
  runAgentTerminalCommand,
} = await import("../src/agent-terminal")

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })))
  tempDirs = []
})

describe("classifyAgentTerminalInput", () => {
  test("routes explicit prefixes and empty lines", () => {
    expect(classifyAgentTerminalInput("   ")).toMatchObject({ kind: "empty" })
    expect(classifyAgentTerminalInput("? explain the build")).toMatchObject({
      kind: "agent",
      text: "explain the build",
      reason: "forced-agent-prefix",
    })
    expect(classifyAgentTerminalInput("ai summarize failures")).toMatchObject({
      kind: "agent",
      text: "summarize failures",
      reason: "forced-agent-prefix",
    })
    expect(classifyAgentTerminalInput("$ list files")).toMatchObject({
      kind: "command",
      command: "list files",
      reason: "forced-command-prefix",
    })
  })

  test("routes known commands, resolvable commands, shell syntax, and natural language", () => {
    expect(classifyAgentTerminalInput("git status")).toMatchObject({ kind: "command", reason: "known-command" })
    expect(classifyAgentTerminalInput("echo hi && pwd")).toMatchObject({ kind: "command", reason: "shell-syntax" })
    expect(classifyAgentTerminalInput("local-tool --version", {
      resolveCommand: (token) => token === "local-tool",
    })).toMatchObject({ kind: "command", reason: "resolvable-command" })
    expect(classifyAgentTerminalInput("cloc .", {
      resolveCommand: () => false,
    })).toMatchObject({ kind: "command", reason: "command-like-arguments" })
    expect(classifyAgentTerminalInput("查找一下以 .d 为后缀名的文件")).toMatchObject({
      kind: "agent",
      reason: "natural-language-fallback",
    })
    expect(classifyAgentTerminalInput("list files in this project")).toMatchObject({
      kind: "agent",
      reason: "natural-language-fallback",
    })
  })

  test("routes executable relative paths as commands", async () => {
    const root = await tempDir("chipmate-agent-terminal-route-")
    const tool = join(root, "tool.sh")
    await writeFile(tool, "#!/bin/sh\nexit 0\n")
    await chmod(tool, 0o755)

    expect(classifyAgentTerminalInput("./tool.sh --help", { cwd: root })).toMatchObject({
      kind: "command",
      reason: "resolvable-command",
    })
  })
})

describe("AgentTerminalPty builtins and input handling", () => {
  test("keeps cwd across cd and pwd builtins", async () => {
    const root = await tempDir("chipmate-agent-terminal-cwd-")
    await mkdir(join(root, "sub"))
    const { pty, text } = createPty({ initialCwd: root })

    pty.handleInput("pwd\r")
    await pty.whenIdle()
    pty.handleInput("cd sub\r")
    await pty.whenIdle()
    pty.handleInput("pwd\r")
    await pty.whenIdle()
    pty.handleInput("cd missing\r")
    await pty.whenIdle()

    expect(text()).toContain(root)
    expect(text()).toContain(join(root, "sub"))
    expect(text()).toContain("cd: no such file or directory")
  })

  test("handles backspace, clear, and command history", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`ran:${command}\n`)
        return commandResult(0, `ran:${command}\n`)
      },
    })

    pty.handleInput("echo abc\x7f\r")
    await pty.whenIdle()
    pty.handleInput("\x0c")
    pty.handleInput("echo one\r")
    await pty.whenIdle()
    pty.handleInput("\x1b[A\r")
    await pty.whenIdle()

    expect(commands).toEqual(["echo ab", "echo one", "echo one"])
    expect(text()).toContain("\x1b[2J\x1b[H")
  })

  test("supports left and right cursor editing without leaking CSI text", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`ran:${command}\n`)
        return commandResult(0, `ran:${command}\n`)
      },
    })

    pty.handleInput("echo ac\x1b[Db\x1b[Cd\r")
    await pty.whenIdle()
    pty.handleInput("echo abcd\x1b[D\x1b[D\x7f\x1b[3~\r")
    await pty.whenIdle()

    expect(commands).toEqual(["echo abcd", "echo ad"])
    expect(text()).not.toContain("[D")
    expect(text()).not.toContain("[C")
  })

  test("supports cursor editing inside command edit prompts", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient([], [
        { kind: "command", command: "npm install", explanation: "Install dependencies." },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`ran:${command}\n`)
        return commandResult(0, `ran:${command}\n`)
      },
    })

    pty.handleInput("? install dependencies\r")
    await waitForText(text, "确认执行")
    pty.handleInput("e\r")
    await waitForText(text, "编辑命令 > npm install")
    pty.handleInput("\x0cecho ac\x1b[Db\x1b[Cd\r")
    await waitForText(text, "用户已编辑命令")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["echo abcd"])
    expect(text()).not.toContain("[D")
    expect(text()).not.toContain("[C")
  })

  test("redraws input lines when deleting wide unicode characters", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`ran:${command}\n`)
        return commandResult(0, `ran:${command}\n`)
      },
    })

    pty.handleInput("echo 帮帮\x7f\r")
    await pty.whenIdle()

    expect(commands).toEqual(["echo 帮"])
    expect(text()).toContain("\r\x1b[2K\x1b[36mchipmate\x1b[0m")
    expect(text()).toContain("echo 帮\r\n")
  })

  test("aborts a running command on Ctrl+C", async () => {
    let aborted = false
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const { pty, text } = createPty({
      commandRunner: ({ signal, onData }) =>
        new Promise((resolve) => {
          onData("started\n")
          started?.()
          signal?.addEventListener("abort", () => {
            aborted = true
            resolve(commandResult(null, "started\n", true))
          }, { once: true })
        }),
    })

    pty.handleInput("echo wait\r")
    await startedPromise
    pty.handleInput("\x03")
    await pty.whenIdle()

    expect(aborted).toBe(true)
    expect(text()).toContain("^C")
  })
})

describe("AgentTerminalPty command planning", () => {
  test("inspects project context before answering project build questions", async () => {
    const root = await tempDir("chipmate-agent-terminal-project-")
    await mkdir(join(root, "docs", "devel"), { recursive: true })
    await writeFile(join(root, "configure"), "#!/bin/sh\n")
    await writeFile(join(root, "meson.build"), "project('qemu')\n")
    await writeFile(join(root, "README.rst"), "Build QEMU with configure and ninja.\n")
    await writeFile(join(root, "docs", "devel", "build-system.rst"), "QEMU uses Meson and Ninja.\n")
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const { pty, text } = createPty({
      initialCwd: root,
      getClient: () => planClient(planInputs, [
        { kind: "answer", message: "基于当前项目证据：configure + meson.build。依据：found ./configure, found meson.build。" },
      ]),
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })

    pty.handleInput("该项目如果要编译运行，需要做些什么？\r")
    await pty.whenIdle()

    expect(commands).toEqual([])
    expect(planInputs).toHaveLength(1)
    expect(planInputs[0]?.projectContext).toMatchObject({
      root,
      buildFiles: ["configure", "meson.build"],
      docs: ["docs/devel/build-system.rst"],
    })
    expect(text()).toContain("[agent] inspecting project...")
    expect(text()).toContain("found: configure, meson.build, README.rst")
    expect(text()).toContain("docs: docs/devel/build-system.rst")
    expect(text()).toContain("基于当前项目证据")
    expect(text()).not.toContain("确认执行")
  })

  test("keeps project context through terminal clarification turns", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const projectContext = minimalProjectContext({ buildFiles: ["CMakeLists.txt"] })
    const { pty, text } = createPty({
      inspectProjectContext: async () => projectContext,
      getClient: () => planClient(planInputs, [
        { kind: "clarify", question: "Which target should I focus on?" },
        { kind: "answer", message: "Use the CMake build path for that target." },
      ]),
    })

    pty.handleInput("这个项目怎么编译？\r")
    await waitForText(text, "answer >")
    pty.handleInput("x86\r")
    await pty.whenIdle()

    expect(planInputs).toHaveLength(2)
    expect(planInputs[0]?.projectContext).toEqual(projectContext)
    expect(planInputs[1]?.projectContext).toEqual(projectContext)
    expect(text()).toContain("Which target should I focus on?")
    expect(text()).toContain("Use the CMake build path")
  })

  test("continues planning when project inspection fails", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const { pty, text } = createPty({
      inspectProjectContext: async () => {
        throw new Error("scan failed")
      },
      getClient: () => planClient(planInputs, [
        { kind: "answer", message: "这是通用建议，因为项目侦察失败。" },
      ]),
    })

    pty.handleInput("这个项目怎么运行？\r")
    await pty.whenIdle()

    expect(planInputs).toHaveLength(1)
    expect(planInputs[0]?.projectContext?.errors).toContain("scan failed")
    expect(text()).toContain("项目侦察遇到问题")
    expect(text()).toContain("scan failed")
    expect(text()).toContain("这是通用建议")
  })

  test("does not inspect project context for direct shell commands", async () => {
    const commands: string[] = []
    let inspected = false
    const { pty, text } = createPty({
      inspectProjectContext: async () => {
        inspected = true
        return minimalProjectContext()
      },
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("hello\n")
        return commandResult(0, "hello\n")
      },
    })

    pty.handleInput("echo hello\r")
    await pty.whenIdle()

    expect(inspected).toBe(false)
    expect(commands).toEqual(["echo hello"])
    expect(text()).not.toContain("inspecting project")
  })

  test("confirms and executes a command generated from natural language", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: "sudo apt-get update && sudo apt-get install -y build-essential",
          explanation: "Install the common Linux build toolchain package.",
          title: "安装 Linux 构建工具",
          purpose: "安装编译 C/C++ 项目常用的 build-essential 工具链。",
          expectedOutcome: "ChipMate 会在此终端执行安装命令并流式显示 apt 输出。",
          riskNote: "需要 sudo 权限，可能会修改系统软件包。",
          confidence: "high",
        },
      ]),
      classifyCommandRisk: (command) => command.includes("sudo") ? "high" : "medium",
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("installed\n")
        return commandResult(0, "installed\n")
      },
    })

    pty.handleInput("帮我安装 build-essentials\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(planInputs).toHaveLength(1)
    expect(planInputs[0]).toMatchObject({
      mode: "initial",
      userText: "帮我安装 build-essentials",
    })
    expect(commands).toEqual(["sudo apt-get update && sudo apt-get install -y build-essential"])
    expect(text()).toContain("ChipMate 准备执行：安装 Linux 构建工具")
    expect(text()).toContain("将要执行的命令：")
    expect(text()).toContain("  $ sudo apt-get update && sudo apt-get install -y build-essential")
    expect(text()).toContain("为什么执行：")
    expect(text()).toContain("安装编译 C/C++ 项目常用的 build-essential 工具链。")
    expect(text()).toContain("执行位置：")
    expect(text()).toContain(process.cwd())
    expect(text()).toContain("风险：")
    expect(text()).toContain("high - 需要 sudo 权限，可能会修改系统软件包。")
    expect(text()).toContain("预期结果：")
    expect(text()).toContain("ChipMate 会在此终端执行安装命令并流式显示 apt 输出。")
    expect(text()).toContain("按 y 后会执行上面这一行命令，并在此终端显示输出。")
    expect(text()).toContain("确认执行 `sudo apt-get update && sudo apt-get install -y build-essential` ? [y]执行 / [e]编辑 / [n]取消 > y")
    expect(text()).toContain("installed")
    expect(text()).toContain("执行结果总结")
    expect(text()).toContain("命令已执行完成。")
  })

  test("renders a clear Chinese counting proposal and makes cloc target explicit", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      resolveCommand: (token) => token === "cloc",
      getClient: () => planClient([], [
        {
          kind: "command",
          command: "cloc",
          explanation: "统计当前仓库所有源代码文件的行数。",
          title: "统计代码行数",
          purpose: "统计当前仓库源代码行数，并按语言汇总。",
          expectedOutcome: "终端会显示 cloc 的语言分类和总行数统计。",
          riskNote: "只读取文件并统计行数，不会修改仓库内容。",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("SUM: 1000\n")
        return commandResult(0, "SUM: 1000\n")
      },
    })

    pty.handleInput("帮我查看下这个仓库项目有多少行\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["cloc ."])
    expect(text()).toContain("ChipMate 准备执行：统计代码行数")
    expect(text()).toContain("将要执行的命令：")
    expect(text()).toContain("  $ cloc .")
    expect(text()).toContain("为什么执行：")
    expect(text()).toContain("统计当前仓库源代码行数，并按语言汇总。")
    expect(text()).toContain("medium - 只读取文件并统计行数，不会修改仓库内容。")
    expect(text()).toContain("确认执行 `cloc .` ? [y]执行 / [e]编辑 / [n]取消 >")
    expect(text()).toContain("执行结果总结")
    expect(text()).toContain("cloc 汇总行：SUM: 1000")
  })

  test("keeps long commands complete in the proposal block while shortening the confirmation prompt", async () => {
    const longCommand = `python -c "print('${"x".repeat(140)}')"`
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient([], [
        {
          kind: "command",
          command: longCommand,
          title: "运行长命令",
          purpose: "验证长命令在确认前完整展示。",
          explanation: "Run a long command.",
        },
      ]),
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })

    pty.handleInput("? run a long command\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual([longCommand])
    const plain = stripAnsi(text())
    expect(plain).toContain("将要执行的命令：")
    expect(plain).toContain("  $ python -c")
    expect(occurrences(plain, "x")).toBeGreaterThanOrEqual(140)
    expect(plain).toContain("')")
    expect(text()).toContain("确认执行 `python -c")
  })

  test("does not execute when the user rejects an agent-generated command", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient([], [
        { kind: "command", command: "npm install", explanation: "Install dependencies." },
      ]),
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })

    pty.handleInput("? install dependencies\r")
    await waitForText(text, "确认执行")
    pty.handleInput("n\r")
    await pty.whenIdle()

    expect(commands).toEqual([])
    expect(text()).toContain("未执行命令")
  })

  test("allows editing a generated command and recalculates risk before execution", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient([], [
        { kind: "command", command: "npm install", explanation: "Install dependencies." },
      ]),
      classifyCommandRisk: (command) => command.startsWith("sudo ") ? "high" : "medium",
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("done\n")
        return commandResult(0, "done\n")
      },
    })

    pty.handleInput("? install dependencies\r")
    await waitForText(text, "确认执行")
    pty.handleInput("e\r")
    await waitForText(text, "编辑命令 > npm install")
    pty.handleInput("\x0csudo npm install\r")
    await waitForText(text, "用户已编辑命令")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["sudo npm install"])
    expect(text()).toContain("ChipMate 准备执行：用户已编辑命令")
    expect(text()).toContain("  $ sudo npm install")
    expect(text()).toContain("high - 高风险命令，确认前请仔细检查。")
    expect(text()).toContain("确认执行 `sudo npm install` ? [y]执行 / [e]编辑 / [n]取消 > y")
  })

  test("renders answer plans without executing commands", async () => {
    const commands: string[] = []
    const answerPty = createPty({
      getClient: () => planClient([], [{ kind: "answer", message: "No command is needed." }]),
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })
    answerPty.pty.handleInput("? what is pwd\r")
    await answerPty.pty.whenIdle()

    expect(commands).toEqual([])
    expect(answerPty.text()).toContain("No command is needed.")
  })

  test("falls back to a local command summary when model summary fails", async () => {
    const commands: string[] = []
    const summaryInputs: TerminalCommandResultSummaryInput[] = []
    const { pty, text } = createPty({
      resolveCommand: () => true,
      getClient: () => ({
        planTerminalCommand: async () => ({
          kind: "command",
          command: "opaque-ok",
          explanation: "Run an opaque success command.",
        }),
        summarizeTerminalCommandResult: async (input) => {
          summaryInputs.push(input)
          throw new Error("summary provider failed")
        },
      }),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("opaque output\n")
        return commandResult(0, "opaque output\n")
      },
    })

    pty.handleInput("? run opaque success\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["opaque-ok"])
    expect(summaryInputs).toHaveLength(1)
    expect(summaryInputs[0]).toMatchObject({
      command: "opaque-ok",
      source: "agent",
      exitCode: 0,
      hasUsableResult: false,
    })
    expect(text()).toContain("执行结果总结")
    expect(text()).toContain("命令已执行完成。")
  })

  test("keeps clarify questions inside the terminal and continues planning from the answer", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const clarifyPty = createPty({
      getClient: () => planClient(planInputs, [
        { kind: "clarify", question: "Which package manager should I use?" },
        { kind: "command", command: "npm install", explanation: "Install dependencies with npm." },
      ]),
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })
    clarifyPty.pty.handleInput("? install it\r")
    await waitForText(clarifyPty.text, "answer >")
    clarifyPty.pty.handleInput("npm\r")
    await waitForText(clarifyPty.text, "确认执行")
    clarifyPty.pty.handleInput("y\r")
    await clarifyPty.pty.whenIdle()

    expect(planInputs).toHaveLength(2)
    expect(planInputs[1]?.userText).toContain("Clarification answer: npm")
    expect(commands).toEqual(["npm install"])
    expect(clarifyPty.text()).toContain("Which package manager should I use?")
    expect(clarifyPty.text()).toContain("answer > npm")
  })

  test("executes direct shell commands immediately but confirms direct high-risk commands", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      classifyCommandRisk: (command) => command.includes("rm -rf") ? "high" : "low",
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`ran ${command}\n`)
        return commandResult(0, `ran ${command}\n`)
      },
    })

    pty.handleInput("echo hello\r")
    await pty.whenIdle()
    pty.handleInput("rm -rf /tmp/chipmate-danger\r")
    await waitForText(text, "ChipMate 需要确认高风险命令")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["echo hello", "rm -rf /tmp/chipmate-danger"])
    expect(text()).toContain("ChipMate 需要确认高风险命令：用户输入的高风险命令")
    expect(text()).toContain("  $ rm -rf /tmp/chipmate-danger")
    expect(text()).toContain("high - 高风险命令，确认前请仔细检查。")
    expect(text()).toContain("确认执行 `rm -rf /tmp/chipmate-danger` ? [y]执行 / [e]编辑 / [n]取消 > y")
    expect(text()).toContain("执行结果总结")
    expect(text()).toContain("  $ rm -rf /tmp/chipmate-danger")
    expect(occurrences(text(), "执行结果总结")).toBe(1)
  })

  test("does not execute a rejected direct high-risk command", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      classifyCommandRisk: () => "high",
      commandRunner: async ({ command }) => {
        commands.push(command)
        return commandResult(0, "")
      },
    })

    pty.handleInput("rm -rf /tmp/chipmate-danger\r")
    await waitForText(text, "确认执行")
    pty.handleInput("\r")
    await pty.whenIdle()

    expect(commands).toEqual([])
    expect(text()).toContain("未执行命令")
  })

  test("repairs a failed planned command after confirmation", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient(planInputs, [
        { kind: "command", command: "make test", explanation: "Run tests." },
        { kind: "command", command: "npm install && make test", explanation: "Install dependencies, then retry." },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        if (command === "make test") {
          onData("missing dependency\n")
          return commandResult(2, "missing dependency\n")
        }
        onData("tests passed\n")
        return commandResult(0, "tests passed\n")
      },
    })

    pty.handleInput("? run the tests\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await waitForText(text, "ChipMate 准备执行修复命令")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["make test", "npm install && make test"])
    expect(planInputs.map((input) => input.mode)).toEqual(["initial", "repair"])
    expect(planInputs[1]).toMatchObject({
      failedCommand: "make test",
      exitCode: 2,
      attemptedCommands: ["make test"],
    })
    expect(planInputs[1]?.outputTail).toContain("missing dependency")
    expect(text()).toContain("执行失败")
    expect(text()).toContain("ChipMate 会根据失败信息继续生成修复建议。")
    expect(text()).toContain("命令执行失败")
    expect(text()).toContain("失败命令：")
    expect(text()).toContain("  $ make test")
    expect(text()).toContain("状态：")
    expect(text()).toContain("exit code 2 / exit-code")
    expect(text()).toContain("关键错误：")
    expect(text()).toContain("missing dependency")
    expect(text()).toContain("输出尾部：")
    expect(text()).toContain("修复依据：")
    expect(text()).toContain("上一条命令 `make test` 失败：missing dependency")
    expect(text()).toContain("为什么执行：")
    expect(text()).toContain("Install dependencies, then retry.")
    expect(text()).toContain("执行结果总结")
    expect(text()).toContain("测试结果：tests passed")
    expect(text()).toContain("这是修复命令的结果")
  })

  test("stops repair when the user rejects the repair command in the terminal", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => planClient([], [
        { kind: "command", command: "make test", explanation: "Run tests." },
        { kind: "command", command: "npm install && make test", explanation: "Install dependencies, then retry." },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("failed\n")
        return commandResult(command === "make test" ? 2 : 0, "failed\n")
      },
    })

    pty.handleInput("? run the tests\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await waitForText(text, "ChipMate 准备执行修复命令")
    pty.handleInput("n\r")
    await pty.whenIdle()

    expect(commands).toEqual(["make test"])
    expect(text()).toContain("未执行命令")
  })

  test("limits repair loops to two attempts", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const { pty, text } = createPty({
      resolveCommand: () => true,
      getClient: () => planClient(planInputs, [
        { kind: "command", command: "bad-one", explanation: "Try first." },
        { kind: "command", command: "bad-two", explanation: "Try second." },
        { kind: "command", command: "bad-three", explanation: "Try third." },
        { kind: "command", command: "bad-four", explanation: "Must not run." },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(`${command} failed\n`)
        return commandResult(1, `${command} failed\n`)
      },
    })

    pty.handleInput("? fix the build\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await waitForTextCount(text, "确认执行", 2)
    pty.handleInput("y\r")
    await waitForTextCount(text, "确认执行", 3)
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["bad-one", "bad-two", "bad-three"])
    expect(planInputs.map((input) => input.mode)).toEqual(["initial", "repair", "repair"])
    expect(text()).toContain("修复尝试已用尽")
  })

  test("passes noninteractive terminal limitations into repair planning", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const { pty, text } = createPty({
      getClient: () => planClient(planInputs, [
        { kind: "command", command: "sudo apt-get install -y build-essential", explanation: "Install compiler tools." },
        { kind: "answer", message: "Run this in a normal terminal because sudo needs a TTY." },
      ]),
      classifyCommandRisk: () => "high",
      commandRunner: async ({ onData }) => {
        const output = "sudo: a terminal is required to read the password\n"
        onData(output)
        return commandResult(1, output)
      },
    })

    pty.handleInput("? install build tools\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(planInputs).toHaveLength(2)
    expect(planInputs[1]?.nonInteractiveReason).toContain("当前 runner 不支持真实 PTY")
    expect(planInputs[1]?.outputTail).toContain("sudo: a terminal is required")
    expect(text()).toContain("命令执行失败")
    expect(text()).toContain("non-interactive")
    expect(text()).toContain("当前 runner 不支持真实 PTY")
    expect(text()).toContain("sudo needs a TTY")
  })

  test("preflights missing agent command and repairs with a no-install substitute", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const fallbackCommand = "find . -type f -name '*.c' -print | xargs wc -l"
    const { pty, text } = createPty({
      resolveCommand: () => false,
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: "cloc",
          title: "统计代码行数",
          purpose: "统计当前仓库代码行数。",
          explanation: "Count source lines.",
        },
        {
          kind: "command",
          command: fallbackCommand,
          title: "使用内置工具统计行数",
          purpose: "在不安装 cloc 的情况下，用 find 和 wc 做近似统计。",
          riskNote: "只读操作，不会修改任何文件。",
          explanation: "Use a no-install fallback.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("42 total\n")
        return commandResult(0, "42 total\n")
      },
    })

    pty.handleInput("帮我统计该仓库代码行数\r")
    await waitForText(text, "计划命令不可用")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual([fallbackCommand])
    expect(planInputs.map((input) => input.mode)).toEqual(["initial", "repair"])
    expect(planInputs[1]).toMatchObject({
      failureKind: "missing-command",
      missingCommand: "cloc",
      repairPreference: "prefer-no-install-fallback",
    })
    expect(text()).toContain("未执行的命令：")
    expect(text()).toContain("  $ cloc .")
    expect(text()).toContain("原因：")
    expect(text()).toContain("当前环境找不到命令 `cloc`。")
    expect(text()).toContain("关键错误：")
    expect(text()).toContain("command not found: cloc")
    expect(text()).not.toContain("上一条命令失败")
    expect(text()).not.toContain("确认执行 `cloc .`")
    expect(text()).toContain("修复依据：")
    expect(text()).toContain("计划命令 `cloc .` 未执行：当前环境找不到命令 `cloc`。")
    expect(text()).toContain(`  $ ${fallbackCommand}`)
    expect(text()).toContain("42 total")
  })

  test("does not preflight PowerShell file search aliases as missing commands on Windows", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      platform: "win32",
      shell: "powershell.exe",
      shellKind: "powershell",
      resolveCommand: () => false,
      getClient: () => planClient([], [
        {
          kind: "command",
          command: "Get-ChildItem -Path . -Recurse -Filter *.d -File | ForEach-Object { $_.FullName }",
          title: "查找 .d 文件",
          purpose: "递归列出 .d 文件。",
          explanation: "Use PowerShell file search.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("src\\a.d\r\n")
        return commandResult(0, "src\\a.d\r\n")
      },
    })

    pty.handleInput("查找一下以 .d 为后缀名的文件\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["Get-ChildItem -Path . -Recurse -Filter *.d -File | ForEach-Object { $_.FullName }"])
    expect(text()).not.toContain("计划命令不可用")
    expect(text()).toContain("src\\a.d")
  })

  test("blocks POSIX find plans in Windows PowerShell before execution", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const { pty, text } = createPty({
      platform: "win32",
      shell: "powershell.exe",
      shellKind: "powershell",
      resolveCommand: () => false,
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: "find . -type f -name '*.d' -print",
          title: "查找 .d 文件",
          purpose: "递归列出 .d 文件。",
          explanation: "Wrong shell plan.",
        },
        {
          kind: "command",
          command: "Get-ChildItem -Path . -Recurse -Filter *.d -File | ForEach-Object { $_.FullName }",
          title: "使用 PowerShell 查找 .d 文件",
          purpose: "用当前 PowerShell shell 支持的方式递归列出 .d 文件。",
          explanation: "Use a shell-compatible fallback.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData("src\\a.d\r\n")
        return commandResult(0, "src\\a.d\r\n")
      },
    })

    pty.handleInput("查找一下以 .d 为后缀名的文件\r")
    await waitForText(text, "计划命令不可用")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["Get-ChildItem -Path . -Recurse -Filter *.d -File | ForEach-Object { $_.FullName }"])
    expect(planInputs.map((input) => input.mode)).toEqual(["initial", "repair"])
    expect(planInputs[1]).toMatchObject({
      failureKind: "incompatible-command",
      platform: "win32",
      shellKind: "powershell",
    })
    expect(text()).toContain("不是 POSIX/GNU find")
    expect(text()).toContain("src\\a.d")
  })

  test("summarizes Windows file search no-match output without repairing", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const output = "找不到文件 - *.d\r\n"
    const { pty, text } = createPty({
      platform: "win32",
      shell: "powershell.exe",
      shellKind: "powershell",
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: "cmd /c dir /s /b *.d",
          title: "查找 .d 文件",
          purpose: "递归列出 .d 文件。",
          explanation: "Use cmd dir for file search.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(output)
        return commandResult(1, output)
      },
    })

    pty.handleInput("查找一下以 .d 为后缀名的文件\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["cmd /c dir /s /b *.d"])
    expect(planInputs).toHaveLength(1)
    expect(text()).toContain("执行完成但有警告")
    expect(text()).toContain("未找到匹配文件。")
    expect(text()).not.toContain("diagnosing failure")
    expect(text()).not.toContain("修复尝试已用尽")
    expect(text()).not.toContain("�")
  })

  test("does not keep repairing non-zero line counts when output already has a usable total", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const fallbackCommand = "git ls-files -z | xargs -0 wc -l"
    const output = [
      "wc: roms/QemuMacDrivers: read: Is a directory",
      "wc: roms/SLOF: read: Is a directory",
      "     657 util/throttle.c",
      "     233 util/timed-average.c",
      "  234659 total",
      "",
    ].join("\n")
    const { pty, text } = createPty({
      resolveCommand: () => false,
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: "cloc",
          title: "统计代码行数",
          purpose: "统计当前仓库代码行数。",
          explanation: "Count source lines.",
        },
        {
          kind: "command",
          command: fallbackCommand,
          title: "统计 Git 仓库代码行数",
          purpose: "使用 git ls-files 和 wc 汇总当前仓库的行数。",
          explanation: "Use a no-install fallback.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        onData(output)
        return commandResult(1, output)
      },
    })

    pty.handleInput("帮我统计该仓库代码行数\r")
    await waitForText(text, "计划命令不可用")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual([fallbackCommand])
    expect(planInputs.map((input) => input.mode)).toEqual(["initial", "repair"])
    expect(text()).toContain("234659 total")
    expect(text()).toContain("[exit code 1]")
    expect(text()).toContain("执行完成但有警告")
    expect(text()).toContain("统计得到 234659 total")
    expect(text()).toContain("wc 尝试读取 2 个目录并报 read: Is a directory")
    expect(text()).toContain("命令退出码是 1")
    expect(text()).toContain("虽然有警告，但输出中已经有可用结果，所以 ChipMate 不会继续修复")
    expect(text()).not.toContain("命令执行失败")
    expect(text()).not.toContain("Repair attempts exhausted")
  })

  test("executes direct missing command first, then repairs the failure", async () => {
    const planInputs: TerminalCommandPlanInput[] = []
    const commands: string[] = []
    const fallbackCommand = "find . -type f -print | wc -l"
    const { pty, text } = createPty({
      resolveCommand: () => false,
      getClient: () => planClient(planInputs, [
        {
          kind: "command",
          command: fallbackCommand,
          title: "使用 find 统计文件数",
          purpose: "cloc 不存在时，用系统内置工具给出替代统计。",
          explanation: "Fallback after missing cloc.",
        },
      ]),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        if (command === "cloc .") {
          const output = "zsh:1: command not found: cloc\n"
          onData(output)
          return commandResult(127, output)
        }
        onData("10\n")
        return commandResult(0, "10\n")
      },
    })

    pty.handleInput("cloc .\r")
    await waitForText(text, "确认执行")
    pty.handleInput("y\r")
    await pty.whenIdle()

    expect(commands).toEqual(["cloc .", fallbackCommand])
    expect(planInputs[0]).toMatchObject({
      mode: "repair",
      failedCommand: "cloc .",
      failureKind: "missing-command",
      missingCommand: "cloc",
    })
    expect(text()).toContain("命令执行失败")
    expect(text()).toContain("失败命令：")
    expect(text()).toContain("  $ cloc .")
    expect(text()).toContain("状态：")
    expect(text()).toContain("exit code 127 / missing-command")
    expect(text()).toContain("关键错误：")
    expect(text()).toContain("command not found: cloc")
    expect(text()).toContain("修复依据：")
    expect(text()).toContain("上一条命令 `cloc .` 失败：找不到命令 `cloc`。")
    expect(text()).toContain(`  $ ${fallbackCommand}`)
  })

  test("shows a friendly message when repair planning fails", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => ({
        planTerminalCommand: async () => {
          throw new Error("Terminal command planner returned invalid response after retry")
        },
      }),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        const output = "zsh:1: command not found: cloc\n"
        onData(output)
        return commandResult(127, output)
      },
    })

    pty.handleInput("cloc .\r")
    await pty.whenIdle()

    expect(commands).toEqual(["cloc ."])
    expect(text()).toContain("修复规划失败")
    expect(text()).toContain("模型没有输出可执行修复建议。")
    expect(text()).toContain("ChipMate 不会自动执行任何新命令。")
  })

  test("shows token truncation when repair planning fails with finish_reason length", async () => {
    const commands: string[] = []
    const { pty, text } = createPty({
      getClient: () => ({
        planTerminalCommand: async () => {
          throw new Error("Terminal command planner returned invalid response after retry: Terminal command planner response did not include message content. summary=choices=1 finish_reason=length content=empty-string tool_calls=0 reasoning=present bytes=4087")
        },
      }),
      commandRunner: async ({ command, onData }) => {
        commands.push(command)
        const output = "zsh:1: command not found: cloc\n"
        onData(output)
        return commandResult(127, output)
      },
    })

    pty.handleInput("cloc .\r")
    await pty.whenIdle()

    expect(commands).toEqual(["cloc ."])
    expect(text()).toContain("修复规划失败")
    expect(text()).toContain("planner 输出被 token 上限截断，未返回可执行 JSON。")
    expect(text()).toContain("ChipMate 不会自动执行任何新命令。")
  })

  test("Ctrl+C interrupts an in-flight agent planning task", async () => {
    let plannerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      plannerStarted = resolve
    })
    let signalAborted = false
    const { pty, text } = createPty({
      getClient: () => ({
        planTerminalCommand: (input: TerminalCommandPlanInput) =>
          new Promise<TerminalCommandPlan>((_resolve, reject) => {
            plannerStarted()
            input.signal?.addEventListener("abort", () => {
              signalAborted = true
              reject(new Error("aborted"))
            }, { once: true })
          }),
      }),
    })

    pty.handleInput("? wait for planning\r")
    await started
    pty.handleInput("\x03")
    await pty.whenIdle()

    expect(signalAborted).toBe(true)
    expect(text()).toContain("^C")
  })

  test("Ctrl+C cancels pending terminal confirmation, edit, and clarify prompts", async () => {
    const confirmCommands: string[] = []
    const confirmPty = createPty({
      getClient: () => planClient([], [{ kind: "command", command: "npm install", explanation: "Install dependencies." }]),
      commandRunner: async ({ command }) => {
        confirmCommands.push(command)
        return commandResult(0, "")
      },
    })
    confirmPty.pty.handleInput("? install dependencies\r")
    await waitForText(confirmPty.text, "确认执行")
    confirmPty.pty.handleInput("\x03")
    await confirmPty.pty.whenIdle()

    const editCommands: string[] = []
    const editPty = createPty({
      getClient: () => planClient([], [{ kind: "command", command: "npm install", explanation: "Install dependencies." }]),
      commandRunner: async ({ command }) => {
        editCommands.push(command)
        return commandResult(0, "")
      },
    })
    editPty.pty.handleInput("? install dependencies\r")
    await waitForText(editPty.text, "确认执行")
    editPty.pty.handleInput("e\r")
    await waitForText(editPty.text, "编辑命令 >")
    editPty.pty.handleInput("\x03")
    await editPty.pty.whenIdle()

    const clarifyPty = createPty({
      getClient: () => planClient([], [{ kind: "clarify", question: "Which package manager should I use?" }]),
      commandRunner: async () => commandResult(0, ""),
    })
    clarifyPty.pty.handleInput("? install it\r")
    await waitForText(clarifyPty.text, "answer >")
    clarifyPty.pty.handleInput("\x03")
    await clarifyPty.pty.whenIdle()

    expect(confirmCommands).toEqual([])
    expect(editCommands).toEqual([])
    expect(confirmPty.text()).toContain("^C")
    expect(editPty.text()).toContain("^C")
    expect(clarifyPty.text()).toContain("^C")
  })
})

describe("runAgentTerminalCommand", () => {
  test("decodes Windows GBK command output without mojibake", () => {
    const gbk = Buffer.from([0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xce, 0xc4, 0xbc, 0xfe, 0x20, 0x2d, 0x20, 0x2a, 0x2e, 0x64])

    expect(decodeAgentTerminalOutputChunk(gbk, "win32")).toBe("找不到文件 - *.d")
  })

  test("streams stdout and stderr and returns transcript, timing, and non-zero exit code", async () => {
    let output = ""
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"
    const result = await runAgentTerminalCommand({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      cwd: process.cwd(),
      onData: (chunk: string) => {
        output += chunk
      },
    })

    expect(output).toContain("out")
    expect(output).toContain("err")
    expect(result.output).toContain("out")
    expect(result.output).toContain("err")
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.exitCode).toBe(3)
    expect(result.aborted).toBe(false)
  })

  test("reports aborts", async () => {
    const controller = new AbortController()
    const script = "setTimeout(() => {}, 10000)"
    const resultPromise = runAgentTerminalCommand({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      cwd: process.cwd(),
      signal: controller.signal,
      onData: () => undefined,
    })

    setTimeout(() => controller.abort(), 50)
    const result = await resultPromise

    expect(result.aborted).toBe(true)
  })
})

function createPty(input: {
  initialCwd?: string
  platform?: NodeJS.Platform
  shell?: string
  shellKind?: "cmd" | "posix" | "powershell" | "unknown"
  commandRunner?: (input: AgentTerminalCommandInput) => Promise<AgentTerminalCommandResult>
  getClient?: () => {
    planTerminalCommand: (input: TerminalCommandPlanInput) => Promise<TerminalCommandPlan>
    summarizeTerminalCommandResult?: (input: TerminalCommandResultSummaryInput) => Promise<TerminalCommandResultSummary>
  }
  classifyCommandRisk?: (command: string) => "low" | "medium" | "high"
  resolveCommand?: (token: string, cwd: string) => boolean
  inspectProjectContext?: (input: { cwd: string; signal?: AbortSignal }) => Promise<TerminalProjectContext>
  env?: NodeJS.ProcessEnv
} = {}) {
  const writes: string[] = []
  const pty = new AgentTerminalPty({
    initialCwd: input.initialCwd ?? process.cwd(),
    platform: input.platform,
    shell: input.shell,
    shellKind: input.shellKind,
    commandRunner: input.commandRunner,
    getClient: input.getClient ?? (() => undefined),
    classifyCommandRisk: input.classifyCommandRisk,
    resolveCommand: input.resolveCommand,
    inspectProjectContext: input.inspectProjectContext,
    env: input.env,
    output: { appendLine: () => undefined },
  })
  pty.onDidWrite((chunk: string) => writes.push(chunk))
  pty.open()
  return {
    pty,
    text: () => writes.join(""),
  }
}

function planClient(planInputs: TerminalCommandPlanInput[], plans: TerminalCommandPlan[]) {
  return {
    planTerminalCommand: async (input: TerminalCommandPlanInput) => {
      planInputs.push(input)
      const plan = plans.shift()
      if (!plan) throw new Error("unexpected planner call")
      return plan
    },
  }
}

function commandResult(exitCode: number | null, output: string, aborted = false): AgentTerminalCommandResult {
  return {
    exitCode,
    signal: null,
    aborted,
    output,
    elapsedMs: 1,
  }
}

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function minimalProjectContext(input: Partial<TerminalProjectContext> = {}): TerminalProjectContext {
  return {
    cwd: "/repo",
    root: "/repo",
    relativeCwd: ".",
    rootFiles: input.rootFiles ?? input.buildFiles ?? [],
    buildFiles: input.buildFiles ?? [],
    buildDirectories: input.buildDirectories ?? [],
    docs: input.docs ?? [],
    snippets: input.snippets ?? [],
    hints: input.hints ?? [],
    truncated: input.truncated ?? false,
    errors: input.errors ?? [],
  }
}

async function waitForText(text: () => string, expected: string, timeoutMs = 1000) {
  await waitFor(() => text().includes(expected), `Timed out waiting for terminal text: ${expected}`, timeoutMs)
}

async function waitForTextCount(text: () => string, expected: string, count: number, timeoutMs = 1000) {
  await waitFor(() => occurrences(text(), expected) >= count, `Timed out waiting for ${count} occurrences of terminal text: ${expected}`, timeoutMs)
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs: number) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

function occurrences(input: string, needle: string) {
  return input.split(needle).length - 1
}
