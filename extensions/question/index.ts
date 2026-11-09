import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createQuestionForm } from "./form.js";
import { buildContent, normalizeQuestions, type Question, type QuestionResult } from "./normalize.js";
import { emitNeedsInput } from "../lib/needs-input.js";

const PARAMETERS = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ description: "The question to ask" }),
    header: Type.Optional(Type.String({ description: "Short tab label, e.g. Scope or Priority (defaults to Q1)" })),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ description: "Option label; put the recommended choice first and suffix it with (Recommended)" }),
      description: Type.Optional(Type.String({ description: "What the option means or costs" })),
    }), { description: "Authored choices; 'Type your own answer' is always appended" })),
    multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting several options (Space toggles)" })),
  }), { description: "One to four questions answered in one dialog" }),
}, { additionalProperties: false });

function errorResult(message: string, questions: Question[] = []) {
  const details: QuestionResult = { questions, answers: questions.map(() => []), dismissed: true };
  return { content: [{ type: "text" as const, text: message }], details, isError: true };
}

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    executionMode: "sequential",
    description: "Ask the user one to four multiple-choice questions in a terminal dialog and get their answers back. Use when guessing would waste work: ambiguous requirements, preferences, implementation choices.",
    promptSnippet: "Ask the user structured questions instead of guessing",
    promptGuidelines: [
      "Use question for decisions that the user should make; do not ask about things you can verify yourself.",
      "Give each question 2-4 concrete options with descriptions, recommended first and labelled (Recommended); a free-text answer is always available.",
      "Ask at most four questions at once, and put independent questions in the same call rather than interrupting repeatedly.",
    ],
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let questions: Question[];
      try { questions = normalizeQuestions(params.questions); }
      catch (error) { return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`); }
      if (ctx.mode !== "tui") {
        return errorResult("Error: question UI needs the interactive terminal; ask the user in plain text instead.", questions);
      }
      emitNeedsInput({ kind: "question", title: "Question", body: questions[0]?.question ?? "The agent is waiting for your answer" });
      const result = await ctx.ui.custom<QuestionResult>(
        (tui, theme, _keybindings, done) => createQuestionForm(tui, theme, questions, done),
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", minWidth: 50, anchor: "center", margin: 2 } },
      );
      return { content: [{ type: "text", text: buildContent(result) }], details: result };
    },
    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions as { header?: string }[] : [];
      const labels = questions.map((entry, index) => entry.header || `Q${index + 1}`).join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`)}${labels ? theme.fg("dim", ` (${labels})`) : ""}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as QuestionResult | undefined;
      if (!details) {
        const part = result.content[0];
        return new Text(part?.type === "text" ? part.text : "", 0, 0);
      }
      if (details.dismissed) return new Text(theme.fg("warning", "Dismissed"), 0, 0);
      return new Text(details.questions.map((entry, index) => {
        const answer = details.answers[index]?.join(", ");
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", entry.header)}: ${answer ? theme.fg("text", answer) : theme.fg("warning", "(no answer)")}`;
      }).join("\n"), 0, 0);
    },
  });
}
