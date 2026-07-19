# KG Packs (KB Packs) - Status

_Snapshot: 2026-07-18 (evening). ADR-0205 (packs) / ADR-0206 (marketplace) / ADR-0207 (headless builder)._

**Bottom line:** the presses are RUNNING. Signing key minted, catalog drift reconciled
to 11 SKUs everywhere, and all 11 packs are building on Fable 5 (3-4 concurrent).
Remaining before Stripe live: finish builds, upload zips, sync Stripe products,
ship the trusted public key.

## Done 2026-07-18

- **Signing key minted** (first time): private `~/.omp/lucid-pack-signing.json`
  (pkcs8 b64, keyId `techlead187-kgpack-2026`, NOT in any repo; BACK IT UP), trusted
  pubkey list `~/.omp/lucid-pack-keys.json`. Signed export + verify-import proven.
- **Builds running**: `LucidAgentDesigns/KG Packs/_build-logs/run_queue.sh`,
  3 slots + a standalone SPM builder, model `anthropic/claude-fable-5`,
  ~35-45s/conversation, 365 convos/role, ~4h/pack. Logs + STATUS.txt in `_build-logs/`.
  Packs emit to each source folder as `<slug>.lkgpack(.zip)`, signed.
- **Catalog reconciled to 11 SKUs** (was 11 build / 5 storefront / 6 marketplace):
  - `senior-proposal-manager` is the FLAGSHIP, built from `DoW Business Dev/PROPOSAL MGR`
    (subscription, KGP-SPM-SUB). `capture-proposal-manager` RETIRED everywhere.
  - `program-manager-evm` licensing aligned to subscription (addon #120) in the build
    catalog + website.
  - 6 new SKUs added to app storefront (`desktop/renderer/kg_packs.ts`), addon
    `entitlements/catalog.json` + `functions/src/catalog.ts`, and website (`$149`
    one-time): dow-dod-business-development (KGP-BD-OTF), sbir-sttr-grants-pi
    (KGP-SBIR-OTF), senior-backend-engineer (KGP-BACKEND-OTF),
    senior-frontend-uiux-engineer (KGP-FRONTEND-OTF), ml-engineer (KGP-ML-OTF),
    ste-digital-engineering (KGP-STE-OTF).
  - `packs.html` regenerated (11 cards). `pricing.example.json` mirrors display prices.
  - Storage `object` paths = the ACTUAL built slug filenames (4 ids differ from their
    slug: bd, sbir, frontend, ml - upload_packs.ts matches by object basename).

## Remaining for Stripe live

| Step | How |
|---|---|
| Wait for builds (~overnight) | `_build-logs/STATUS.txt`; each pack ends `verify import: OK (signed)` |
| Stage + upload zips | copy `<slug>.lkgpack.zip` files to one dir; `bun entitlements/scripts/upload_packs.ts --src <dir>` (needs gcloud ADC) |
| Stripe sandbox sync | copy `pricing.example.json` -> `pricing.json`, confirm amounts; `stripe_setup.ts` (sandbox key) creates the 6 new products; DEACTIVATE the old capture-proposal-manager product + KGP-CAPTURE-SUB price by hand |
| Test end-to-end | sandbox purchase -> entitlement -> signed-URL download -> gated import in the app |
| Ship the trusted pubkey | customers' `~/.omp/lucid-pack-keys.json` must carry `techlead187-kgpack-2026` or signed packs REFUSE to import - distribute via managed-config or an app release before selling |
| Go live | re-run `stripe_setup.ts` with the LIVE key; deploy functions with live secrets; set webhook |
