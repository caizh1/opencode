import { createMemo } from "solid-js"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"

type PlanExitAnswer = "Yes" | "No"

export function SessionPlanExitDock(props: { request: QuestionRequest; onSubmit: () => void }) {
  const sdk = useSDK()
  const local = useLocal()
  const language = useLanguage()

  const replyMutation = useMutation(() => ({
    mutationFn: (answer: PlanExitAnswer) =>
      sdk.client.question.reply({ requestID: props.request.id, answers: [[answer]] }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: (_, answer) => {
      if (answer === "Yes") local.agent.set("build")
    },
    onError: (err: unknown) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  const sending = createMemo(() => replyMutation.isPending)
  const reply = (answer: PlanExitAnswer) => {
    if (sending()) return
    void replyMutation.mutateAsync(answer)
  }

  return (
    <DockPrompt
      kind="question"
      header={
        <div data-slot="plan-exit-header">
          <span data-slot="plan-exit-icon">
            <Icon name="circle-check" size="normal" />
          </span>
          <div data-slot="plan-exit-title">{language.t("session.planExit.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="plan-exit-footer-actions">
            <Button
              variant="secondary"
              size="normal"
              icon="pencil-line"
              disabled={sending()}
              onClick={() => reply("No")}
            >
              {language.t("session.planExit.continue")}
            </Button>
            <Button
              variant="primary"
              size="normal"
              icon="arrow-right"
              disabled={sending()}
              onClick={() => reply("Yes")}
            >
              {language.t("session.planExit.execute")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="plan-exit-content">
        <div data-slot="plan-exit-description">{language.t("session.planExit.description")}</div>
      </div>
    </DockPrompt>
  )
}
