// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// P-REMOTE.7: metadata-only hosted-relay presence. This module deliberately has no Firebase/npm dependency:
// it exchanges the Cloud Run service identity for an OAuth token through the metadata server, then writes
// complete, sanitized Firestore documents over REST. Raw room ids and user agents exist only in this process.

export type RelayPresenceRole = "host" | "guest";
export type RelayPresenceActivity = "heartbeat" | "binary";

/** Authenticated identity retained by the relay only. userAgent is intentionally never serialized. */
export interface RelayPresencePrincipal {
  uid: string;
  email: string;
  admin: boolean;
  premium: boolean;
  effectivePremium: boolean;
  userAgent: string;
}

/** Optional hooks consumed by relay_server.ts. Implementations must be treated as fail-soft by callers. */
export interface RelayPresenceHooks {
  hostStarted(roomId: string, host: RelayPresencePrincipal): void | Promise<void>;
  hostReclaimed(roomId: string, host: RelayPresencePrincipal): void | Promise<void>;
  hostGrace(roomId: string): void | Promise<void>;
  hostClosed(roomId: string): void | Promise<void>;
  guestJoined(roomId: string, peerId: number, guest: RelayPresencePrincipal): void | Promise<void>;
  guestLeft(roomId: string, peerId: number): void | Promise<void>;
  activity(roomId: string, role: RelayPresenceRole, peerId: number, kind: RelayPresenceActivity): void | Promise<void>;
  /** Waits only for already-enqueued writes. Admission and socket shutdown never await this. */
  flush?(): Promise<void>;
}

export interface FirestoreRelayPresenceConfig {
  projectId: string;
  databaseId?: string;
  retentionDays?: number;
  maxPendingRooms?: number;
  activityThrottleMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (message: string, detail?: unknown) => void;
}

interface ParticipantState extends RelayPresencePrincipal {
  role: "guest";
  joinedAt: number;
  lastSeenAt: number;
  leftAt?: number;
}

interface SessionState {
  status: "active" | "grace" | "closed";
  host: RelayPresencePrincipal;
  participants: Map<number, ParticipantState>;
  createdAt: number;
  lastSeenAt: number;
  closedAt?: number;
  guestPeakCount: number;
  guestJoinCount: number;
  heartbeatCount: number;
}

interface FirestoreValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  timestampValue?: string;
  mapValue?: { fields: Record<string, FirestoreValue> };
  arrayValue?: { values: FirestoreValue[] };
}

interface PendingWrite {
  fields: Record<string, FirestoreValue>;
  terminal: boolean;
}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable Firestore document id. The raw room id never leaves the process. */
export async function hashRelayRoomId(roomId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(roomId)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

function timestamp(value: number): FirestoreValue {
  return { timestampValue: new Date(value).toISOString() };
}

function identityFields(identity: RelayPresencePrincipal): Record<string, FirestoreValue> {
  return {
    uid: { stringValue: identity.uid },
    email: { stringValue: identity.email },
    admin: { booleanValue: identity.admin },
    premium: { booleanValue: identity.premium },
    effectivePremium: { booleanValue: identity.effectivePremium },
  };
}

/** Produces the complete allowlisted document body; no spread of in-memory state is permitted here. */
function serializeSession(session: SessionState, retentionMs: number): Record<string, FirestoreValue> {
  const participants: FirestoreValue[] = [];
  let guestActiveCount = 0;
  for (const participant of session.participants.values()) {
    if (participant.leftAt === undefined) guestActiveCount++;
    const fields: Record<string, FirestoreValue> = {
      ...identityFields(participant),
      role: { stringValue: participant.role },
      joinedAt: timestamp(participant.joinedAt),
      lastSeenAt: timestamp(participant.lastSeenAt),
    };
    if (participant.leftAt !== undefined) fields.leftAt = timestamp(participant.leftAt);
    participants.push({ mapValue: { fields } });
  }

  const expiryBase = session.closedAt ?? session.lastSeenAt;
  const fields: Record<string, FirestoreValue> = {
    status: { stringValue: session.status },
    host: { mapValue: { fields: identityFields(session.host) } },
    participants: { arrayValue: { values: participants } },
    createdAt: timestamp(session.createdAt),
    lastSeenAt: timestamp(session.lastSeenAt),
    expireAt: timestamp(expiryBase + retentionMs),
    guestActiveCount: { integerValue: String(guestActiveCount) },
    guestPeakCount: { integerValue: String(session.guestPeakCount) },
    guestJoinCount: { integerValue: String(session.guestJoinCount) },
    heartbeatCount: { integerValue: String(session.heartbeatCount) },
    geo: { mapValue: { fields: { status: { stringValue: "unavailable" } } } },
  };
  if (session.closedAt !== undefined) fields.closedAt = timestamp(session.closedAt);
  return fields;
}

/**
 * In-memory lifecycle reducer plus a bounded, coalescing, sequential Firestore writer.
 * Public hooks never throw. HTTP/token failures are counted and reported only as aggregates after a drain.
 */
export class FirestoreRelayPresence implements RelayPresenceHooks {
  readonly #projectId: string;
  readonly #databaseId: string;
  readonly #retentionMs: number;
  readonly #maxPendingRooms: number;
  readonly #activityThrottleMs: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #onLog?: (message: string, detail?: unknown) => void;
  readonly #sessions = new Map<string, SessionState>();
  readonly #roomHashes = new Map<string, Promise<string>>();
  readonly #lastActivity = new Map<string, number>();
  readonly #pending = new Map<string, PendingWrite>();
  #draining: Promise<void> | null = null;
  #token: { value: string; refreshAt: number } | null = null;
  #failedWrites = 0;
  #droppedWrites = 0;

  constructor(config: FirestoreRelayPresenceConfig) {
    const projectId = config.projectId.trim();
    if (!projectId) throw new Error("Firestore relay presence requires a project id");
    const retentionDays = config.retentionDays ?? 30;
    const maxPendingRooms = config.maxPendingRooms ?? 128;
    const activityThrottleMs = config.activityThrottleMs ?? 30_000;
    const requestTimeoutMs = config.requestTimeoutMs ?? 5_000;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error("retentionDays must be positive");
    if (!Number.isInteger(maxPendingRooms) || maxPendingRooms <= 0) throw new Error("maxPendingRooms must be a positive integer");
    if (!Number.isFinite(activityThrottleMs) || activityThrottleMs < 0) throw new Error("activityThrottleMs must be non-negative");
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("requestTimeoutMs must be positive");
    this.#projectId = projectId;
    this.#databaseId = config.databaseId?.trim() || "(default)";
    this.#retentionMs = retentionDays * DAY_MS;
    this.#maxPendingRooms = maxPendingRooms;
    this.#activityThrottleMs = activityThrottleMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? Date.now;
    this.#onLog = config.onLog;
  }

  hostStarted(roomId: string, host: RelayPresencePrincipal): void {
    this.#soft(() => {
      const now = this.#now();
      this.#sessions.set(roomId, {
        status: "active",
        host: { ...host },
        participants: new Map(),
        createdAt: now,
        lastSeenAt: now,
        guestPeakCount: 0,
        guestJoinCount: 0,
        heartbeatCount: 0,
      });
      this.#enqueue(roomId);
    });
  }

  hostReclaimed(roomId: string, host: RelayPresencePrincipal): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      if (!session || session.status === "closed") return;
      session.host = { ...host };
      session.status = "active";
      session.lastSeenAt = this.#now();
      this.#enqueue(roomId);
    });
  }

  hostGrace(roomId: string): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      if (!session || session.status === "closed") return;
      session.status = "grace";
      session.lastSeenAt = this.#now();
      this.#enqueue(roomId);
    });
  }

  hostClosed(roomId: string): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      if (!session || session.status === "closed") return;
      const now = this.#now();
      session.status = "closed";
      session.closedAt = now;
      session.lastSeenAt = now;
      for (const participant of session.participants.values()) {
        if (participant.leftAt === undefined) {
          participant.leftAt = now;
          participant.lastSeenAt = now;
        }
      }
      this.#enqueue(roomId);
      this.#sessions.delete(roomId);
      for (const key of this.#lastActivity.keys()) {
        if (key.startsWith(`${roomId}\u0000`)) this.#lastActivity.delete(key);
      }
    });
  }

  guestJoined(roomId: string, peerId: number, guest: RelayPresencePrincipal): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      if (!session || session.status === "closed") return;
      const now = this.#now();
      session.participants.set(peerId, { ...guest, role: "guest", joinedAt: now, lastSeenAt: now });
      session.lastSeenAt = now;
      session.guestJoinCount++;
      let active = 0;
      for (const participant of session.participants.values()) if (participant.leftAt === undefined) active++;
      session.guestPeakCount = Math.max(session.guestPeakCount, active);
      this.#enqueue(roomId);
    });
  }

  guestLeft(roomId: string, peerId: number): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      const participant = session?.participants.get(peerId);
      if (!session || !participant || participant.leftAt !== undefined || session.status === "closed") return;
      const now = this.#now();
      participant.leftAt = now;
      participant.lastSeenAt = now;
      session.lastSeenAt = now;
      this.#enqueue(roomId);
    });
  }

  activity(roomId: string, role: RelayPresenceRole, peerId: number, kind: RelayPresenceActivity): void {
    this.#soft(() => {
      const session = this.#sessions.get(roomId);
      if (!session || session.status === "closed") return;
      const now = this.#now();
      const activityKey = `${roomId}\u0000${role}\u0000${peerId}\u0000${kind}`;
      const previous = this.#lastActivity.get(activityKey);
      if (previous !== undefined && now - previous < this.#activityThrottleMs) return;
      this.#lastActivity.set(activityKey, now);
      session.lastSeenAt = now;
      if (role === "guest") {
        const participant = session.participants.get(peerId);
        if (participant && participant.leftAt === undefined) participant.lastSeenAt = now;
      }
      if (kind === "heartbeat") session.heartbeatCount++;
      this.#enqueue(roomId);
    });
  }

  async flush(): Promise<void> {
    while (this.#draining || this.#pending.size > 0) {
      if (!this.#draining) this.#kickDrain();
      await this.#draining;
    }
  }

  #soft(operation: () => void): void {
    try { operation(); }
    catch { this.#failedWrites++; this.#reportAggregates(); }
  }

  #enqueue(roomId: string): void {
    const session = this.#sessions.get(roomId);
    if (!session) return;
    const pendingWrite = { fields: serializeSession(session, this.#retentionMs), terminal: session.status === "closed" };
    if (this.#pending.has(roomId)) this.#pending.delete(roomId);
    else if (this.#pending.size >= this.#maxPendingRooms) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#pending.delete(oldest);
      this.#droppedWrites++;
    }
    this.#pending.set(roomId, pendingWrite);
    this.#kickDrain();
  }

  #kickDrain(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      this.#reportAggregates();
      if (this.#pending.size > 0) this.#kickDrain();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      const next = this.#pending.entries().next().value as [string, PendingWrite] | undefined;
      if (!next) return;
      const [roomId, write] = next;
      this.#pending.delete(roomId);
      try {
        const roomHash = await this.#hash(roomId);
        const token = await this.#accessToken();
        const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.#projectId)}`
          + `/databases/${encodeURIComponent(this.#databaseId)}/documents/remote_sessions/${encodeURIComponent(roomHash)}`;
        const response = await this.#request(url, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ fields: write.fields }),
        });
        if (!response.ok) throw new Error("Firestore presence write failed");
      } catch {
        this.#failedWrites++;
      } finally {
        if (write.terminal) this.#roomHashes.delete(roomId);
      }
    }
  }

  #hash(roomId: string): Promise<string> {
    let value = this.#roomHashes.get(roomId);
    if (!value) {
      value = hashRelayRoomId(roomId);
      this.#roomHashes.set(roomId, value);
    }
    return value;
  }

  async #accessToken(): Promise<string> {
    const now = this.#now();
    if (this.#token && now < this.#token.refreshAt) return this.#token.value;
    const response = await this.#request(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok) throw new Error("metadata token request failed");
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("metadata token response invalid");
    const expiresSec = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 300;
    this.#token = { value: body.access_token, refreshAt: now + Math.max(1, expiresSec - 60) * 1000 };
    return body.access_token;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try { return await this.#fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  #reportAggregates(): void {
    if (this.#failedWrites === 0 && this.#droppedWrites === 0) return;
    const detail = { failedWrites: this.#failedWrites, droppedWrites: this.#droppedWrites };
    this.#failedWrites = 0;
    this.#droppedWrites = 0;
    try { this.#onLog?.("relay telemetry: write failures", detail); } catch { /* telemetry logging is fail-soft */ }
  }
}

export interface RelayPresenceEnvResult {
  presence: RelayPresenceHooks | null;
  summary: string;
}

/** Telemetry is off unless explicitly selected. Bad telemetry config disables only telemetry, never relay auth. */
export function relayPresenceFromEnv(
  env: Record<string, string | undefined>,
  onLog?: (message: string, detail?: unknown) => void,
): RelayPresenceEnvResult {
  const mode = env.RELAY_TELEMETRY?.trim().toLowerCase() ?? "";
  if (!mode || mode === "off") return { presence: null, summary: "relay telemetry: off" };
  if (mode !== "firestore") throw new Error("unsupported RELAY_TELEMETRY mode");
  const retention = env.RELAY_FIRESTORE_RETENTION_DAYS ? Number(env.RELAY_FIRESTORE_RETENTION_DAYS) : 30;
  const presence = new FirestoreRelayPresence({
    projectId: env.RELAY_FIRESTORE_PROJECT ?? env.RELAY_FIREBASE_PROJECT ?? "",
    databaseId: env.RELAY_FIRESTORE_DATABASE ?? "(default)",
    retentionDays: retention,
    onLog,
  });
  return { presence, summary: "relay telemetry: metadata-only Firestore presence enabled" };
}
