import { EventEmitter } from "node:events";

export interface NeedsInput {
  kind: "question" | "permission";
  title: string;
  body?: string;
}

/** Small process-local bus so UI extensions can notify without importing each other. */
export const needsInput = new EventEmitter();
export function emitNeedsInput(event: NeedsInput): void {
  needsInput.emit("needs-input", event);
}
