import { describe, expect, test } from "bun:test"
import { planCEmbeddedCompletion } from "../src/completion-c-embedded-intent"
import { planCompletion, type CompletionPlanInput } from "../src/completion-plan"
import type { CompletionPlan } from "../src/completion-types"

type Intent = NonNullable<CompletionPlan["cIntent"]>

type Case = {
  name: string
  domain: "generic-c" | "embedded-driver" | "qemu-ufs" | "ssd-domain"
  intent: Intent
  source: string
  triggerKind?: CompletionPlanInput["triggerKind"]
  languageId?: string
  domainHints?: string[]
}

const intentCases: Case[] = [
  {
    name: "generic member access arrow",
    domain: "generic-c",
    intent: "member-access",
    source: "void parser_step(struct parser_ctx *ctx)\n{\n    ctx->|\n}\n",
  },
  {
    name: "embedded member access with prefix",
    domain: "embedded-driver",
    intent: "member-access",
    source: "void probe(struct device *dev)\n{\n    dev->sta|\n}\n",
  },
  {
    name: "qemu ufs member access",
    domain: "qemu-ufs",
    intent: "member-access",
    source: "void ufs_irq(struct UfsHc *u)\n{\n    u->|\n}\n",
    domainHints: ["ufs"],
  },
  {
    name: "generic short symbol prefix",
    domain: "generic-c",
    intent: "symbol-prefix",
    source: "int parse(void)\n{\n    pa|\n}\n",
  },
  {
    name: "embedded nand macro prefix",
    domain: "embedded-driver",
    intent: "symbol-prefix",
    source: "void nand_step(void)\n{\n    NAND_|\n}\n",
    domainHints: ["nand"],
  },
  {
    name: "ssd ftl macro prefix",
    domain: "ssd-domain",
    intent: "symbol-prefix",
    source: "void ftl_schedule(void)\n{\n    FTL_|\n}\n",
    domainHints: ["ftl"],
  },
  {
    name: "generic rpmb macro prefix",
    domain: "generic-c",
    intent: "symbol-prefix",
    source: "void rpmb_status(void)\n{\n    RPMB_|\n}\n",
    domainHints: ["rpmb"],
  },
  {
    name: "generic first call argument",
    domain: "generic-c",
    intent: "call-args",
    source: "int parse(struct parser_ctx *ctx)\n{\n    return parser_feed(|);\n}\n",
  },
  {
    name: "embedded second call argument",
    domain: "embedded-driver",
    intent: "call-args",
    source: "int spi_run(struct spi_ctrl *ctrl)\n{\n    return spi_transfer(ctrl, |);\n}\n",
  },
  {
    name: "qemu ufs call arguments",
    domain: "qemu-ufs",
    intent: "call-args",
    source: "int ufs_submit(struct UfsHc *u)\n{\n    return ufs_send_upiu(u, |);\n}\n",
    domainHints: ["ufs"],
  },
  {
    name: "generic designated initializer",
    domain: "generic-c",
    intent: "initializer",
    source: "static const struct parser_ops ops = {\n    .ready = |\n};\n",
  },
  {
    name: "embedded ops initializer",
    domain: "embedded-driver",
    intent: "initializer",
    source: "static const struct spi_driver drv = {\n    .ops = |\n};\n",
  },
  {
    name: "ssd callback initializer",
    domain: "ssd-domain",
    intent: "initializer",
    source: "static const struct ssd_req_ops ops = {\n    .submit = |\n};\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic if condition",
    domain: "generic-c",
    intent: "condition",
    source: "void parse(int ready)\n{\n    if (|\n}\n",
  },
  {
    name: "embedded while condition",
    domain: "embedded-driver",
    intent: "condition",
    source: "void poll(int ret)\n{\n    while (ret|\n}\n",
  },
  {
    name: "qemu ufs condition",
    domain: "qemu-ufs",
    intent: "condition",
    source: "void ufs_poll(int ready)\n{\n    if (ready|\n}\n",
    domainHints: ["ufs"],
  },
  {
    name: "generic ret assignment",
    domain: "generic-c",
    intent: "assignment-rhs",
    source: "int parse(void)\n{\n    int ret;\n    ret = |\n}\n",
  },
  {
    name: "embedded status assignment",
    domain: "embedded-driver",
    intent: "assignment-rhs",
    source: "void probe(void)\n{\n    status = |\n}\n",
  },
  {
    name: "ssd field assignment",
    domain: "ssd-domain",
    intent: "assignment-rhs",
    source: "void ssd_req_update(struct ssd_req *req)\n{\n    req->result = |\n}\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic goto error path",
    domain: "generic-c",
    intent: "error-path",
    source: "int parse(void)\n{\n    int ret;\n    goto |\nout:\n    return ret;\n}\n",
  },
  {
    name: "embedded ret guard error path",
    domain: "embedded-driver",
    intent: "error-path",
    source: "int probe(void)\n{\n    int ret;\n    if (ret) {\n        |\n    }\nout_unlock:\n    return ret;\n}\n",
  },
  {
    name: "qemu ufs goto prefix",
    domain: "qemu-ufs",
    intent: "error-path",
    source: "int ufs_realize(void)\n{\n    int ret;\n    goto out_|\nout_reset:\n    return ret;\n}\n",
    domainHints: ["ufs"],
  },
  {
    name: "generic case body",
    domain: "generic-c",
    intent: "switch-case",
    source: "void parser_dispatch(int opcode)\n{\n    switch (opcode) {\n    case PARSER_OP_READ:\n        |\n    }\n}\n",
  },
  {
    name: "embedded default body",
    domain: "embedded-driver",
    intent: "switch-case",
    source: "void irq_dispatch(unsigned int irq)\n{\n    switch (irq) {\n    default:\n        |\n    }\n}\n",
  },
  {
    name: "ssd switch case same line",
    domain: "ssd-domain",
    intent: "switch-case",
    source: "void ssd_admin_opcode(int opcode)\n{\n    switch (opcode) {\n    case SSD_ADMIN_IDENTIFY: |\n    }\n}\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic static function declaration",
    domain: "generic-c",
    intent: "top-level-decl",
    source: "static int |\n",
    triggerKind: "manual",
  },
  {
    name: "embedded struct declaration",
    domain: "embedded-driver",
    intent: "top-level-decl",
    source: "struct spi_ctrl |\n",
    triggerKind: "manual",
  },
  {
    name: "qemu ufs typedef declaration",
    domain: "qemu-ufs",
    intent: "top-level-decl",
    source: "typedef struct UfsRequest |\n",
    triggerKind: "manual",
    domainHints: ["ufs"],
  },
  {
    name: "generic define directive",
    domain: "generic-c",
    intent: "preprocessor",
    source: "#define |\n",
  },
  {
    name: "embedded if directive",
    domain: "embedded-driver",
    intent: "preprocessor",
    source: "#if |\n",
  },
  {
    name: "ssd ifdef directive",
    domain: "ssd-domain",
    intent: "preprocessor",
    source: "#ifdef SSD_|\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic readl register",
    domain: "generic-c",
    intent: "mmio-register",
    source: "void poll(void __iomem *base)\n{\n    readl(|);\n}\n",
  },
  {
    name: "embedded writel register",
    domain: "embedded-driver",
    intent: "mmio-register",
    source: "void write_reg(void __iomem *base)\n{\n    writel(value, base + |\n}\n",
  },
  {
    name: "ssd field prep register",
    domain: "ssd-domain",
    intent: "mmio-register",
    source: "void ssd_reg(void)\n{\n    FIELD_PREP(|);\n}\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic state assignment",
    domain: "generic-c",
    intent: "state-machine",
    source: "void parser_step(struct parser_ctx *ctx)\n{\n    ctx->state = |\n}\n",
  },
  {
    name: "embedded switch state",
    domain: "embedded-driver",
    intent: "state-machine",
    source: "void link_step(enum link_state state)\n{\n    switch (state|\n}\n",
  },
  {
    name: "qemu ufs mode macro",
    domain: "qemu-ufs",
    intent: "state-machine",
    source: "void ufs_link(struct UfsHc *u)\n{\n    u->mode = UFS_MODE_|\n}\n",
    domainHints: ["ufs"],
  },
  {
    name: "ssd state switch case body",
    domain: "ssd-domain",
    intent: "state-machine",
    source: "void ssd_step(struct ssd_ctx *ctx)\n{\n    switch (ctx->state) {\n    case SSD_STATE_READY:\n        |\n    }\n}\n",
    domainHints: ["ssd"],
  },
  {
    name: "generic body return",
    domain: "generic-c",
    intent: "body-statement",
    source: "int parse(void)\n{\n    return |\n}\n",
  },
  {
    name: "embedded blank body manual",
    domain: "embedded-driver",
    intent: "body-statement",
    source: "void probe(void)\n{\n    spin_lock(&lock);\n    |\n    spin_unlock(&lock);\n}\n",
    triggerKind: "manual",
  },
  {
    name: "ssd ordinary body statement",
    domain: "ssd-domain",
    intent: "body-statement",
    source: "void ssd_req_done(struct ssd_req *req)\n{\n    |\n}\n",
    triggerKind: "manual",
    domainHints: ["ssd"],
  },
]

describe("generic C embedded intent planner", () => {
  test("classifies all P1 C embedded intents with generic structural rules", () => {
    const seen = new Map<Intent, number>()
    const domains = new Set<Case["domain"]>()

    for (const item of intentCases) {
      const plan = planCompletion(fixtureInput(item))
      domains.add(item.domain)
      seen.set(item.intent, (seen.get(item.intent) ?? 0) + 1)
      expect(plan, item.name).toMatchObject({
        kind: "c-embedded-code",
        cIntent: item.intent,
        useFim: true,
        needsIntentRetrieval: true,
        needsSymbolRetrieval: true,
        needsTestRetrieval: false,
        useInstruction: false,
      })
      expect(plan.retrievalPolicy, item.name).toBeTruthy()
      expect(plan.retrievalPolicy, item.name).toEqual(expect.objectContaining({
        label: expect.any(String),
        intent: item.intent,
        queryMode: "c-embedded-intent",
        preferredKinds: expect.any(Array),
      }))
      expect(plan.confidenceFloor, item.name).toBeGreaterThan(0)
      for (const hint of item.domainHints ?? []) {
        expect(plan.domainHints, item.name).toContain(hint)
      }
    }

    for (const intent of [
      "member-access",
      "symbol-prefix",
      "call-args",
      "initializer",
      "condition",
      "assignment-rhs",
      "error-path",
      "switch-case",
      "top-level-decl",
      "preprocessor",
      "mmio-register",
      "state-machine",
      "body-statement",
    ] satisfies Intent[]) {
      expect(seen.get(intent), intent).toBeGreaterThanOrEqual(3)
    }

    expect(domains).toEqual(new Set(["generic-c", "embedded-driver", "qemu-ufs", "ssd-domain"]))
  })

  test("does not disable short C/C++ prefixes in safe contexts", () => {
    for (const currentWord of ["u", "r", "FT"]) {
      const plan = planCompletion({
        languageId: "c",
        linePrefix: `    ${currentWord}`,
        lineSuffix: "",
        currentWord,
        lines: ["void f(void)", "{", `    ${currentWord}`],
        line: 2,
        triggerKind: "automatic",
      })
      expect(plan).toMatchObject({
        kind: "c-embedded-code",
        cIntent: "symbol-prefix",
        useFim: true,
      })
    }
  })

  test("manual triggers produce C embedded plans except in unsafe contexts", () => {
    expect(planCompletion(fixtureInput({
      name: "manual blank body",
      domain: "generic-c",
      intent: "body-statement",
      source: "void f(void)\n{\n    |\n}\n",
      triggerKind: "manual",
    }))).toMatchObject({
      kind: "c-embedded-code",
      cIntent: "body-statement",
    })

    expect(planCEmbeddedCompletion(fixtureInput({
      name: "line comment",
      domain: "generic-c",
      intent: "body-statement",
      source: "void f(void)\n{\n    // |\n}\n",
      triggerKind: "manual",
    }))).toBeUndefined()

    expect(planCEmbeddedCompletion(fixtureInput({
      name: "string literal",
      domain: "generic-c",
      intent: "body-statement",
      source: "void f(void)\n{\n    const char *s = \"|\n}\n",
      triggerKind: "manual",
    }))).toBeUndefined()
  })
})

function fixtureInput(item: Case): CompletionPlanInput {
  const cursor = item.source.indexOf("|")
  if (cursor < 0) throw new Error(`missing cursor for ${item.name}`)
  const text = item.source.slice(0, cursor) + item.source.slice(cursor + 1)
  const prefix = item.source.slice(0, cursor)
  const suffix = item.source.slice(cursor + 1)
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const beforeLines = prefix.replace(/\r\n/g, "\n").split("\n")
  const line = beforeLines.length - 1
  const linePrefix = beforeLines.at(-1) ?? ""
  const suffixLines = suffix.replace(/\r\n/g, "\n").split("\n")
  const lineSuffix = suffixLines[0] ?? ""
  return {
    languageId: item.languageId ?? "c",
    linePrefix,
    lineSuffix,
    currentWord: currentWord(linePrefix),
    previousNonEmptyLine: previousNonEmptyLineBefore(lines, line),
    nextNonEmptyLine: nextNonEmptyLineAfter(lines, line),
    lines,
    line,
    triggerKind: item.triggerKind ?? "automatic",
  }
}

function currentWord(linePrefix: string) {
  return /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)?.[0]
}

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index -= 1) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function nextNonEmptyLineAfter(lines: string[], line: number) {
  for (let index = line + 1; index < lines.length; index += 1) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}
