import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Set PI_TEST_NODE_MODULES to the installed Pi's node_modules to avoid a second SDK installation.
const base = process.env.PI_TEST_NODE_MODULES
  ? join(process.env.PI_TEST_NODE_MODULES, "pi-core-tests.mjs") : fileURLToPath(import.meta.url);
const require = createRequire(base);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
const resolver = createJiti(base);
export const resolveHost = (name) => resolver.esmResolve(name, { conditions: ["import"] });
export const importHost = (name) => import(resolveHost(name));
const alias = Object.fromEntries([
  "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox",
].map((name) => [name, fileURLToPath(resolveHost(name))]));
if (process.env.PI_TEST_DEPENDENCY_MODULES) {
  const deps = createRequire(join(process.env.PI_TEST_DEPENDENCY_MODULES, "pi-core-tests.cjs"));
  alias["shell-quote"] = deps.resolve("shell-quote");
}
export const jiti = createJiti(import.meta.url, { tryNative: false, alias });
export const sdk = await importHost("@earendil-works/pi-coding-agent");
export const ai = await importHost("@earendil-works/pi-ai");
