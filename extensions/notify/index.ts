import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeArgs } from "../lib/complete.js";
import { needsInput, type NeedsInput } from "../lib/needs-input.js";

type Kind = "kitty" | "osc777" | "none";

function terminalKind(env: NodeJS.ProcessEnv = process.env): Kind {
  if (!env.KITTY_WINDOW_ID && !/kitty/i.test(env.TERM_PROGRAM ?? "") && !/kitty/i.test(env.TERM ?? "")) return "none";
  return "kitty";
}

/** Pure payload builder so it can be tested without writing to a terminal. */
export function notificationPayload(title: string, body: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const kind = terminalKind(env);
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const safeTitle = (clean(title).replace(/[;\\]/g, " ").slice(0, 80) || "pi");
  const safeBody = clean(body).replace(/[;\\]/g, " ").slice(0, 240);
  if (kind === "kitty") return `\x1b]99;i=1:d=0;${safeTitle}\x1b\\\x1b]99;i=1:p=body;${safeBody}\x1b\\`;
  return `\x1b]777;notify;${safeTitle};${safeBody}\x07`;
}

export default function notify(pi: ExtensionAPI) {
  let enabled = process.env.PI_NOTIFY !== "0";
  let listener: ((event: NeedsInput) => void) | undefined;

  const send = (title: string, body: string) => {
    if (!enabled || !process.stdout.isTTY) return;
    const payload = notificationPayload(title, body);
    if (payload) process.stdout.write(payload);
  };

  pi.on("session_start", () => {
    // session_start can fire more than once in a long-lived process; keep one listener.
    if (listener) needsInput.off("needs-input", listener);
    listener = (event) => { if (enabled) send("pi", `${event.body ?? event.title}`); };
    needsInput.on("needs-input", listener);
  });
  pi.on("session_shutdown", () => {
    if (listener) needsInput.off("needs-input", listener);
    listener = undefined;
  });
  pi.on("agent_settled", () => {
    if (!enabled) return;
    send("pi", "Ready for input");
  });
  pi.registerCommand("notify", {
    description: "Terminal notification when the agent is ready: /notify on|off|status",
    getArgumentCompletions: (prefix) => completeArgs(prefix, ["on", "off", "status"], {},
      { on: "notify when ready", off: "disable notifications", status: "show current state" }),
    handler: async (args, context) => {
      const action = args.trim() || "status";
      if (action === "on" || action === "off") enabled = action === "on";
      context.ui.notify(`Notifications: ${enabled ? "on" : "off"}${enabled && terminalKind() === "none" ? " (Kitty not detected; OSC 777 will be used)" : ""}`, "info");
    },
  });

}
