import Foundation

// Shared by the app and the widget extension (compiled into both).
// They exchange data only through files in the app group container - no secrets in there.

enum Shared {
    /// macOS app group, prefixed with the team ID: needs no provisioning profile as long as app
    /// and extension are signed with the same team's Developer ID. build.sh writes it into both
    /// Info.plists (key `KeepwatchAppGroup`).
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "KeepwatchAppGroup") as? String
        ?? "io.github.keepwatch.desktop"
    /// Widget click: keepwatch://open/<page>
    static let urlScheme = "keepwatch"
    static let widgetKinds = ["status", "attacks", "services", "maintenance"]

    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let url = container?.appendingPathComponent(name),
              let data = try? Data(contentsOf: url) else { return nil }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return try? d.decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ value: T, _ name: String) {
        guard let dir = container else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        guard let data = try? e.encode(value) else { return }
        try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
    }
}

/// Dashboard pages a widget click can open (hash routes of the dashboard web app).
enum DashPage: String, CaseIterable {
    case overview, security, services, backups

    var url: URL { URL(string: "\(Shared.urlScheme)://open/\(rawValue)")! }
    /// Hash in the dashboard; the overview has none. Unknown hashes fall back to the overview there.
    var hash: String { self == .overview ? "" : "#\(rawValue)" }

    static func from(_ url: URL) -> DashPage? {
        guard url.scheme == Shared.urlScheme else { return nil }
        let name = url.pathComponents.last(where: { $0 != "/" }) ?? url.host ?? ""
        return DashPage(rawValue: name) ?? (name == "open" ? .overview : nil)
    }
}

/// "Pull backup" on this Mac - written by the app, read by the "Backup & Maintenance" widget.
struct MacBackupState: Codable, Equatable {
    /// Last successful run (pulled and verified).
    var lastSuccess: Date?
    var lastSuccessSnapshots: Int?
    var lastSuccessBytes: Int64?
    /// Last run of any kind, also cancelled or failed.
    var lastRun: Date?
    var lastRunOK: Bool?
    var lastError: String?

    static let cancelled = "cancelled"
    static let file = "mac-backup.json"
    static func load() -> MacBackupState { Shared.read(MacBackupState.self, file) ?? MacBackupState() }
    func save() { Shared.write(self, Self.file) }
}

/// What only the app knows: Tailscale on this Mac and whether the app runs (the widget runs in a
/// sandbox without network and can neither ask `tailscale status` nor open a tunnel).
struct AppHint: Codable {
    var at: Date
    /// true as well when the configuration does not require Tailscale.
    var tailscaleRunning: Bool
    var serverReachable: Bool?
    /// The app was quit - without it there is no tunnel and no fresh data.
    var appQuit: Bool? = nil

    static let file = "app.json"
    static func load() -> AppHint? { Shared.read(AppHint.self, file) }
    func save() { Shared.write(self, Self.file) }
}

extension Date {
    /// "today 03:00", "yesterday 22:10", "Mon 14:02", "Oct 12, 03:00" (time in the user's format)
    func relativeDay(now: Date = Date()) -> String {
        let cal = Calendar.current
        let time = clock
        if cal.isDate(self, inSameDayAs: now) { return "today \(time)" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(self, inSameDayAs: y) { return "yesterday \(time)" }
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: self), to: cal.startOfDay(for: now)).day ?? 99
        if days < 7 && days > 0 { return "\(formatted(.dateTime.weekday(.abbreviated))) \(time)" }
        return "\(formatted(.dateTime.month(.abbreviated).day())), \(time)"
    }

    var clock: String { formatted(date: .omitted, time: .shortened) }
}
