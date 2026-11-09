/**
 * State of a review session: the stops, where the slider is, and one thread per
 * stop. Pure data and pure functions, so the flow can be tested without a
 * terminal, a model or Neovim.
 */

import type { SharedDeletedBlock } from "../lib/tour-state.js";

export interface ReviewStop {
  file: string;
  from: number;
  to: number;
  title: string;
  why: string;
  note?: string;
  added: number[];
  deleted: SharedDeletedBlock[];
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface ReviewSession {
  stops: ReviewStop[];
  index: number;
  base: string;
  /** Threads keyed by stop index; a stop without a thread was simply accepted. */
  threads: Map<number, Turn[]>;
  /** Moves made by the user, for the submit digest. */
  visited: Set<number>;
}

export function createSession(stops: ReviewStop[], base: string): ReviewSession | undefined {
  if (!stops.length) return;
  return { stops, index: 0, base, threads: new Map(), visited: new Set([0]) };
}

export function currentStop(session: ReviewSession): ReviewStop | undefined {
  return session.stops[session.index];
}

/** Move the slider; returns false at either end so the caller can say so. */
export function move(session: ReviewSession, delta: number): boolean {
  const next = session.index + delta;
  if (next < 0 || next >= session.stops.length) return false;
  session.index = next;
  session.visited.add(next);
  return true;
}

export function thread(session: ReviewSession, index = session.index): Turn[] {
  return session.threads.get(index) ?? [];
}

export function appendTurn(session: ReviewSession, turn: Turn, index = session.index): void {
  const turns = session.threads.get(index) ?? [];
  turns.push(turn);
  session.threads.set(index, turns);
}

/** Stops the user never opened are still part of the summary, marked as such. */
export function acceptedWithoutDiscussion(session: ReviewSession): ReviewStop[] {
  return session.stops.filter((_stop, index) => !session.threads.has(index));
}

/**
 * Deterministic digest, used when the model cannot write one: every stop with
 * its reason, and the questions asked about it.
 */
export function fallbackSummary(session: ReviewSession): string {
  const lines = [`Review of ${session.stops.length} stop${session.stops.length === 1 ? "" : "s"} against ${session.base}.`];
  session.stops.forEach((stop, index) => {
    const turns = thread(session, index);
    const questions = turns.filter((turn) => turn.role === "user").map((turn) => turn.text.trim());
    lines.push("");
    lines.push(`${index + 1}. ${stop.title} — ${stop.file}:${stop.from}-${stop.to}`);
    if (stop.why) lines.push(`   why: ${stop.why}`);
    if (questions.length) lines.push(`   discussed: ${questions.join(" · ")}`);
  });
  return lines.join("\n");
}

/** What the digest prompt needs: the conversation of every thread, compactly. */
export function threadTranscript(session: ReviewSession): string {
  return session.stops.map((stop, index) => {
    const turns = thread(session, index);
    const body = turns.length
      ? turns.map((turn) => `${turn.role === "user" ? "Q" : "A"}: ${turn.text.trim()}`).join("\n")
      : "(not discussed)";
    return `## Stop ${index + 1}: ${stop.title} (${stop.file}:${stop.from}-${stop.to})\nwhy: ${stop.why || "(none)"}\n${body}`;
  }).join("\n\n");
}
