import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import lspHookExtension from "./lsp.js";
import lspToolExtension from "./lsp-tool.js";

export default function (pi: ExtensionAPI) {
  lspHookExtension(pi);
  lspToolExtension(pi);
}
