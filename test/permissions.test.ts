import { describe, expect, test } from "bun:test"
import { decideChipMatePermission, hardProtectionReason, isPathInside } from "../src/permissions"

describe("ChipMate permissions", () => {
  test("allows only read operations in read-only profile", () => {
    expect(decideChipMatePermission({ profile: "readOnly", capability: "readWorkspace" })).toMatchObject({
      status: "allow",
    })
    expect(decideChipMatePermission({ profile: "readOnly", capability: "writeWorkspace" })).toMatchObject({
      status: "deny",
    })
    expect(decideChipMatePermission({ profile: "readOnly", capability: "runShell", command: "bun test" })).toMatchObject({
      status: "deny",
    })
  })

  test("asks for risky operations in ask-approval profile", () => {
    expect(decideChipMatePermission({ profile: "askApproval", capability: "readWorkspace" })).toMatchObject({
      status: "allow",
    })
    expect(decideChipMatePermission({ profile: "askApproval", capability: "writeWorkspace", targetPath: "/repo/src/a.ts" })).toMatchObject({
      status: "ask",
    })
  })

  test("trusted workspace can reuse first-use approvals", () => {
    expect(decideChipMatePermission({
      profile: "trustedWorkspace",
      capability: "runSkillScript",
      command: "node skill.js",
    })).toMatchObject({
      status: "ask",
    })
    expect(decideChipMatePermission({
      profile: "trustedWorkspace",
      capability: "runSkillScript",
      command: "node skill.js",
      previouslyApproved: true,
    })).toMatchObject({
      status: "allow",
    })
    expect(decideChipMatePermission({
      profile: "trustedWorkspace",
      capability: "runShell",
      command: "make test",
    })).toMatchObject({
      status: "ask",
    })
  })

  test("full access allows normal shell while preserving hard protection", () => {
    expect(decideChipMatePermission({
      profile: "fullAccess",
      capability: "runShell",
      command: "bun test",
    })).toMatchObject({
      status: "allow",
    })
    expect(decideChipMatePermission({
      profile: "fullAccess",
      capability: "runShell",
      command: "rm -rf /",
    })).toMatchObject({
      status: "deny",
      hardProtection: true,
    })
  })

  test("blocks sensitive paths and workspace-external writes", () => {
    expect(hardProtectionReason({
      profile: "fullAccess",
      capability: "writeWorkspace",
      targetPath: "/Users/archer/.ssh/id_rsa",
    })).toContain("protected")
    expect(hardProtectionReason({
      profile: "fullAccess",
      capability: "writeWorkspace",
      targetPath: "/tmp/outside.txt",
      workspaceRoots: ["/repo"],
    })).toContain("outside")
    expect(hardProtectionReason({
      profile: "fullAccess",
      capability: "writeWorkspace",
      targetPath: "/repo/src/a.ts",
      workspaceRoots: ["/repo"],
    })).toBe("")
  })

  test("checks workspace containment with normalized paths", () => {
    expect(isPathInside("/repo/src/a.ts", "/repo")).toBe(true)
    expect(isPathInside("/repo2/src/a.ts", "/repo")).toBe(false)
    expect(isPathInside("C:\\repo\\src\\a.ts", "C:\\repo")).toBe(true)
  })
})
