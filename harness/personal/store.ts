// harness/personal/store.ts — the encrypted personalization knowledge-graph store
// (ADR-0010, P9.1). A private "second brain" of user-facts the agent learns and recalls
// to tailor responses. OPT-IN, LOCAL-FIRST, ENCRYPTED-AT-REST.
//
// The store is a single AES-256-GCM-encrypted document (default ~/.omp/lucid-personal.kg.enc).
// The graph is small, so we load-decrypt into memory, mutate, and re-encrypt on save.
// The data-encryption key (DEK) lives ONLY in memory; it is sealed at rest two ways:
//   - passphrase custody: the DEK is wrapped by a PBKDF2-HMAC-SHA256 key-encryption key.
//   - keystore custody:   the DEK is sealed by the OS keystore (Electron safeStorage) by
//                         the desktop main process, and handed to openWithKey() unsealed.
// Format is versioned `personal-kg.v1` (its own frozen contract; a bump re-encrypts).

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Telemetry } from "../telemetry/events.ts";
import type { TrustLabel } from "../contracts.ts";
import { decrypt, deriveKey, encrypt, KDF_ITERS, randomKey, randomSalt, type Sealed } from "./crypto.ts";

export const STORE_VERSION = "personal-kg.v1" as const;
export type UserKind =
  | "user:preference" | "user:decision" | "user:interest" | "user:behavior"
  | "user:personality" | "user:link" | "user:skill" | "user:goal" | "user:relationship";

// Compartment a fact belongs to (ADR-0012). A fact is in exactly one scope; "combined"
// is a VIEW (the union), never a stored value. CUI = Controlled Unclassified Information
// — heightened handling: never auto-exported / shared with external consumers.
export type PersonalScope = "work" | "personal" | "cui";
export type ScopeView = PersonalScope | "combined";
export const SCOPES: readonly PersonalScope[] = ["work", "personal", "cui"];

export interface PersonalEntity { id: string; name: string; kind: UserKind; trust_label: TrustLabel; confidence: number; created_at: string }
export interface PersonalFact {
  id: string; entity_id: string; statement: string; scope: PersonalScope; trust_label: TrustLabel; confidence: number;
  source_session_id?: string; source_run_id?: string; provenance_artifact_id?: string;
  status: "active" | "forgotten"; promoted_at: string;
}
export interface PersonalLink { id: string; from_entity_id: string; to_entity_id: string; relation: string; created_at: string }
// An audited decrypt→export action (P9.4). Kept INSIDE the encrypted store so the export
// trail is as private + tamper-evident as the data it concerns. Metadata only — never
// fact content. `kind: "cui-archive"` is the loud, NARA-aligned CUI migration path.
export interface PersonalExportEvent {
  id: string; kind: "vault" | "cui-archive"; scopes: PersonalScope[];
  entity_count: number; fact_count: number; file_count: number;
  payload_sha256: string; manifest_sha256?: string; dest?: string; reviewer?: string;
  included_cui: boolean; at: string;
}
export interface PersonalGraph {
  entities: PersonalEntity[]; facts: PersonalFact[]; links: PersonalLink[];
  /** Append-only audit of decrypt→export actions (P9.4). Optional for back-compat. */
  exports?: PersonalExportEvent[];
}

type Custody = "passphrase" | "keystore";
interface Envelope {
  v: typeof STORE_VERSION;
  custody: Custody;
  kdf?: { algo: "pbkdf2-hmac-sha256"; iters: number; salt: string };
  wrappedDek?: Sealed; // passphrase custody only
  data: Sealed; // the graph JSON, encrypted with the DEK
}

const EMPTY: PersonalGraph = { entities: [], facts: [], links: [] };
const now = (): string => new Date().toISOString();

export class PersonalStore {
  #path: string;
  #dek: Buffer;
  #custody: Custody;
  #kdf?: { algo: "pbkdf2-hmac-sha256"; iters: number; salt: string };
  #wrappedDek?: Sealed;
  #graph: PersonalGraph;

  private constructor(path: string, dek: Buffer, custody: Custody, graph: PersonalGraph, kdf?: Envelope["kdf"], wrappedDek?: Sealed) {
    this.#path = path; this.#dek = dek; this.#custody = custody; this.#graph = graph; this.#kdf = kdf; this.#wrappedDek = wrappedDek;
  }

  // ── passphrase custody ──────────────────────────────────────────────────────
  /** Create a brand-new encrypted store sealed by a passphrase. */
  static createWithPassphrase(path: string, passphrase: string): PersonalStore {
    const salt = randomSalt();
    const kek = deriveKey(passphrase, salt, KDF_ITERS);
    const dek = randomKey();
    const wrappedDek = encrypt(dek, kek);
    const kdf = { algo: "pbkdf2-hmac-sha256" as const, iters: KDF_ITERS, salt: salt.toString("base64") };
    const s = new PersonalStore(path, dek, "passphrase", structuredClone(EMPTY), kdf, wrappedDek);
    s.save();
    return s;
  }

  /** Open + unlock a passphrase-sealed store. THROWS on a wrong passphrase or tampering. */
  static openWithPassphrase(path: string, passphrase: string, opts: { telemetry?: Telemetry } = {}): PersonalStore {
    const env = readEnvelope(path);
    if (env.custody !== "passphrase" || !env.kdf || !env.wrappedDek) throw new Error("store is not passphrase-sealed");
    const kek = deriveKey(passphrase, Buffer.from(env.kdf.salt, "base64"), env.kdf.iters);
    const dek = decrypt(env.wrappedDek, kek); // throws if passphrase is wrong (GCM auth)
    const graph = decodeGraph(decrypt(env.data, dek));
    opts.telemetry?.emit("personal_store_unlocked", { custody: "passphrase", entities: graph.entities.length, facts: graph.facts.length });
    return new PersonalStore(path, dek, "passphrase", graph, env.kdf, env.wrappedDek);
  }

  // ── OS-keystore custody (DEK sealed externally by Electron safeStorage) ──────
  /** Create a store whose DEK is custodied by the OS keystore (caller persists the
   *  sealed DEK separately). `dek` is a fresh key from crypto.randomKey(). */
  static createWithKey(path: string, dek: Buffer): PersonalStore {
    const s = new PersonalStore(path, dek, "keystore", structuredClone(EMPTY));
    s.save();
    return s;
  }
  /** Open a keystore-custodied store with the DEK the OS keystore unsealed. */
  static openWithKey(path: string, dek: Buffer, opts: { telemetry?: Telemetry } = {}): PersonalStore {
    const env = readEnvelope(path);
    if (env.custody !== "keystore") throw new Error("store is not keystore-sealed");
    const graph = decodeGraph(decrypt(env.data, dek)); // throws on a wrong key
    opts.telemetry?.emit("personal_store_unlocked", { custody: "keystore", entities: graph.entities.length, facts: graph.facts.length });
    return new PersonalStore(path, dek, "keystore", graph);
  }

  static exists(path: string): boolean { return existsSync(path); }

  // ── graph mutation (in-memory; call save() to persist) ──────────────────────
  /** Add or reuse an entity by (name, kind). Returns its id. */
  upsertEntity(name: string, kind: UserKind, trustLabel: TrustLabel, confidence = 1): string {
    const found = this.#graph.entities.find((e) => e.name === name && e.kind === kind);
    if (found) return found.id;
    const id = Snowflake.next();
    this.#graph.entities.push({ id, name, kind, trust_label: trustLabel, confidence, created_at: now() });
    return id;
  }
  addFact(input: { entityId: string; statement: string; trustLabel: TrustLabel; scope?: PersonalScope; confidence?: number; sourceSessionId?: string; sourceRunId?: string; provenanceArtifactId?: string }): string {
    const id = Snowflake.next();
    this.#graph.facts.push({
      id, entity_id: input.entityId, statement: input.statement, scope: input.scope ?? "personal", trust_label: input.trustLabel,
      confidence: input.confidence ?? 1, source_session_id: input.sourceSessionId, source_run_id: input.sourceRunId,
      provenance_artifact_id: input.provenanceArtifactId, status: "active", promoted_at: now(),
    });
    return id;
  }
  addLink(fromEntityId: string, toEntityId: string, relation: string): string {
    const id = Snowflake.next();
    this.#graph.links.push({ id, from_entity_id: fromEntityId, to_entity_id: toEntityId, relation, created_at: now() });
    return id;
  }
  /** Record an audited export (P9.4). Appends to the encrypted, in-store trail and
   *  returns the event id. The caller persists with save(). Metadata only. */
  recordExport(ev: Omit<PersonalExportEvent, "id" | "at">): string {
    const id = Snowflake.next();
    (this.#graph.exports ??= []).push({ ...ev, id, at: now() });
    return id;
  }
  /** The decrypt→export audit trail (most recent first). */
  exportLog(): PersonalExportEvent[] {
    return structuredClone([...(this.#graph.exports ?? [])].reverse());
  }

  /** Soft-delete a fact (the user "forgets" it). */
  forgetFact(factId: string): boolean {
    const f = this.#graph.facts.find((x) => x.id === factId);
    if (!f) return false;
    f.status = "forgotten";
    return true;
  }
  /** A copy of the current graph (active facts only by default), optionally filtered to
   *  one compartment. `scope: "combined"` (the default) returns every compartment. */
  graph(opts: { includeForgotten?: boolean; scope?: ScopeView } = {}): PersonalGraph {
    let facts = opts.includeForgotten ? this.#graph.facts : this.#graph.facts.filter((f) => f.status === "active");
    if (opts.scope && opts.scope !== "combined") facts = facts.filter((f) => f.scope === opts.scope);
    return structuredClone({ entities: this.#graph.entities, facts, links: this.#graph.links });
  }
  /** Active-fact counts per compartment — for the UI selector + risk surfacing. */
  scopeCounts(): Record<PersonalScope, number> {
    const c: Record<PersonalScope, number> = { work: 0, personal: 0, cui: 0 };
    for (const f of this.#graph.facts) if (f.status === "active") c[f.scope]++;
    return c;
  }

  /** Re-encrypt the graph and write it to disk (user-only perms, best-effort). */
  save(): void {
    const env: Envelope = {
      v: STORE_VERSION, custody: this.#custody, kdf: this.#kdf, wrappedDek: this.#wrappedDek,
      data: encrypt(JSON.stringify(this.#graph), this.#dek),
    };
    writeFileSync(this.#path, JSON.stringify(env), "utf8");
    try { chmodSync(this.#path, 0o600); } catch { /* best-effort on Windows */ }
  }
  /** Zero the in-memory key (call when locking the store). */
  lock(): void { this.#dek.fill(0); }
}

function readEnvelope(path: string): Envelope {
  const env = JSON.parse(readFileSync(path, "utf8")) as Envelope;
  if (env.v !== STORE_VERSION) throw new Error(`unsupported store version ${env.v}`);
  return env;
}
function decodeGraph(buf: Buffer): PersonalGraph {
  const g = JSON.parse(buf.toString("utf8")) as Partial<PersonalGraph>;
  return { entities: g.entities ?? [], facts: g.facts ?? [], links: g.links ?? [], exports: g.exports ?? [] };
}
