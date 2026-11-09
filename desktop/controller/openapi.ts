// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// desktop/controller/openapi.ts - ADR-0531: the paired controller API (ADR-0438 and later) as an OpenAPI 3.1
// document, so a client written elsewhere (a phone app, an editor panel, a Stream Deck) can be built against it.
// `GET /api/controller/schema` serves it (routes.ts) to the UI token and to any paired controller.
//
// Every field here is what `handleController` really accepts and answers. The limits come from the code that
// enforces them: the pairing store's patterns and lane grant, the remote policy's approval window, the fleet's
// lane id and status set, the scanner's trust labels, and the handler's own limits (prompt, model, default lane
// grant, restore wait), which routes.ts passes in (it owns them, and importing routes.ts from here would be a
// cycle). The drift test (openapi.test.ts) drives the handler with what this document describes and checks every
// reply against it.

import { TRUST_LABELS } from "../../harness/contracts.ts";
import { AGENT_FLAVOR, CREATOR_FLAVOR } from "../build_flavor.ts";
import { LANE_ID_RE, type LaneStatus } from "../fleet_lanes.ts";
import { TIER_ORDER } from "../managed_config.ts";
import { APP_VERSION } from "../version.ts";
import { DEFAULT_APPROVAL_HOURS, MAX_APPROVAL_HOURS, type PresenceKind } from "./remote_policy.ts";
import { PAIRING_LANES_MAX, PAIRING_NAME_RE, SPOKE_NODE_RE } from "./store.ts";

/** The handler's own limits (routes.ts owns them). */
export interface ControllerApiLimits {
  /** The longest prompt `text`, in UTF-16 code units (`String.length`). */
  maxPromptChars: number;
  /** The longest model id a spawn may name. */
  maxModelChars: number;
  /** The shape of a model id a spawn may name. */
  modelId: RegExp;
  /** The live lanes a pairing holds when the human granted none. */
  defaultMaxLanes: number;
  /** How long a request waits for the boot-time lane restore before it answers 503. */
  restoreWaitMs: number;
}

type Schema = Record<string, unknown>;

// Closed sets, written as records so the compiler refuses a missing or an extra member.
const LANE_STATUSES: Record<LaneStatus, true> = { starting: true, working: true, "needs-approval": true, "awaiting-input": true, done: true, error: true, stopped: true };
const PRESENCE_KINDS: Record<PresenceKind, true> = { "windows-hello": true, "macos-secure-enclave": true, password: true };

/** A pattern matching exactly the decimal strings `1` to `max`, plus `01` to `09` when `padded` (max below 100). */
const intRange = (max: number, padded: boolean): string => {
  const plain = Array.from({ length: max }, (_, i) => String(i + 1));
  return `^(?:${[...plain, ...(padded ? plain.filter((s) => s.length === 1).map((s) => `0${s}`) : [])].join("|")})$`;
};
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string): Schema => ({ $ref: `#/components/responses/${name}` });
const obj = (properties: Record<string, Schema>, required: string[], description?: string): Schema =>
  ({ type: "object", ...(description ? { description } : {}), properties, required, additionalProperties: false });
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
/** `{ ok: true, data }` (or `{ ok: true }` when the route answers no data). */
const okEnvelope = (data?: Schema): Schema => obj({ ok: { const: true }, ...(data ? { data } : {}) }, data ? ["ok", "data"] : ["ok"]);
const jsonResponse = (description: string, schema: Schema): Schema => ({ description, content: { "application/json": { schema } } });
const error = (description: string): Schema => jsonResponse(description, ref("Error"));
const jsonBody = (properties: Record<string, Schema>, required: string[], description: string, extra: Schema = {}): Schema =>
  ({ required: true, description, content: { "application/json": { schema: { ...obj(properties, required), ...extra } } } });
const LANE_QUERY: Schema = { name: "laneId", in: "query", required: true, description: "One of this pairing's lanes.", schema: ref("LaneId") };
const UI: Schema[] = [{ uiToken: [] }];
const CONTROLLER: Schema[] = [{ controllerToken: [] }];
/** The answers every route can give: the engine gate's bare 403, and the restore wait's 503. */
const COMMON: Record<string, Schema> = { "403": response("Forbidden"), "503": response("Restoring") };

/** The OpenAPI 3.1 document for every /api/controller/* route. */
export function controllerOpenApi(limits: ControllerApiLimits): Schema {
  const laneOps = (summary: string): string =>
    `${summary} The lane must be one this pairing spawned: another pairing's lane, the user's own lane and a missing lane are the same 404.`;
  return {
    openapi: "3.1.0",
    info: {
      title: "LUCID paired controller API",
      version: APP_VERSION,
      description: [
        "The routes a paired controller drives LUCID Fleet lanes with (ADR-0438 and later), served by the LUCID engine on loopback.",
        "Pairing is human: `pair` and `unpair` take the per-launch UI token. Pairing answers the controller token once; it opens the controller routes and nothing else, in the `x-lucid-token` header only (never a query parameter).",
        "Every request must name a loopback Host; a POST must carry `Content-Type: application/json`.",
        "A JSON body is exactly the keys listed, every value a string: an extra key, a non-string value or a missing required key is 400 `malformed request`. A GET route refuses any query parameter it does not list (400).",
        "A refused request with no pairing, or a path the token does not open, is 403 with the plain-text body `forbidden` and no detail.",
        `Every other answer is JSON: \`{ ok: true, data }\` on success, \`{ ok: false, error }\` otherwise. While the engine restores controller lanes after a restart, every route waits for the restore and answers 503 when it has not settled within ${limits.restoreWaitMs / 1000} seconds; retry shortly.`,
        "Lanes run supervised: every privileged action a lane asks for goes to the human, or, on a remote pairing, to a remote decision the engine verifies (ask, decide, deny).",
      ].join("\n\n"),
    },
    servers: [{
      url: "http://127.0.0.1:{port}",
      description: "The engine, loopback only. Its discovery record names the port it bound.",
      variables: { port: { default: String(AGENT_FLAVOR.defaultPort), description: `LucidAgentIDE binds ${AGENT_FLAVOR.defaultPort} and LUCID Creator ${CREATOR_FLAVOR.defaultPort} by default; either moves to another port when its default is busy.` } },
    }],
    tags: [
      { name: "pairing", description: "Human routes: the UI token." },
      { name: "lanes", description: "The controller's own lanes: a controller token." },
      { name: "remote approval", description: "A remote pairing's parked asks (ADR-0525): a controller token." },
      { name: "schema", description: "This document: the UI token or a controller token." },
    ],
    paths: {
      "/api/controller/pair": {
        post: {
          operationId: "pair",
          tags: ["pairing"],
          summary: "Pair a controller and mint its token (shown once).",
          description: "The workspace is fixed here: every lane the pairing spawns runs in it. `approverRoot` makes a remote pairing (ADR-0525); `approvalHours`, `offTask` and `presence` are refused without it.",
          security: UI,
          requestBody: jsonBody({
            name: ref("PairingName"),
            workspace: { type: "string", description: "An existing absolute folder; stored resolved through realpath." },
            approverRoot: { type: "string", pattern: "^[A-Za-z0-9_-]{40,400}$", description: "The owner root's P-256 public key, base64url SPKI DER. Anything else is 400." },
            approvalHours: { type: "string", pattern: intRange(MAX_APPROVAL_HOURS, false), description: `How long, in hours, a parked ask waits for a remote decision: an integer from 1 to ${MAX_APPROVAL_HOURS} as a decimal string. Absent: ${DEFAULT_APPROVAL_HOURS}.` },
            offTask: { type: "string", enum: ["on", "off"], description: "The off-task check on actions that would run on their own. Absent: on." },
            presence: { type: "string", enum: ["required", "none"], description: "ADR-0507: `required` makes every remote allow carry user-presence evidence. Absent: none." },
            maxLanes: { type: "string", pattern: intRange(PAIRING_LANES_MAX, true), description: `ADR-0509: the live lanes this pairing may hold, an integer from 1 to ${PAIRING_LANES_MAX} as a decimal string. Absent: ${limits.defaultMaxLanes}.` },
            spokeNode: { type: "string", pattern: SPOKE_NODE_RE.source, description: "ADR-0510: the paired spoke's node id. A remote decision is accepted only when the pairing names it (ADR-0513)." },
          }, ["name", "workspace"], "The pairing.", { dependentRequired: { approvalHours: ["approverRoot"], offTask: ["approverRoot"], presence: ["approverRoot"] } }),
          responses: {
            "200": jsonResponse("Paired. The token rides this reply once and nowhere else.", okEnvelope(obj({
              id: { type: "string", pattern: "^[0-9a-f]{16}$" },
              name: ref("PairingName"),
              workspace: { type: "string", description: "The resolved workspace." },
              maxLanes: { type: "integer", minimum: 1, maximum: PAIRING_LANES_MAX },
              token: { type: "string", pattern: "^lucidctl_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$", description: "The controller token. Only its argon2id hash is stored." },
            }, ["id", "name", "workspace", "maxLanes", "token"]))),
            "400": error("Malformed, or `workspace must be an existing absolute folder`."),
            "409": error("The pairing store refused it (a pairing with that name exists, or the store is unreadable)."),
            ...COMMON,
          },
        },
      },
      "/api/controller/unpair": {
        post: {
          operationId: "unpair",
          tags: ["pairing"],
          summary: "Revoke a pairing's token at once. Its lanes stay in the fleet for the human.",
          security: UI,
          requestBody: jsonBody({ name: { type: "string" } }, ["name"], "The pairing to revoke."),
          responses: {
            "200": jsonResponse("Revoked.", okEnvelope()),
            "400": response("Malformed"),
            "404": error("`unknown pairing`."),
            ...COMMON,
          },
        },
      },
      "/api/controller/schema": {
        get: {
          operationId: "schema",
          tags: ["schema"],
          summary: "This document.",
          description: "The bare OpenAPI document, not wrapped in `{ ok, data }`. Takes no query parameter.",
          security: [{ uiToken: [] }, { controllerToken: [] }],
          responses: {
            "200": jsonResponse("The OpenAPI 3.1 document.", { type: "object", required: ["openapi", "info", "paths"] }),
            "400": response("Malformed"),
            ...COMMON,
          },
        },
      },
      "/api/controller/lanes": {
        get: {
          operationId: "listLanes",
          tags: ["lanes"],
          summary: "This pairing's own lanes, and how many it may hold. Takes no query parameter.",
          security: CONTROLLER,
          responses: {
            "200": jsonResponse("The pairing's lanes that still exist in the fleet.", okEnvelope(obj({
              lanes: { type: "array", items: ref("Lane") },
              maxLanes: { type: "integer", minimum: 1, maximum: PAIRING_LANES_MAX, description: "ADR-0509: the pairing's live-lane grant." },
            }, ["lanes", "maxLanes"]))),
            "400": response("Malformed"),
            ...COMMON,
          },
        },
      },
      "/api/controller/spawn": {
        post: {
          operationId: "spawnLane",
          tags: ["lanes"],
          summary: "Start a supervised lane in the pairing's workspace.",
          description: "A remote pairing's lane in a git workspace works in its own worktree on `remote/<lane id>` (ADR-0502). `model` (ADR-0511) must be one this engine lists as available; absent, the fleet's default.",
          security: CONTROLLER,
          requestBody: jsonBody({
            name: ref("PairingName"),
            model: { type: "string", maxLength: limits.maxModelChars, pattern: limits.modelId.source, description: "`provider/model`." },
          }, [], "Both keys optional; send `{}` for neither."),
          responses: {
            "200": jsonResponse("The lane started.", okEnvelope(obj({ lane: ref("Lane") }, ["lane"]))),
            "400": error("Malformed, or `this engine has no model <id>`."),
            "429": error("The pairing already holds its lane grant of live lanes (`at most <n> lanes per pairing`)."),
            "503": error("The engine is restoring lanes, the lane store is unreadable, the review worktree could not be made, or the lane did not start."),
            "403": response("Forbidden"),
          },
        },
      },
      "/api/controller/prompt": {
        post: {
          operationId: "promptLane",
          tags: ["lanes"],
          summary: laneOps("Send one turn. The text is scanned first, fail-closed; the turn then runs detached, and `result` reads its reply."),
          security: CONTROLLER,
          requestBody: jsonBody({
            laneId: ref("LaneId"),
            text: { type: "string", minLength: 1, maxLength: limits.maxPromptChars, description: `At most ${limits.maxPromptChars} UTF-16 code units.` },
          }, ["laneId", "text"], "The turn."),
          responses: {
            "202": jsonResponse("Accepted and started.", okEnvelope(obj({ runId: { type: "string" }, verdict: ref("TrustLabel") }, ["runId", "verdict"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            "409": error("`lane is busy - one turn at a time`."),
            "422": jsonResponse("The scan refused the text (quarantined, or the scanner is unavailable).", obj({ ok: { const: false }, error: { type: "string" }, verdict: ref("TrustLabel") }, ["ok", "error", "verdict"])),
            ...COMMON,
          },
        },
      },
      "/api/controller/status": {
        get: {
          operationId: "laneStatus",
          tags: ["lanes"],
          summary: laneOps("One lane's state."),
          security: CONTROLLER,
          parameters: [LANE_QUERY],
          responses: {
            "200": jsonResponse("The lane.", okEnvelope(obj({ lane: ref("Lane"), running: { type: "boolean", description: "A turn is running." } }, ["lane", "running"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            ...COMMON,
          },
        },
      },
      "/api/controller/result": {
        get: {
          operationId: "laneResult",
          tags: ["lanes"],
          summary: laneOps("The lane's assistant replies from transcript index `since` on."),
          description: "Indices are positions in the lane's capped replay transcript; a controller that falls far behind loses the oldest turns.",
          security: CONTROLLER,
          parameters: [LANE_QUERY, { name: "since", in: "query", required: false, description: "The first transcript index to return.", schema: { type: "string", pattern: "^\\d{1,6}$", default: "0" } }],
          responses: {
            "200": jsonResponse("The replies.", okEnvelope(obj({
              turns: { type: "array", items: obj({ index: { type: "integer", minimum: 0 }, text: { type: "string" } }, ["index", "text"]) },
              running: { type: "boolean", description: "A turn is still running." },
            }, ["turns", "running"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            ...COMMON,
          },
        },
      },
      "/api/controller/cancel": {
        post: {
          operationId: "cancelTurn",
          tags: ["lanes"],
          summary: laneOps("Cancel the lane's running turn."),
          security: CONTROLLER,
          requestBody: jsonBody({ laneId: ref("LaneId") }, ["laneId"], "The lane."),
          responses: {
            "200": jsonResponse("What the fleet answered.", okEnvelope(obj({ ok: { type: "boolean" } }, ["ok"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            ...COMMON,
          },
        },
      },
      "/api/controller/close": {
        post: {
          operationId: "closeLane",
          tags: ["lanes"],
          summary: laneOps("End one of the pairing's lanes (ADR-0500): an open parked ask is denied, a running turn cancelled, the lane removed, and its slot frees."),
          description: "A remote lane's review worktree is committed onto its branch and removed; the branch is kept (ADR-0502).",
          security: CONTROLLER,
          requestBody: jsonBody({ laneId: ref("LaneId") }, ["laneId"], "The lane."),
          responses: {
            "200": jsonResponse("Closed.", okEnvelope(obj({
              closed: ref("LaneId"),
              cancelledTurn: { type: "boolean" },
              deniedAsk: { type: "string", description: "The parked ask the close denied." },
              reviewBranch: { type: "string", description: "Where a remote lane's work landed." },
              commit: { type: ["string", "null"], description: "The commit that holds what the lane left uncommitted; null when there was nothing." },
              worktreeKept: { type: "string", description: "Why the review worktree could not be removed." },
            }, ["closed", "cancelledTurn"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            ...COMMON,
          },
        },
      },
      "/api/controller/ask": {
        get: {
          operationId: "pendingAsk",
          tags: ["remote approval"],
          summary: laneOps("The lane's parked ask, or null."),
          security: CONTROLLER,
          parameters: [LANE_QUERY],
          responses: {
            "200": jsonResponse("The ask.", okEnvelope(obj({ ask: nullable(ref("RemoteAsk")) }, ["ask"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            ...COMMON,
          },
        },
      },
      "/api/controller/decide": {
        post: {
          operationId: "decideAsk",
          tags: ["remote approval"],
          summary: laneOps("Carry a remote human's signed decision on a parked ask. The engine verifies it against the pairing's approver root."),
          description: "`decision`, `cert`, `crl` and `spokeCert` are compact tokens: `<base64url(JSON payload)>.<base64url(ECDSA P-256 / SHA-256 DER signature)>`, as the remote-spoke add-on makes them.",
          security: CONTROLLER,
          requestBody: jsonBody({
            laneId: ref("LaneId"),
            askId: { type: "string", description: "The parked ask's `id`." },
            decision: { type: "string", description: "The decision, signed by the approver certificate's key." },
            cert: { type: "string", description: "The approver's node certificate." },
            crl: { type: "string", description: "The newest root-signed CRL the approver holds. One that does not verify refuses the decision; a newer one is kept." },
            spokeCert: { type: "string", description: "ADR-0510, ADR-0513: the paired spoke's own certificate, which every decision needs." },
          }, ["laneId", "askId", "decision", "cert"], "The decision."),
          responses: {
            "200": jsonResponse("Verified and applied.", okEnvelope(obj({
              allow: { type: "boolean" },
              approver: { type: "string", description: "The approver's node id." },
              presence: { ...nullable(ref("PresenceKind")), description: "ADR-0507: the presence key kind whose evidence verified, or null." },
            }, ["allow", "approver", "presence"]))),
            "400": response("Malformed"),
            "403": {
              description: "The decision did not verify (`error` names why), or the engine gate refused the request (plain-text `forbidden`).",
              content: { "application/json": { schema: ref("Error") }, "text/plain": { schema: { type: "string", const: "forbidden" } } },
            },
            "404": response("UnknownLane"),
            "409": error("`this pairing has no approver root`, `no such open ask`, or `the ask closed before the decision landed`."),
            "503": response("Restoring"),
          },
        },
      },
      "/api/controller/deny": {
        post: {
          operationId: "denyAsk",
          tags: ["remote approval"],
          summary: laneOps("Deny a parked ask. Refusing is always safe, so the controller may do it on its own."),
          security: CONTROLLER,
          requestBody: jsonBody({ laneId: ref("LaneId"), askId: { type: "string", description: "The parked ask's `id`." } }, ["laneId", "askId"], "The ask."),
          responses: {
            "200": jsonResponse("Denied.", okEnvelope(obj({ allow: { const: false } }, ["allow"]))),
            "400": response("Malformed"),
            "404": response("UnknownLane"),
            "409": error("`no such open ask`."),
            ...COMMON,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        uiToken: { type: "apiKey", in: "header", name: "x-lucid-token", description: "The engine's per-launch UI token. It reaches every route, but a controller lane route with no pairing answers 403." },
        controllerToken: { type: "apiKey", in: "header", name: "x-lucid-token", description: "The controller token `pair` answered. Header only; it opens the controller routes and nothing else." },
      },
      schemas: {
        LaneId: { type: "string", pattern: LANE_ID_RE.source, description: "A lane id as spawn mints it." },
        PairingName: { type: "string", pattern: PAIRING_NAME_RE.source },
        LaneStatus: { type: "string", enum: Object.keys(LANE_STATUSES) },
        TrustLabel: { type: "string", enum: [...TRUST_LABELS], description: "The prompt scan's verdict." },
        RiskTier: { type: "string", enum: Object.keys(TIER_ORDER) },
        PresenceKind: { type: "string", enum: Object.keys(PRESENCE_KINDS) },
        Lane: obj({
          id: ref("LaneId"),
          name: { type: "string" },
          status: ref("LaneStatus"),
          turns: { type: "integer", minimum: 0 },
          awaitingApproval: { type: "string", description: "The kind of the ask the lane waits on (never its contents)." },
          reviewBranch: { type: "string", description: "ADR-0502: the branch a remote lane's work lands on." },
          interrupted: { type: "string", format: "date-time", description: "ADR-0501: when the turn an engine restart cut off had started. It was not re-run." },
        }, ["id", "name", "status", "turns"], "What a controller may see of a lane: no cwd, no model, no ask summary."),
        RemoteAsk: obj({
          id: { type: "string" },
          digest: { type: "string", pattern: "^[0-9a-f]{64}$", description: "sha256 hex of the canonical {kind, title, input}; what a decision signs." },
          kind: { type: "string" },
          title: { type: "string" },
          input: { type: "string", description: "Canonical JSON of what will run, or \"null\"." },
          tier: ref("RiskTier"),
          reason: { type: "string" },
          openedAt: { type: "integer", description: "Milliseconds since the epoch." },
          expiresAt: { type: "integer", description: "Milliseconds since the epoch; unanswered by then, the ask is denied." },
        }, ["id", "digest", "kind", "title", "input", "tier", "reason", "openedAt", "expiresAt"], "A parked ask, bounded and canonical (ADR-0525)."),
        Error: obj({ ok: { const: false }, error: { type: "string" } }, ["ok", "error"]),
      },
      responses: {
        Malformed: error("`malformed request`."),
        UnknownLane: error("`unknown lane`: not one of this pairing's lanes."),
        Forbidden: { description: "No token, a token that does not open this route, or no pairing.", content: { "text/plain": { schema: { type: "string", const: "forbidden" } } } },
        Restoring: error("The engine is restoring controller lanes after a restart; retry shortly."),
      },
    },
  };
}
