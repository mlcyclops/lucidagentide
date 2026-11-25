// API-1d 4.2: the console stages a `spokes_node` credential of a `spokes_hub` client from the service hub's pasted
// node certificate token. The token is verified against the org root (`spokes.root`) and the CRL the trust store
// holds (`identity.rs` `verify_cert`), and the credential's `node`, `serial`, `spki` and `expires` are filled from it.

use crate::api_map::{clearances_within, CEILINGS};
use crate::codec::{sha256_hex, str_of, unb64u};
use crate::connector_seal::{KEY_STORE_AZURE, KEY_STORE_OS, KEY_STORE_PKCS11, KEY_STORE_TPM};
use crate::identity::{is_service_hub, peek_compact, TrustStore};
use serde_json::{json, Value};

/// API-1d 2.2: where a service hub's node key lives (`file` is refused).
pub const KEY_STORES: [&str; 4] = [KEY_STORE_OS, KEY_STORE_PKCS11, KEY_STORE_AZURE, KEY_STORE_TPM];
/// API-1d 2.2: the hardware key stores a `cui` ceiling needs.
pub const HARDWARE_KEY_STORES: [&str; 3] = [KEY_STORE_PKCS11, KEY_STORE_AZURE, KEY_STORE_TPM];

/// API-1d 4.2: the `spokes_node` credential of a pasted service hub certificate `token` for a client with `ceiling`
/// whose node key lives in `key_store`: `{type, node, serial, spki, expires, key_store}`, `spki` the 64 hex SHA-256
/// of the certificate's SPKI DER. Refusals: `client-auth` (the certificate does not verify under `trust` at `now`,
/// CRL included), `ceiling` (the clearances exceed the ceiling, or a `cui` ceiling without a hardware key store),
/// `bad-map` (anything else: the ceiling or key store is not one of the 2.2 values, the certificate is not a service
/// hub with exactly the scopes recall and drive).
///
/// The service hub rule is the fail-closed rule of 5.2 (every `apps.` domain): the console holds no relay directory.
pub fn credential_of(token: &str, trust: &TrustStore, ceiling: &str, key_store: &str, now: i64) -> Result<Value, (&'static str, String)> {
    if !CEILINGS.contains(&ceiling) {
        return Err(("bad-map", format!("a client ceiling is one of {}", CEILINGS.join(", "))));
    }
    if !KEY_STORES.contains(&key_store) {
        return Err(("bad-map", format!("a spokes_node key_store is one of {}", KEY_STORES.join(", "))));
    }
    let ok = trust.verify_cert(Some(&Value::String(token.to_owned())), now).map_err(|r| ("client-auth", format!("the service hub certificate does not verify: {r}")))?;
    let cert = &ok.cert;
    if !is_service_hub(cert, None) {
        return Err(("bad-map", "a spokes_node credential needs a service hub certificate: role hub and a user email at an apps. domain".into()));
    }
    let has = |s: &str| cert.scopes.iter().any(|x| x == s);
    if cert.scopes.len() != 2 || !has("recall") || !has("drive") {
        return Err(("bad-map", "a service hub certificate carries exactly the scopes recall and drive (never approve)".into()));
    }
    let clearances: Vec<&str> = cert.user.as_ref().and_then(|u| u.clearances.as_ref()).into_iter().flatten().map(String::as_str).collect();
    if !clearances_within(ceiling, &clearances) {
        return Err(("ceiling", format!("the certificate's clearances ({}) exceed the client ceiling {ceiling}", clearances.join(", "))));
    }
    if ceiling == "cui" && !HARDWARE_KEY_STORES.contains(&key_store) {
        return Err(("ceiling", format!("a cui ceiling needs a hardware key store ({})", HARDWARE_KEY_STORES.join(", "))));
    }
    // verify_cert checked that this SPKI hashes to the node id; the credential pins the SHA-256 of the same bytes.
    let spki = peek_compact(token).and_then(|p| str_of(p.get("spki")).and_then(unb64u));
    let Some(spki) = spki else { return Err(("client-auth", "the service hub certificate carries no readable key".into())) };
    Ok(json!({
        "type": "spokes_node",
        "node": cert.node,
        "serial": cert.serial,
        "spki": sha256_hex(&spki),
        "expires": cert.exp,
        "key_store": key_store,
    }))
}

/// API-1d 4.2: what the console checks a pasted service hub certificate against: the Remote Spokes root (`root_pem`,
/// its `PUBLIC KEY` PEM, the console's `fleet.spokesRoot`) and the newest of `crls`, the CRL tokens the org's spokes
/// relays hold, that this root signed. Err when the root does not read or no CRL is held (fail closed: a certificate
/// is never staged unchecked against revocation).
pub fn console_trust(root_pem: &str, crls: &[String]) -> Result<TrustStore, String> {
    let der = crate::der::pem_blocks(root_pem, "PUBLIC KEY").into_iter().next().ok_or("the Remote Spokes root is not a public key PEM")?;
    let root = crate::der::p256_from_spki(&der).ok_or("the Remote Spokes root is not a P-256 key")?;
    let mut trust = TrustStore::new(root);
    for crl in crls {
        // a token another root signed, or an older one, is not taken
        let _ = trust.accept_crl(crl);
    }
    if trust.crl_token().is_none() {
        return Err("no spokes relay of this organization reported a CRL signed by the Remote Spokes root".into());
    }
    Ok(trust)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::codec::{b64u, stringify};
    use crate::der::p256_spki_der;
    use crate::identity::{node_id_of, user_id_of};
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};

    pub(crate) const NOW: i64 = 1_800_000_000;
    /// The serial of every test hub certificate.
    pub(crate) fn hub_serial() -> String {
        format!("{:032x}", 0x41)
    }

    fn compact(key: &SigningKey, payload: &Value) -> String {
        let body = stringify(payload);
        let sig: Signature = key.sign(body.as_bytes());
        format!("{}.{}", b64u(body.as_bytes()), b64u(sig.to_der().as_bytes()))
    }

    fn root() -> SigningKey {
        SigningKey::from_slice(&[7; 32]).unwrap()
    }

    /// The test root's public key as the console keeps it (`fleet.spokesRoot.pem`).
    fn root_pem() -> String {
        let b = crate::meet_json::b64(&p256_spki_der(&root().verifying_key().into()));
        let lines: Vec<&str> = b.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", lines.join("\n"))
    }

    /// A CRL of `signer` (claiming the test root) revoking `serials`, version `version`.
    fn crl(signer: &SigningKey, version: i64, serials: &[String]) -> String {
        compact(signer, &json!({ "v": 1, "typ": "lucid-crl", "root": trust().root_id, "version": version, "serials": serials, "iat": NOW - 60 }))
    }

    /// The test root with a CRL revoking `serials`.
    pub(crate) fn trust_revoking(serials: &[String]) -> TrustStore {
        let mut t = trust();
        assert_eq!(t.accept_crl(&crl(&root(), 1, serials)), Ok(true));
        t
    }

    pub(crate) fn trust() -> TrustStore {
        TrustStore::new(root().verifying_key().into())
    }

    fn hub_spki() -> Vec<u8> {
        p256_spki_der(&SigningKey::from_slice(&[9; 32]).unwrap().verifying_key().into())
    }

    /// A hub certificate the test root signs: serial 0x41, a 30 day life ending at `exp`.
    fn hub(signer: &SigningKey, email: &str, scopes: &[&str], clearances: Option<&[&str]>, exp: i64) -> String {
        let spki = hub_spki();
        let mut user = json!({ "id": user_id_of(email), "email": email });
        if let Some(c) = clearances {
            user["clearances"] = json!(c);
        }
        let p = json!({
            "v": 1, "typ": "lucid-node-cert", "serial": format!("{:032x}", 0x41), "root": node_id_of(&p256_spki_der(&root().verifying_key().into())),
            "node": node_id_of(&spki), "role": "hub", "label": "Build hub", "spki": b64u(&spki), "scopes": scopes, "iat": exp - 30 * 86_400,
            "exp": exp, "user": user,
        });
        compact(signer, &p)
    }

    /// A service hub certificate of the test root (recall and drive) valid at NOW.
    pub(crate) fn service(clearances: Option<&[&str]>) -> String {
        hub(&root(), "build@apps.acme.example", &["recall", "drive"], clearances, NOW + 86_400)
    }

    fn code(r: Result<Value, (&'static str, String)>) -> &'static str {
        r.err().map_or("ok", |(c, _)| c)
    }

    /// API-1d 4.2: the credential is filled from the verified certificate.
    #[test]
    fn api1d_a_service_hub_certificate_gives_its_credential() {
        let got = credential_of(&service(None), &trust(), "confidential", "os_store", NOW).unwrap();
        let spki = hub_spki();
        assert_eq!(
            got,
            json!({
                "type": "spokes_node", "node": node_id_of(&spki), "serial": format!("{:032x}", 0x41), "spki": sha256_hex(&spki),
                "expires": NOW + 86_400, "key_store": "os_store",
            })
        );
        assert_eq!(got["spki"].as_str().unwrap().len(), 64);
        let drive_first = hub(&root(), "build@apps.acme.example", &["drive", "recall"], None, NOW + 86_400);
        assert_eq!(code(credential_of(&drive_first, &trust(), "internal", "pkcs11", NOW)), "ok");
    }

    /// API-1d 4.2: a certificate that does not verify (another root, expired, revoked, not a token) is `client-auth`.
    #[test]
    fn api1d_a_certificate_that_does_not_verify_is_client_auth() {
        let other = SigningKey::from_slice(&[8; 32]).unwrap();
        let foreign = hub(&other, "build@apps.acme.example", &["recall", "drive"], None, NOW + 86_400);
        assert_eq!(code(credential_of(&foreign, &trust(), "confidential", "os_store", NOW)), "client-auth");
        let expired = hub(&root(), "build@apps.acme.example", &["recall", "drive"], None, NOW - 60);
        assert_eq!(code(credential_of(&expired, &trust(), "confidential", "os_store", NOW)), "client-auth");
        assert_eq!(code(credential_of("not a token", &trust(), "confidential", "os_store", NOW)), "client-auth");
        let mut revoking = trust();
        let crl = compact(&root(), &json!({ "v": 1, "typ": "lucid-crl", "root": revoking.root_id, "version": 1, "serials": [format!("{:032x}", 0x41)], "iat": NOW - 60 }));
        assert_eq!(revoking.accept_crl(&crl), Ok(true));
        assert_eq!(code(credential_of(&service(None), &revoking, "confidential", "os_store", NOW)), "client-auth");
    }

    /// API-1d 4.2: only a service hub with exactly recall and drive (never approve) is a `spokes_node`.
    #[test]
    fn api1d_only_a_service_hub_with_recall_and_drive_is_staged() {
        let t = trust();
        let human = hub(&root(), "ann@acme.example", &["recall", "drive"], None, NOW + 86_400);
        assert_eq!(code(credential_of(&human, &t, "confidential", "os_store", NOW)), "bad-map");
        let cases: [&[&str]; 5] = [&["recall", "drive", "approve"], &["recall"], &["drive"], &[], &["recall", "recall"]];
        for scopes in cases {
            let c = hub(&root(), "build@apps.acme.example", scopes, None, NOW + 86_400);
            assert_eq!(code(credential_of(&c, &t, "confidential", "os_store", NOW)), "bad-map", "{scopes:?}");
        }
        assert_eq!(code(credential_of(&service(None), &t, "confidential", "file", NOW)), "bad-map");
        assert_eq!(code(credential_of(&service(None), &t, "secret", "os_store", NOW)), "bad-map");
    }

    /// API-1d 4.2 (R6-4): clearances against the ceiling, and `cui` only with a hardware key store.
    #[test]
    fn api1d_the_ceiling_covers_the_clearances_and_cui_needs_hardware() {
        let t = trust();
        let private = service(Some(&["private"]));
        assert_eq!(code(credential_of(&private, &t, "internal", "os_store", NOW)), "ceiling");
        assert_eq!(code(credential_of(&private, &t, "confidential", "os_store", NOW)), "ok");
        let cui = service(Some(&["private", "cui"]));
        assert_eq!(code(credential_of(&cui, &t, "confidential", "pkcs11", NOW)), "ceiling");
        assert_eq!(code(credential_of(&cui, &t, "cui", "os_store", NOW)), "ceiling");
        for store in HARDWARE_KEY_STORES {
            assert_eq!(code(credential_of(&cui, &t, "cui", store, NOW)), "ok", "{store}");
        }
        assert_eq!(code(credential_of(&service(None), &t, "cui", "os_store", NOW)), "ceiling");
        assert_eq!(code(credential_of(&service(Some(&["shareable"])), &t, "public", "os_store", NOW)), "ok");
    }

    /// API-1d 4.2: the console's trust is its Remote Spokes root with the newest CRL that root signed among those the
    /// spokes relays report; none such (no CRL, or only another root's) is refused, and a revoked certificate then
    /// does not stage.
    #[test]
    fn api1d_the_console_checks_against_its_root_and_the_relays_crl() {
        assert!(console_trust(&root_pem(), &[]).err().unwrap().contains("no spokes relay"));
        let other = SigningKey::from_slice(&[8; 32]).unwrap();
        assert!(console_trust(&root_pem(), &[crl(&other, 9, &[])]).is_err(), "a CRL another key signed is not taken");
        assert!(console_trust("not a pem", &[crl(&root(), 1, &[])]).is_err());
        let older = crl(&root(), 1, &[]);
        let newer = crl(&root(), 2, &[hub_serial()]);
        let t = console_trust(&root_pem(), &[newer.clone(), older, crl(&other, 3, &[])]).unwrap();
        assert_eq!((t.root_id.as_str(), t.crl_token()), (trust().root_id.as_str(), Some(newer.as_str())));
        assert_eq!(code(credential_of(&service(None), &t, "confidential", "os_store", NOW)), "client-auth", "revoked");
    }
}
