#!/usr/bin/env node

/**
 * Web search using Jina Search API.
 */

const TIMEOUT_MS = 30_000;

function printUsage(): void {
  console.log("Usage: search.ts <query>");
  console.log();
  console.log("Searches the web using Jina Search API.");
  console.log();
  console.log("Environment:");
  console.log("  JINA_API_KEY    Optional. Your Jina API key for higher rate limits.");
  console.log();
  console.log("Examples:");
  console.log('  search.ts "python async await"');
  console.log('  search.ts "rust ownership tutorial"');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    printUsage();
    process.exit(1);
  }

  const query = args.join(" ");
  const encodedQuery = encodeURIComponent(query);
  const url = `https://s.jina.ai/?q=${encodedQuery}`;

  const headers: Record<string, string> = {
    "User-Agent": "pi-skill/1.0",
    "X-Respond-With": "no-content",
    Accept: "text/plain",
  };

  const apiKey = process.env.JINA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Error: HTTP ${response.status} - ${response.statusText}`);
      process.exit(1);
    }

    const content = (await response.text()).trim();

    if (!content) {
      console.log("No search results found. Try a different query.");
      process.exit(0);
    }

    console.log("## Search Results");
    console.log();
    console.log(content);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("Error: request timed out");
      process.exit(1);
    }

    if (error instanceof Error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        console.error(`Error: ${error.message} (${cause.message})`);
      } else {
        console.error(`Error: ${error.message}`);
      }
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
