import Foundation

// Connection settings, read from ~/Library/Application Support/Keepwatch/config.json.
// `./keepwatch desktop` writes this file from keepwatch.conf; the Settings window can edit
// host, user and SSH port. Nothing about the server is compiled into the app.
//
//   {
//     "host": "203.0.113.10",            // IP or DNS name (with Tailscale: the MagicDNS name)
//     "user": "root",
//     "sshPort": 22,
//     "requireTailscale": true,          // false: plain SSH, no Tailscale checks at all
//     "uis": [                           // admin UIs on the server's 127.0.0.1; the first one is the dashboard
//       {"name": "Dashboard", "port": 9004},
//       {"name": "Portainer", "port": 9002},
//       {"name": "Proxy Manager", "port": 9001},
//       {"name": "My App", "port": 3000, "path": "/admin/"}
//     ],
//     "backupRepo": "/var/backups/keepwatch/restic"   // optional
//   }

struct RemoteUI: Codable, Hashable {
    var name: String
    /// Port on the server (127.0.0.1).
    var port: Int
    /// Start page, e.g. "/admin/" (default "/").
    var path: String?
}

struct AppConfig: Codable, Equatable {
    var host: String
    var user: String
    var sshPort: Int
    var requireTailscale: Bool
    var uis: [RemoteUI]
    /// restic repository on the server that "Pull backup" copies from.
    var backupRepo: String?

    static let defaultUIs = [RemoteUI(name: "Dashboard", port: 9004, path: nil)]
    static let defaultBackupRepo = "/var/backups/keepwatch/restic"

    init(host: String, user: String = "root", sshPort: Int = 22, requireTailscale: Bool = true,
         uis: [RemoteUI] = AppConfig.defaultUIs, backupRepo: String? = nil) {
        self.host = host
        self.user = user
        self.sshPort = sshPort
        self.requireTailscale = requireTailscale
        self.uis = uis
        self.backupRepo = backupRepo
    }

    /// Tolerant: every field except `host` is optional.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = try c.decode(String.self, forKey: .host).trimmingCharacters(in: .whitespaces)
        user = (try? c.decodeIfPresent(String.self, forKey: .user)).flatMap { $0 } ?? "root"
        sshPort = (try? c.decodeIfPresent(Int.self, forKey: .sshPort)).flatMap { $0 } ?? 22
        requireTailscale = (try? c.decodeIfPresent(Bool.self, forKey: .requireTailscale)).flatMap { $0 } ?? true
        uis = (try? c.decodeIfPresent([RemoteUI].self, forKey: .uis)).flatMap { $0 } ?? Self.defaultUIs
        backupRepo = (try? c.decodeIfPresent(String.self, forKey: .backupRepo)).flatMap { $0 }
        uis = uis.filter { (1...65535).contains($0.port) && !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        if uis.isEmpty { uis = Self.defaultUIs }
    }

    var target: String { "\(user)@\(host)" }

    /// Host and user end up in ssh arguments and in a Terminal command: allow only plain names.
    var problem: String? {
        if host.isEmpty { return "\"host\" is empty." }
        if host.hasPrefix("-") || host.range(of: #"^[A-Za-z0-9._:%\-]+$"#, options: .regularExpression) == nil {
            return "\"host\" must be an IP address or DNS name."
        }
        if user.hasPrefix("-") || user.range(of: #"^[A-Za-z0-9._\-]+$"#, options: .regularExpression) == nil {
            return "\"user\" must be a plain user name."
        }
        if !(1...65535).contains(sshPort) { return "\"sshPort\" must be between 1 and 65535." }
        if let r = backupRepo, r.range(of: #"^/[A-Za-z0-9._/\-]+$"#, options: .regularExpression) == nil {
            return "\"backupRepo\" must be an absolute path."
        }
        return nil
    }
}

enum Config {
    /// Read from any thread (tunnel, network); only replaced on the main thread.
    nonisolated(unsafe) static var current: AppConfig? = load()
    /// Why the file could not be used (nil = missing or fine).
    nonisolated(unsafe) static var loadError: String?

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Keepwatch", isDirectory: true)
    }
    static var file: URL { directory.appendingPathComponent("config.json") }
    static var displayPath: String { (file.path as NSString).abbreviatingWithTildeInPath }

    static var exists: Bool { FileManager.default.fileExists(atPath: file.path) }

    static func load() -> AppConfig? {
        guard let data = try? Data(contentsOf: file) else { loadError = nil; return nil }
        do {
            let c = try JSONDecoder().decode(AppConfig.self, from: data)
            if let p = c.problem { loadError = p; return nil }
            loadError = nil
            return c
        } catch {
            loadError = "\(displayPath) is not valid JSON (\(error.localizedDescription))."
            return nil
        }
    }

    /// Read the file again. true = something changed.
    @MainActor @discardableResult
    static func reload() -> Bool {
        let new = load()
        guard new != current else { return false }
        current = new
        return true
    }

    @MainActor
    static func save(_ c: AppConfig) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try e.encode(c).write(to: file, options: .atomic)
        current = c
        loadError = nil
    }
}
