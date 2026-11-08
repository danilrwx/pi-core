export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
const MAX_QUESTION = 500;
const MAX_HEADER = 40;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 300;

export interface QuestionOption { label: string; description?: string }
export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}
export interface QuestionResult { questions: Question[]; answers: string[][]; dismissed: boolean }

/** Terminal control sequences never belong in a question or option label. */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("Question text must be a string");
  const text = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new Error("Question text must not be empty");
  return text.slice(0, max);
}

export function normalizeQuestions(input: unknown): Question[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("At least one question is required");
  if (input.length > MAX_QUESTIONS) throw new Error(`At most ${MAX_QUESTIONS} questions are allowed`);
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Question ${index + 1} must be an object`);
    const item = raw as Record<string, unknown>;
    const question = sanitizeText(item.question, MAX_QUESTION);
    const options = item.options ?? [];
    if (!Array.isArray(options)) throw new Error(`Question ${index + 1} options must be an array`);
    if (options.length > MAX_OPTIONS) throw new Error(`At most ${MAX_OPTIONS} options are allowed per question`);
    const normalized = options.map((rawOption, optionIndex) => {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
        throw new Error(`Question ${index + 1} option ${optionIndex + 1} must be an object`);
      }
      const value = rawOption as Record<string, unknown>;
      const label = sanitizeText(value.label, MAX_LABEL);
      const option: QuestionOption = { label };
      if (value.description !== undefined) option.description = sanitizeText(value.description, MAX_DESCRIPTION);
      return option;
    });
    const labels = new Set<string>();
    for (const option of normalized) {
      if (labels.has(option.label)) throw new Error(`Question ${index + 1} has duplicate option label: ${option.label}`);
      labels.add(option.label);
    }
    return {
      id: `q${index + 1}`,
      header: item.header === undefined ? `Q${index + 1}` : sanitizeText(item.header, MAX_HEADER),
      question,
      options: normalized,
      multiSelect: item.multiSelect === true,
    };
  });
}
export function answerLines(questions: Question[], answers: string[][]): string[] {
  return questions.map((question, index) => {
    const value = (answers[index] ?? []).filter(Boolean);
    return `${question.header}: ${value.length ? value.join(", ") : "(no answer)"}`;
  });
}
export function buildContent(result: QuestionResult): string {
  if (result.dismissed) return "(question dismissed by user)";
  return answerLines(result.questions, result.answers).join("\n");
}
