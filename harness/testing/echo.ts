// harness/testing/echo.ts
//
// No-network "echo" model + session for headless tests and demos. Built on
// omp's own built-in mock provider (`@oh-my-pi/pi-ai/providers/mock`) — confirmed
// in ADR-0003 as the real no-network path (there is no models.yml stub provider).
//
// This lets us drive `session.prompt(...)` to completion with zero API keys and
// zero network, the basis of the fast golden-path replay tests. The auth-storage
// + model-registry boilerplate mirrors omp's own test setup.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, registerMockApi, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context } from "@oh-my-pi/pi-ai";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

const ECHO_PROVIDER = "echo";

let registered = false;

/** Register omp's mock streaming API exactly once per process. */
export function ensureMockApi(): void {
  if (registered) return;
  registerMockApi();
  registered = true;
}

/** Extract the most recent user message text from a Context, best-effort. */
function lastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .map((part) =>
          typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "",
        )
        .join("");
      if (text) return text;
    }
    return "";
  }
  return "";
}

/**
 * Build an echo model. Each turn it replies `<prefix><last user message>` and
 * stops cleanly, so `session.prompt()` resolves without triggering tool use.
 */
export function createEchoModel(prefix = "echo: "): MockModel {
  ensureMockApi();
  return createMockModel({
    id: "echo-model",
    provider: ECHO_PROVIDER,
    handler: (context: Context) => ({
      content: [`${prefix}${lastUserText(context)}`],
      stopReason: "stop" as const,
    }),
  });
}

export interface EchoSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  /** The underlying mock model; inspect `model.calls` for the Context it saw. */
  model: MockModel;
  /** Tear down auth storage and the isolated temp cwd. */
  cleanup: () => void;
}

export interface EchoSessionOptions {
  /** Prefix the echo handler prepends to the echoed user text. */
  prefix?: string;
  /** System prompt to pass through to omp (e.g. an assembled [prefix, tail]). */
  systemPrompt?: string | string[];
}

/**
 * Create a fully headless, no-network agent session backed by the echo model.
 * Isolated temp cwd + an in-temp auth store with a dummy runtime key so omp's
 * per-provider auth check passes. Offline fetch so model discovery never hits
 * the network.
 */
export async function createEchoSession(opts: EchoSessionOptions = {}): Promise<EchoSession> {
  const model = createEchoModel(opts.prefix ?? "echo: ");
  const cwd = mkdtempSync(join(tmpdir(), "omp-echo-"));

  const authStorage = await AuthStorage.create(join(cwd, "auth.db"));
  authStorage.setRuntimeApiKey(ECHO_PROVIDER, "test-key");

  const offlineFetch = (() =>
    Promise.reject(new Error("network disabled in echo session"))) as unknown as typeof fetch;
  const modelRegistry = new ModelRegistry(authStorage, join(cwd, "models.yml"), { fetch: offlineFetch });

  const { session } = await createAgentSession({
    model,
    cwd,
    authStorage,
    modelRegistry,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
  });

  return {
    session,
    model,
    cleanup: () => {
      try {
        authStorage.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
