# Gemini on air-gapped government networks (NIPRNet and above)

> ADR-0372 companion. Researched 2026-09-19. This document separates what is TRUE about
> Google's offering, what LUCID supports TODAY, and what is blocked upstream. No em dashes.

## 1. What Google actually ships for classified enclaves

"Gemini Enterprise" on the public internet is Vertex AI at `*.googleapis.com`. That is NOT
what a NIPRNet+ deployment uses. The government path is **Google Distributed Cloud (GDC)
air-gapped**: Google-certified hardware racked inside the customer's facility, running the
Vertex AI API surface and Gemini models fully disconnected from the internet.

Compliance facts (with sources):

- GDC and the GDC air-gapped appliance hold DoD **IL6** provisional authorizations from DISA
  (Secret) as of 2025-05-28, and Google states Vertex AI and Gemini models are available at
  IL6 and **Top Secret** levels.
  https://cloud.google.com/blog/topics/public-sector/google-distributed-cloud-gdc-gdc-air-gapped-appliance-achieve-dod-impact-level-6-il6-authorization
- **Gemini Pro and Gemini Flash are explicitly in scope** for the IL6 provisional
  authorization on GDC air-gapped.
  https://docs.cloud.google.com/docs/security/compliance/il6-gdc-compliance-scope
- The GDC air-gapped appliance also holds DoD **IL5** (covers NIPRNet-class CUI workloads).
  https://docs.cloud.google.com/distributed-cloud/hosted/docs/latest/appliance/overview
- Vertex AI generative endpoints on GDC air-gapped:
  https://docs.cloud.google.com/distributed-cloud/hosted/docs/latest/gdcag/application/ao-user/vertex-ai-overview

## 2. The endpoint model: there is a "private API router", and it is customer-local

Per Google's endpoint docs
(https://docs.cloud.google.com/distributed-cloud/gemini-on-gdcc/latest/docs/endpoints):

- The operator deploys a **Gemini endpoint inside the enclave** (`gcloud beta ai endpoints
  create --gdc-zone ...` then `deploy-model`).
- The endpoint's hostname resolves through the **zone's own DNS server** under the zone's
  private top-level domain. It is not reachable from, and does not resolve on, the internet.
- TLS is signed by the **zone's own certificate authority**. Clients must trust that CA
  (`gcloud alpha edge-cloud zones describe ... --format="value(certificateAuthorities)"`).
- Auth is a service account scoped to the enclave's Vertex AI roles, not a consumer API key.

So the client-side requirements are exactly three: reach the private hostname, trust the
private CA, present enclave credentials.

## 3. What LUCID supports today

### 3a. Private CA trust: SHIPPED (ADR-0372)

The Gemini Enterprise provider card now exposes `NODE_EXTRA_CA_CERTS` ("Private CA bundle").
Point it at the zone CA PEM. It rides the same setKey to env to omp seam as every provider
field; the omp child restarts on save and trusts the CA at boot. Proven live: a Bun TLS
server with a self-signed CA fails `error: self signed certificate` without the env and
serves cleanly with it. This env is process-wide, so it also fixes TLS for Local Providers
behind private CAs (any enclave, not just Google's).

### 3b. Enclave endpoint, working path: Local Providers

Vertex AI exposes an OpenAI-compatible chat surface (`.../endpoints/openapi` express mode;
omp itself recognizes this URL shape in `pi-catalog/src/hosts.ts`). Where the enclave
exposes an OpenAI-compatible route, wire it as a **Local Provider**: Settings, Local
providers, base URL = the enclave endpoint, credential in the vault by NAME, context window
per the deployed model. This is the identical machinery proven against the DGX Spark vLLM
head (ADR-0367) and it accepts ANY base URL today. Combined with 3a, this is the complete
NIPRNet+ story available right now.

### 3c. Native `google-vertex` provider against an enclave: BLOCKED UPSTREAM

omp 18.2.2 hardcodes the Vertex hostname. `resolveVertexEndpointHost(location)` in
`@oh-my-pi/pi-catalog/src/hosts.ts` returns only `aiplatform.googleapis.com`,
`aiplatform.{eu|us}.rep.googleapis.com`, or `{location}-aiplatform.googleapis.com`. There is
no base-URL override env anywhere in the provider (verified by reading
`pi-ai/src/providers/google-vertex.ts`: both the api-key and ADC paths interpolate that
host). LUCID will not fork omp to add one (AGENTS.md invariant 1). The upstream ask is a
`GOOGLE_VERTEX_BASE_URL` style env honored ahead of `resolveVertexEndpointHost`; once omp
ships it, exposing it is a one-line addition to the existing provider `fields` list and
needs no new LUCID machinery.

## 4. Operator quick reference (GDC air-gapped enclave)

1. Get zone CA and DNS from the IT admin (`zones describe`, section 2 above). Ensure the
   workstation resolves the zone TLD.
2. In LUCID: Gemini Enterprise card, set "Private CA bundle" to the zone CA PEM path.
3. If the enclave endpoint is OpenAI-compatible: add it as a Local Provider (base URL plus
   vault credential). Done.
4. If only the native Vertex protocol is exposed: blocked on the omp endpoint-override env
   (section 3c). Track upstream.

## 5. AskSage note

For CUI-level work WITH internet reachability, the existing AskSage gov gateway card
(ADR-0007) already routes Gemini-class models through an accredited proxy. GDC air-gapped is
for networks where even that is off the table.
