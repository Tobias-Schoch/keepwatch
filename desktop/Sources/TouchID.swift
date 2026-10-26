import CryptoKit
import Foundation
import LocalAuthentication
import WebKit

// Touch ID for dangerous actions in the dashboard (contract: dashboard/API.md, "macOS app bridge").
//
// WebAuthn does not work in a WKWebView without Associated Domains (a provisioning profile). So the
// app signs by itself: a P-256 key in the Secure Enclave that only signs after Touch ID
// (.biometryCurrentSet - enrolling new fingers invalidates it). The answers have the same shape as
// WebAuthn, and the backend verifies them like a passkey (kind = "app").
//
// Only the encrypted key blob of the Secure Enclave (dataRepresentation) is stored, in Application
// Support - no keychain item, no entitlements needed. The blob is worthless without exactly this Mac
// (and Touch ID).

/// `window.webkit.messageHandlers.keepwatchTouchID.postMessage(msg)` -> a promise with the answer
/// (also registered as `serverTouchID` for older dashboards). Answers only the dashboard in this
/// app's own SSH tunnel (http://localhost:<local port of the dashboard>, RP ID "localhost"); everyone
/// else gets an error.
@MainActor
final class TouchIDBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = TouchIDBridge()
    static let names = ["keepwatchTouchID", "serverTouchID"]

    let core = TouchIDCore(store: TouchIDCore.defaultStore)
    private var busy = false

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let dashPort = Ports.local(Ports.dashboard)
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == Ports.host, origin.port == dashPort else {
            return replyHandler(["error": "Touch ID only for the dashboard in this app (http://\(Ports.host):\(dashPort))."], nil)
        }
        guard !AppLock.shared.locked else { return replyHandler(["error": "cancelled"], nil) }
        let originString = "http://\(origin.host):\(origin.port)"
        guard let msg = message.body as? [String: Any], let op = msg["op"] as? String else {
            return replyHandler(["error": "Unreadable request."], nil)
        }
        guard !busy else { return replyHandler(["error": "Touch ID is already running."], nil) }
        let request: TouchIDCore.Request
        do {
            request = try TouchIDCore.Request(msg, origin: originString, host: origin.host)
        } catch {
            return replyHandler(["error": error.localizedDescription], nil)
        }
        busy = true
        // The Touch ID dialog belongs to the app window.
        AppDelegate.shared?.mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate()
        let core = core
        Task {
            let reply: [String: String]
            switch op {
            case "register": reply = await core.register(request)
            case "sign": reply = await core.sign(request, allow: (msg["allow"] as? [Any])?.compactMap { $0 as? String } ?? [])
            default: reply = ["error": "Unknown operation \"\(op)\"."]
            }
            busy = false
            replyHandler(reply, nil)
        }
    }
}

/// Key, clientDataJSON, authenticatorData and signature - without WebKit (testable).
struct TouchIDCore: Sendable {
    let store: URL

    static var defaultStore: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Keepwatch/touchid-key.json")
    }

    struct Request: Sendable {
        var challenge: String
        var rpId: String
        var origin: String
        var reason: String

        struct Invalid: LocalizedError {
            var errorDescription: String?
        }

        init(_ msg: [String: Any], origin: String, host: String) throws {
            guard let ch = msg["challenge"] as? String, ch.count >= 16, ch.count <= 200,
                  ch.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
                throw Invalid(errorDescription: "Challenge missing or not base64url.")
            }
            // Only sign for our own host - never for another RP ID.
            guard let rp = msg["rpId"] as? String, rp == host else {
                throw Invalid(errorDescription: "RP ID does not match this page.")
            }
            var reason = (msg["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if reason.isEmpty { reason = "confirm an action in the Keepwatch dashboard" }
            if reason.count > 140 { reason = String(reason.prefix(140)) + "…" }
            self.init(challenge: ch, rpId: rp, origin: origin, reason: reason)
        }

        init(challenge: String, rpId: String, origin: String, reason: String) {
            self.challenge = challenge
            self.rpId = rpId
            self.origin = origin
            self.reason = reason
        }
    }

    /// What is stored on disk (no plaintext secret: the blob is bound to the Secure Enclave).
    struct Stored: Codable {
        var id: String
        var rpId: String
        var key: String          // SecureEnclave.P256.Signing.PrivateKey.dataRepresentation, base64
        var created: Date
    }

    func load() -> Stored? {
        guard let data = try? Data(contentsOf: store) else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    private func save(_ s: Stored) throws {
        try FileManager.default.createDirectory(at: store.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(s)
        try data.write(to: store, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: store.path)
    }

    // MARK: register / sign

    /// `access`: differs from [.privateKeyUsage, .biometryCurrentSet] only for tests without a finger.
    func register(_ r: Request, access: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet]) async -> [String: String] {
        guard SecureEnclave.isAvailable else { return ["error": "unavailable"] }
        do {
            let ctx = try await authenticate(r.reason, biometric: access.contains(.biometryCurrentSet))
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, access, nil) else {
                return ["error": "Could not create the access control for the key."]
            }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: ac, authenticationContext: ctx)
            let id = Self.b64u(Data((0..<18).map { _ in UInt8.random(in: 0...255) }))
            var out = try assertion(key: key, type: "webauthn.create", r)
            out["id"] = id
            out["publicKey"] = Self.b64u(key.publicKey.derRepresentation)
            // Replace only after a successful signature; remove the old key on the server afterwards.
            try save(Stored(id: id, rpId: r.rpId, key: key.dataRepresentation.base64EncodedString(), created: Date()))
            return out
        } catch {
            return ["error": Self.code(error)]
        }
    }

    /// `biometric`: false only for tests without a finger (key from `register(access: [.privateKeyUsage])`).
    func sign(_ r: Request, allow: [String], biometric: Bool = true) async -> [String: String] {
        guard let s = load(), s.rpId == r.rpId, allow.contains(s.id), let blob = Data(base64Encoded: s.key) else {
            return ["error": "unknown"]
        }
        guard SecureEnclave.isAvailable else { return ["error": "unavailable"] }
        do {
            let ctx = try await authenticate(r.reason, biometric: biometric)
            let key: SecureEnclave.P256.Signing.PrivateKey
            do {
                key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            } catch {
                return ["error": "This app's key is no longer valid (e.g. fingerprints changed). Pair again under Settings > Touch ID."]
            }
            var out = try assertion(key: key, type: "webauthn.get", r)
            out["id"] = s.id
            return out
        } catch {
            return ["error": Self.code(error)]
        }
    }

    /// clientDataJSON, authenticatorData (UP + UV, counter 0) and the signature over
    /// authenticatorData || SHA-256(clientDataJSON) - exactly like a passkey.
    private func assertion(key: SecureEnclave.P256.Signing.PrivateKey, type: String, _ r: Request) throws -> [String: String] {
        let client: [String: String] = ["type": type, "challenge": r.challenge, "origin": r.origin]
        let cdj = try JSONSerialization.data(withJSONObject: client, options: [.sortedKeys, .withoutEscapingSlashes])
        var auth = Data(SHA256.hash(data: Data(r.rpId.utf8)))
        auth.append(0x05)                         // UP (0x01) | UV (0x04)
        auth.append(contentsOf: [0, 0, 0, 0])     // counter: the Secure Enclave does not count
        let signed = auth + Data(SHA256.hash(data: cdj))
        let sig = try key.signature(for: signed)  // ECDSA P-256 with SHA-256 over `signed`
        return ["clientDataJSON": Self.b64u(cdj), "authenticatorData": Self.b64u(auth), "signature": Self.b64u(sig.derRepresentation)]
    }

    /// Ask for Touch ID first: clear errors (cancelled / unavailable) and only one dialog -
    /// the Secure Enclave takes the already confirmed context.
    private func authenticate(_ reason: String, biometric: Bool) async throws -> LAContext {
        let ctx = LAContext()
        ctx.localizedReason = reason
        ctx.localizedCancelTitle = "Cancel"
        guard biometric else { return ctx }
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            throw err ?? LAError(.biometryNotAvailable)
        }
        try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        return ctx
    }

    static func code(_ error: Error) -> String {
        if let la = error as? LAError {
            switch la.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback: return "cancelled"
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet, .notInteractive: return "unavailable"
            default: return la.localizedDescription
            }
        }
        let ns = error as NSError
        if ns.domain == NSOSStatusErrorDomain, ns.code == Int(errSecUserCanceled) { return "cancelled" }
        return ns.localizedDescription
    }

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
