// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

// tools/macsep/lucid_sep.swift - the macOS Secure Enclave bridge for the knowledge graph's `sep` protector
// (Lucid Vault Protector Spec v1 §4.4; P-KGBIO.2, ADR-0456).
//
// A CryptoKit SecureEnclave.P256.KeyAgreement key created with access control
// `.privateKeyUsage | .biometryCurrentSet`. The private key never leaves the Secure Enclave; CryptoKit returns
// an opaque `dataRepresentation` that only THIS Mac's enclave can use, so it can be stored in the protector
// entry without any keychain entitlement (the release builds are ad-hoc signed). Every use of the key - an
// ECDH key agreement - requires a live Touch ID match with the CURRENT enrolled fingers (adding a fingerprint
// invalidates the key). There is no password fallback. The process must run in the logged-in desktop
// session (LUCID's own child process is); from a bare SSH session the prompt cannot be shown.
//
// Protocol: inputs by environment variable, one result line on stdout prefixed `LUCID_SEP::` + JSON.
//   LUCID_SEP_OP=available                      -> {ok, available}
//   LUCID_SEP_OP=create                         -> {ok, se_key, public_key}           (no prompt)
//   LUCID_SEP_OP=agree    LUCID_SEP_KEY, LUCID_SEP_PEER (x963 b64), LUCID_SEP_REASON
//                                               -> {ok, shared}                       (one biometric prompt)
// Failures: {ok:false, status, error}. status: cancelled | not-available | invalid-key | lockout | failed.

import CryptoKit
import Foundation
import LocalAuthentication

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false,\"status\":\"failed\"}".utf8)
    FileHandle.standardOutput.write(Data("LUCID_SEP::".utf8) + data + Data("\n".utf8))
}

func fail(_ status: String, _ error: String) -> Never {
    emit(["ok": false, "status": status, "error": error])
    exit(0)
}

/// Map a LocalAuthentication / CryptoKit failure onto the protocol's closed status set.
func statusOf(_ error: Error) -> String {
    if let la = error as? LAError {
        switch la.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback: return "cancelled"
        case .biometryLockout: return "lockout"
        case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet, .notInteractive: return "not-available"
        case .invalidContext: return "invalid-key"
        default: return "failed"
        }
    }
    return "failed"
}

let env = ProcessInfo.processInfo.environment
switch env["LUCID_SEP_OP"] ?? "" {
case "available":
    let ctx = LAContext()
    let bio = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    emit(["ok": true, "available": SecureEnclave.isAvailable && bio && ctx.biometryType == .touchID])

case "create":
    guard SecureEnclave.isAvailable else { fail("not-available", "this Mac has no Secure Enclave") }
    var cfErr: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &cfErr) else {
        fail("failed", "access control: \(cfErr?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        emit(["ok": true, "se_key": key.dataRepresentation.base64EncodedString(), "public_key": key.publicKey.x963Representation.base64EncodedString()])
    } catch { fail(statusOf(error), "\(error)") }

case "agree":
    guard let keyB64 = env["LUCID_SEP_KEY"], let keyData = Data(base64Encoded: keyB64),
          let peerB64 = env["LUCID_SEP_PEER"], let peerData = Data(base64Encoded: peerB64) else { fail("invalid-key", "missing key or peer") }
    let ctx = LAContext()
    ctx.localizedReason = env["LUCID_SEP_REASON"] ?? "unlock your LUCID knowledge graph"
    ctx.localizedCancelTitle = "Use passphrase"
    do {
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: keyData, authenticationContext: ctx)
        let shared = try key.sharedSecretFromKeyAgreement(with: peer)
        emit(["ok": true, "shared": shared.withUnsafeBytes { Data($0) }.base64EncodedString()])
    } catch let e as CryptoKitError {
        fail("invalid-key", "\(e)")
    } catch { fail(statusOf(error), "\(error)") }

default:
    fail("failed", "unknown LUCID_SEP_OP")
}
