// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from "bun:test";
import {
  FirestoreRelayPresence,
  hashRelayRoomId,
  relayPresenceFromEnv,
  type RelayPresencePrincipal,
} from "./relay_presence.ts";
import { startRelayServer, type RelayHandle } from "./relay_server.ts";

interface RecordedRequest { url: string; init?: RequestInit }
interface RecordedValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  timestampValue?: string;
  mapValue?: { fields: Record<string, RecordedValue> };
  arrayValue?: { values: RecordedValue[] };
}
interface RecordedBody { fields: Record<string, RecordedValue> }

function recordingTransport(requests: RecordedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith("http://metadata.google.internal/")) {
      return new Response(JSON.stringify({ access_token: "ephemeral-adc-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function firestoreBodies(requests: RecordedRequest[]): RecordedBody[] {
  return requests
    .filter((request) => request.url.startsWith("https://firestore.googleapis.com/"))
    .map((request) => JSON.parse(String(request.init?.body)) as RecordedBody);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

const host: RelayPresencePrincipal = {
  uid: "host-uid",
  email: "host@example.test",
  admin: true,
  premium: false,
  effectivePremium: true,
  userAgent: "HostAgent raw-secret-user-agent",
};
const guest: RelayPresencePrincipal = {
  uid: "guest-uid",
  email: "guest@example.test",
  admin: false,
  premium: true,
  effectivePremium: true,
  userAgent: "GuestAgent raw-secret-user-agent",
};

let relay: RelayHandle | null = null;
afterEach(() => { relay?.stop(); relay = null; });

describe("metadata-only Firestore relay presence (P-REMOTE.7)", () => {
  it("hashes a room id to the stable prefixed SHA-256 document id", async () => {
    expect(await hashRelayRoomId("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("serializes only the exact schema and records lifecycle transitions with throttled activity", async () => {
    let now = Date.parse("2026-07-17T12:00:00.000Z");
    const requests: RecordedRequest[] = [];
    const presence = new FirestoreRelayPresence({
      projectId: "test-project",
      databaseId: "presence-db",
      retentionDays: 30,
      activityThrottleMs: 30_000,
      fetchImpl: recordingTransport(requests),
      now: () => now,
    });
    const rawRoomId = "raw-room-id-must-never-leave-memory";

    presence.hostStarted(rawRoomId, host);
    await presence.flush();
    now += 1_000;
    presence.guestJoined(rawRoomId, 7, guest);
    await presence.flush();
    now += 1_000;
    presence.activity(rawRoomId, "guest", 7, "heartbeat");
    await presence.flush();
    const writesAfterHeartbeat = firestoreBodies(requests).length;
    now += 1_000;
    presence.activity(rawRoomId, "guest", 7, "heartbeat");
    await presence.flush();
    expect(firestoreBodies(requests)).toHaveLength(writesAfterHeartbeat);
    now += 1_000;
    presence.activity(rawRoomId, "guest", 7, "binary");
    await presence.flush();
    now += 1_000;
    presence.hostGrace(rawRoomId);
    await presence.flush();
    now += 1_000;
    presence.hostReclaimed(rawRoomId, host);
    await presence.flush();
    now += 1_000;
    presence.guestLeft(rawRoomId, 7);
    await presence.flush();
    now += 1_000;
    presence.hostClosed(rawRoomId);
    await presence.flush();

    const firestoreRequests = requests.filter((request) => request.url.startsWith("https://firestore.googleapis.com/"));
    const bodies = firestoreBodies(requests);
    const statuses = bodies.map((body) => body.fields.status!.stringValue);
    expect(statuses).toContain("grace");
    expect(statuses.at(-2)).toBe("active");
    expect(statuses.at(-1)).toBe("closed");

    const lastRequest = firestoreRequests.at(-1)!;
    const lastBody = bodies.at(-1)!;
    const fields = lastBody.fields;
    expect(Object.keys(lastBody)).toEqual(["fields"]);
    expect(Object.keys(fields).sort()).toEqual([
      "closedAt", "createdAt", "expireAt", "geo", "guestActiveCount", "guestJoinCount",
      "guestPeakCount", "heartbeatCount", "host", "lastSeenAt", "participants", "status",
    ]);
    expect(Object.keys(fields.host!.mapValue!.fields).sort()).toEqual([
      "admin", "effectivePremium", "email", "premium", "uid",
    ]);
    expect(Object.keys(fields.participants!.arrayValue!.values[0]!.mapValue!.fields).sort()).toEqual([
      "admin", "effectivePremium", "email", "joinedAt", "lastSeenAt", "leftAt", "premium", "role", "uid",
    ]);
    expect(fields.status!.stringValue).toBe("closed");
    expect(fields.guestActiveCount!.integerValue).toBe("0");
    expect(fields.guestPeakCount!.integerValue).toBe("1");
    expect(fields.guestJoinCount!.integerValue).toBe("1");
    expect(fields.heartbeatCount!.integerValue).toBe("1");
    expect(fields.geo).toEqual({ mapValue: { fields: { status: { stringValue: "unavailable" } } } });
    expect(Date.parse(fields.expireAt!.timestampValue!) - Date.parse(fields.closedAt!.timestampValue!))
      .toBe(30 * 24 * 60 * 60 * 1000);

    const serialized = JSON.stringify(lastBody);
    for (const rawValue of [rawRoomId, host.userAgent, guest.userAgent]) expect(serialized).not.toContain(rawValue);
    const forbiddenKeys = ["roomId", "ip", "link", "key", "writeToken", "prompt", "content", "ciphertext"];
    for (const key of collectKeys(lastBody)) expect(forbiddenKeys).not.toContain(key);
    expect(decodeURIComponent(lastRequest.url)).toContain(`/remote_sessions/${await hashRelayRoomId(rawRoomId)}`);
    expect(lastRequest.url).not.toContain(rawRoomId);
    expect(lastRequest.init?.method).toBe("PATCH");
    expect(new Headers(lastRequest.init?.headers).get("authorization")).toBe("Bearer ephemeral-adc-token");

    const metadataRequest = requests.find((request) => request.url.startsWith("http://metadata.google.internal/"))!;
    expect(new Headers(metadataRequest.init?.headers).get("Metadata-Flavor")).toBe("Google");
  });

  it("keeps telemetry off by default", () => {
    expect(relayPresenceFromEnv({})).toEqual({ presence: null, summary: "relay telemetry: off" });
  });

  it("swallows Firestore/ADC failures so authenticated admission and the socket stay open", async () => {
    const aggregates: unknown[] = [];
    const failedTransport = (async () => { throw new Error("transport unavailable"); }) as typeof fetch;
    const presence = new FirestoreRelayPresence({
      projectId: "test-project",
      requestTimeoutMs: 100,
      fetchImpl: failedTransport,
      onLog: (_message, detail) => aggregates.push(detail),
    });
    relay = startRelayServer({
      port: 0,
      auth: {
        verify: async () => ({
          ok: true,
          uid: host.uid,
          email: host.email,
          admin: host.admin,
          premium: host.premium,
        }),
      },
      presence,
    });

    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/r/fail-soft-room?role=host`);
    const authenticated = new Promise<void>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ t: "auth", token: "verified-by-test-seam" }));
      socket.onmessage = (event) => {
        if (event.data === '{"t":"auth-ok"}') resolve();
      };
      socket.onerror = () => reject(new Error("socket failed before admission"));
    });

    await authenticated;
    await presence.flush();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(aggregates).toEqual([{ failedWrites: 1, droppedWrites: 0 }]);
    const closed = new Promise<void>((resolve) => { socket.onclose = () => resolve(); });
    socket.close();
    await closed;
    await presence.flush();
    relay.stop();
    relay = null;
  });
});
