import Foundation

// Widget data: the app fetches it through its SSH tunnel from the dashboard API (GET only),
// condenses it into a small snapshot and stores that in the app group. The extension itself has no
// network (it cannot open a tunnel) and only reads this snapshot. If it is old (app not running,
// Tailscale off, server gone), the widgets show "<reason> · as of <time>".
// This file is compiled into both the app and the extension.

enum Tone: String, Codable { case ok, warn, crit }

struct ServerSnapshot: Codable {
    struct Problem: Codable { var level: Tone; var title: String; var detail: String? }
    struct BackupInfo: Codable {
        var lastAt: Date?
        var ok: Bool?
        var running: Bool
        var targets: [String]      // targets with a snapshot from the last run
        var configured: [String]   // all configured targets
    }
    struct AttackDay: Codable { var day: String; var attempts: Int; var blocked: Int }
    struct Attacks: Codable { var today: Int; var blockedToday: Int; var days: [AttackDay] }
    struct Service: Codable { var name: String; var tone: Tone; var note: String; var problem: Bool }
    struct Updates: Codable { var images: Int; var names: [String]; var apt: Int; var aptSecurity: Int; var reboot: Bool }
    struct Certs: Codable { var minDays: Int; var domain: String }

    var fetchedAt: Date
    var problems: [Problem]
    var serviceCount: Int?
    var siteCount: Int?
    var backup: BackupInfo?
    var attacks: Attacks?
    var services: [Service]?
    var updates: Updates?
    var certs: Certs?

    static let file = "server-snapshot.json"
}

// MARK: - API responses (only the fields the widgets need)
//
// Every field is optional: if the backend renames or drops a key, that part of a widget shows
// "-" instead of the whole snapshot failing to decode.

enum API {
    struct Overview: Decodable {
        struct P: Decodable { var level: String?; var title: String?; var detail: String? }
        struct U: Decodable { var pending: Int?; var security: Int?; var rebootRequired: Bool? }
        var health: [P]?
        var updates: U?
    }
    struct Stacks: Decodable {
        struct Git: Decodable { var url: String? }
        struct S: Decodable { var name: String?; var managed: Bool?; var git: Git?; var containers: [String]? }
        var stacks: [S]?
    }
    struct Docker: Decodable {
        struct C: Decodable { var name: String?; var state: String?; var health: String?; var project: String?; var restartCount: Int? }
        var containers: [C]?
    }
    struct Sites: Decodable {
        struct Cert: Decodable { var daysLeft: Int? }
        struct S: Decodable { var id: Int?; var domains: [String]?; var target: String?; var enabled: Bool?; var cert: Cert? }
        var sites: [S]?
    }
    struct Uptime: Decodable {
        struct Day: Decodable { var day: String?; var total: Int?; var ok: Int? }
        struct S: Decodable { var domain: String?; var hostId: Int?; var down: Bool?; var uptime30: Double?; var days: [Day]? }
        var sites: [S]?
    }
    struct Updates: Decodable {
        struct Img: Decodable { var ref: String?; var name: String?; var status: String?; var containers: [String]? }
        struct ScanImg: Decodable { var containers: [String]?; var critical: Int? }
        struct Scan: Decodable { var images: [String: ScanImg]? }
        var images: [Img]?
        var scan: Scan?
    }
    struct Backups: Decodable {
        struct T: Decodable { var name: String?; var configured: Bool?; var lastSnapshot: Double? }
        struct Run: Decodable { var startedAt: Double?; var finishedAt: Double?; var ok: Bool? }
        var targets: [T]?
        var running: Bool?
        var lastRun: Run?
    }
    struct History: Decodable {
        struct D: Decodable { var day: String?; var attempts: Int?; var blocked: Int? }
        var days: [D]?
    }
}

// MARK: - Loading

struct LoadResult {
    var snapshot: ServerSnapshot?
    /// nil = fresh from the server; otherwise why the last snapshot is shown.
    var failure: String?
}

actor Loader {
    static let shared = Loader()

    /// Widget: only read the snapshot from the app group (no network).
    func load() async -> LoadResult {
        let s = Shared.read(ServerSnapshot.self, ServerSnapshot.file)
        if let s, Date().timeIntervalSince(s.fetchedAt) < 20 * 60 { return LoadResult(snapshot: s, failure: nil) }
        return LoadResult(snapshot: s, failure: Self.offlineReason())
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        c.timeoutIntervalForResource = 15
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private static func get<T: Decodable>(_ type: T.Type, _ base: String, _ path: String) async -> T? {
        guard let url = URL(string: base + path) else { return nil }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "X-Dashboard")
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// App: fetch everything (through the tunnel, `base` = http://localhost:19004/api/) and store it.
    static func fetch(base: String) async -> LoadResult {
        let previous = Shared.read(ServerSnapshot.self, ServerSnapshot.file)
        async let ov = get(API.Overview.self, base, "overview")
        async let st = get(API.Stacks.self, base, "stacks")
        async let dk = get(API.Docker.self, base, "docker")
        async let si = get(API.Sites.self, base, "sites")
        async let up = get(API.Uptime.self, base, "uptime")
        async let ud = get(API.Updates.self, base, "updates")
        async let bk = get(API.Backups.self, base, "backups")
        async let hi = get(API.History.self, base, "security/history?days=7")
        guard let overview = await ov else {
            return LoadResult(snapshot: previous, failure: offlineReason())
        }
        let (stacks, docker, sites, uptime, updates, backups, history) = await (st, dk, si, up, ud, bk, hi)

        var s = ServerSnapshot(fetchedAt: Date(), problems: [], serviceCount: previous?.serviceCount, siteCount: previous?.siteCount,
                               backup: previous?.backup, attacks: previous?.attacks, services: previous?.services,
                               updates: previous?.updates, certs: previous?.certs)
        let health = (overview.health ?? []).filter { $0.title != nil }
        s.problems = (health.filter { $0.level == "crit" } + health.filter { $0.level != "crit" })
            .map { .init(level: $0.level == "crit" ? .crit : .warn, title: $0.title ?? "", detail: $0.detail) }

        if let list = stacks?.stacks { s.serviceCount = list.filter { $0.managed ?? true }.count }
        if let list = sites?.sites { s.siteCount = list.filter { $0.enabled ?? true }.count }
        if let stacks, stacks.stacks != nil, let docker, let sites {
            s.services = services(stacks, docker, sites, uptime, updates)
        }
        if let backups, backups.targets != nil { s.backup = backupInfo(backups) }
        if let history, history.days != nil { s.attacks = attacks(history) }
        if let updates, updates.images != nil {
            let pending = (updates.images ?? []).filter { $0.status == "update" || $0.status == "major" }
            var names: [String] = []
            for i in pending { let n = i.name ?? shortImage(i.ref ?? "?"); if !names.contains(n) { names.append(n) } }
            s.updates = .init(images: pending.count, names: names, apt: overview.updates?.pending ?? 0,
                              aptSecurity: overview.updates?.security ?? 0, reboot: overview.updates?.rebootRequired ?? false)
        } else if var u = s.updates {
            u.apt = overview.updates?.pending ?? u.apt
            u.reboot = overview.updates?.rebootRequired ?? u.reboot
            s.updates = u
        }
        if let list = sites?.sites {
            let withCert = list.filter { $0.enabled ?? true }.compactMap { site in site.cert?.daysLeft.map { (site.domains?.first ?? "", $0) } }
            if let m = withCert.min(by: { $0.1 < $1.1 }) { s.certs = .init(minDays: m.1, domain: m.0) }
        }
        Shared.write(s, ServerSnapshot.file)
        return LoadResult(snapshot: s, failure: nil)
    }

    /// Why the snapshot is old - only the app knows; it stores that in the app group
    /// (every 60 s, `appQuit` on quit).
    static func offlineReason() -> String {
        guard let h = AppHint.load(), h.appQuit != true, Date().timeIntervalSince(h.at) < 10 * 60 else { return "App not running" }
        if !h.tailscaleRunning { return "Tailscale off" }
        return "unreachable"
    }

    // MARK: Condense

    /// Display name like on the dashboard's services page (Services.tsx titleOf).
    static func title(_ s: API.Stacks.S) -> String {
        if s.managed == false { return "Infrastructure" }
        let name = s.name ?? "?"
        let repo = (s.git?.url ?? "").replacingOccurrences(of: ".git", with: "").split(separator: "/").last.map(String.init) ?? ""
        if repo.rangeOfCharacter(from: .uppercaseLetters) != nil { return repo }
        return name.count <= 4 ? name.uppercased() : name
    }

    private static func services(_ stacks: API.Stacks, _ docker: API.Docker, _ sites: API.Sites,
                                 _ uptime: API.Uptime?, _ updates: API.Updates?) -> [ServerSnapshot.Service] {
        let today = localDay(Date())
        let containers = docker.containers ?? []
        let allSites = sites.sites ?? []
        var out: [ServerSnapshot.Service] = []
        for st in stacks.stacks ?? [] where st.managed ?? true {
            let names = st.containers ?? []
            let list = containers.filter { c in names.contains(c.name ?? "") || (c.project != nil && c.project == st.name) }
            let all = Set(names).union(list.compactMap(\.name))
            let missing = containers.isEmpty ? [] : names.filter { n in !list.contains { $0.name == n } }
            let mySites = allSites.filter { ($0.enabled ?? true) && all.contains(String(($0.target ?? "").split(separator: ":").first ?? "")) }
            let ups = (uptime?.sites ?? []).filter { u in
                mySites.contains { ($0.id != nil && $0.id == u.hostId) || ($0.domains ?? []).contains(u.domain ?? "") }
            }

            var crit: [String] = [], warn: [String] = []
            if !missing.isEmpty { crit.append(missing.count == 1 ? "container missing" : "\(missing.count) containers missing") }
            let stopped = list.filter { $0.state != "running" && $0.state != "restarting" }
            if !stopped.isEmpty { crit.append(stopped.count == list.count ? "stopped" : "\(stopped.count) stopped") }
            if list.contains(where: { $0.state == "running" && $0.health == "unhealthy" }) { crit.append("unhealthy") }
            if list.contains(where: { $0.state == "restarting" }) { warn.append("restarting") }
            if ups.contains(where: { $0.down == true }) { crit.append("unreachable") }

            var total = 0, ok = 0
            for u in ups { if let d = u.days?.last(where: { $0.day == today }) { total += d.total ?? 0; ok += d.ok ?? 0 } }
            let pct = total > 0 ? Double(ok) / Double(total) * 100 : nil
            if let pct, pct < 99.5, !crit.contains("unreachable") { warn.append("\(percent(pct)) up") }

            var critVulns = 0
            for img in (updates?.scan?.images ?? [:]).values where !(Set(img.containers ?? []).isDisjoint(with: all)) {
                critVulns += img.critical ?? 0
            }
            if critVulns > 0 { warn.append(critVulns == 1 ? "1 critical CVE" : "\(critVulns) critical CVEs") }

            let tone: Tone = !crit.isEmpty ? .crit : (!warn.isEmpty ? .warn : .ok)
            let issues = crit + warn
            let note: String
            if let first = issues.first {
                note = issues.count > 1 ? "\(first) +\(issues.count - 1)" : first
            } else if let pct {
                note = percent(pct)
            } else {
                note = list.isEmpty ? "-" : "running"
            }
            out.append(.init(name: title(st), tone: tone, note: note, problem: !issues.isEmpty))
        }
        let rank: (Tone) -> Int = { $0 == .crit ? 0 : $0 == .warn ? 1 : 2 }
        return out.sorted { rank($0.tone) != rank($1.tone) ? rank($0.tone) < rank($1.tone) : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private static func backupInfo(_ b: API.Backups) -> ServerSnapshot.BackupInfo {
        let configured = (b.targets ?? []).filter { $0.configured ?? true }
        var targets: [String] = []
        if let start = b.lastRun?.startedAt {
            targets = configured.filter { ($0.lastSnapshot ?? 0) >= start - 120 }.compactMap(\.name)
        }
        let at = b.lastRun?.startedAt ?? configured.compactMap(\.lastSnapshot).max()
        return .init(lastAt: at.map { Date(timeIntervalSince1970: $0) }, ok: b.lastRun?.ok, running: b.running ?? false,
                     targets: targets, configured: configured.compactMap(\.name))
    }

    private static func attacks(_ h: API.History) -> ServerSnapshot.Attacks {
        let days = (h.days ?? []).suffix(7).map { ServerSnapshot.AttackDay(day: $0.day ?? "", attempts: $0.attempts ?? 0, blocked: $0.blocked ?? 0) }
        let today = days.last
        return .init(today: today?.attempts ?? 0, blockedToday: today?.blocked ?? 0, days: Array(days))
    }

    static func shortImage(_ ref: String) -> String {
        let last = ref.split(separator: "/").last.map(String.init) ?? ref
        return String(last.split(separator: ":").first ?? Substring(last))
    }

    /// Day key as the dashboard uses it (YYYY-MM-DD in local time).
    static func localDay(_ d: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func percent(_ p: Double) -> String {
        if p >= 99.95 { return "100 %" }
        let f = NumberFormatter()
                f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        return "\(f.string(from: NSNumber(value: p)) ?? String(format: "%.1f", p)) %"
    }
}

// MARK: - Sample (widget gallery preview, placeholder)

extension ServerSnapshot {
    static var sample: ServerSnapshot {
        let now = Date()
        let cal = Calendar.current
        let three = cal.date(bySettingHour: 3, minute: 0, second: 0, of: now) ?? now
        return ServerSnapshot(
            fetchedAt: now, problems: [], serviceCount: 5, siteCount: 6,
            backup: .init(lastAt: three, ok: true, running: false, targets: ["local", "S3"], configured: ["local", "S3"]),
            attacks: .init(today: 3652, blockedToday: 3401, days: [
                .init(day: "1", attempts: 4100, blocked: 3000), .init(day: "2", attempts: 5200, blocked: 4400),
                .init(day: "3", attempts: 3900, blocked: 3500), .init(day: "4", attempts: 6100, blocked: 5900),
                .init(day: "5", attempts: 4800, blocked: 4200), .init(day: "6", attempts: 4400, blocked: 4000),
                .init(day: "7", attempts: 3652, blocked: 3401)]),
            services: [
                .init(name: "Blog", tone: .warn, note: "98.2 % up", problem: true),
                .init(name: "Gitea", tone: .ok, note: "100 %", problem: false),
                .init(name: "Nextcloud", tone: .ok, note: "100 %", problem: false),
                .init(name: "Plausible", tone: .ok, note: "100 %", problem: false),
                .init(name: "Uptime Kuma", tone: .ok, note: "100 %", problem: false)],
            updates: .init(images: 2, names: ["Proxy Manager", "postgres"], apt: 0, aptSecurity: 0, reboot: false),
            certs: .init(minDays: 32, domain: "blog.example.com"))
    }
}
