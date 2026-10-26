import AppKit
import Foundation
import UserNotifications
import WidgetKit

/// The server from config.json (empty until the file exists).
enum Server {
    static var host: String { Config.current?.host ?? "" }
    static var target: String { Config.current?.target ?? "" }
    static var sshPort: Int { Config.current?.sshPort ?? 22 }
    static var sshPortArgs: [String] { sshPort == 22 ? [] : ["-p", "\(sshPort)"] }
    static var sshCommand: String { sshPort == 22 ? "ssh \(target)" : "ssh -p \(sshPort) \(target)" }
    static var requireTailscale: Bool { Config.current?.requireTailscale ?? true }
    /// Short name for texts: first label of a DNS name, an IP address as is.
    static var name: String {
        let h = host
        if h.isEmpty { return "server" }
        if h.contains(":") || h.allSatisfy({ $0.isNumber || $0 == "." }) { return h }
        return String(h.split(separator: ".").first ?? Substring(h))
    }
    /// Dashboard API - only through the SSH tunnel (Tunnel.swift).
    static func api(_ path: String) -> URL { Ports.url(Ports.dashboard, "/api/\(path)") }
}

// MARK: - Prozesse

struct ShellResult { var code: Int32; var out: String; var err: String }

enum Shell {
    /// Runs a program without a shell, waits at most `timeout` seconds.
    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 20) async -> ShellResult {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: path)
                p.arguments = args
                let out = Pipe(), err = Pipe()
                p.standardOutput = out
                p.standardError = err
                p.standardInput = FileHandle.nullDevice
                do { try p.run() } catch {
                    cont.resume(returning: ShellResult(code: -1, out: "", err: error.localizedDescription))
                    return
                }
                let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
                // Read first, then wait - otherwise a full pipe blocks.
                let o = out.fileHandleForReading.readDataToEndOfFile()
                let e = err.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                killer.cancel()
                cont.resume(returning: ShellResult(code: p.terminationStatus,
                                                   out: String(decoding: o, as: UTF8.self),
                                                   err: String(decoding: e, as: UTF8.self)))
            }
        }
    }
}

// MARK: - Tailscale

struct TailscaleStatus: Equatable {
    enum State: Equatable { case running, stopped, needsLogin, starting, notRunning, missing, unknown(String) }
    var state: State
    var selfName: String?
    var tailnet: String?
    var vpsOnline: Bool?
    var vpsIP: String?
}

enum Tailscale {
    static let cliCandidates = [
        "/usr/local/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/tailscale",
        "/opt/homebrew/bin/tailscale",
    ]
    static var cli: String? { cliCandidates.first { FileManager.default.isExecutableFile(atPath: $0) } }
    static var appURL: URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "io.tailscale.ipn.macsys")
            ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "io.tailscale.ipn.macos")
            ?? (FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") ? URL(fileURLWithPath: "/Applications/Tailscale.app") : nil)
    }

    static func status() async -> TailscaleStatus {
        guard let cli else {
            return TailscaleStatus(state: appURL == nil ? .missing : .notRunning)
        }
        let r = await run(cli, ["status", "--json"], timeout: 8)
        guard let data = r.out.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // "failed to connect to local Tailscale service" -> the app is not running
            return TailscaleStatus(state: appURL == nil ? .missing : .notRunning)
        }
        let backend = json["BackendState"] as? String ?? ""
        let state: TailscaleStatus.State = switch backend {
        case "Running": .running
        case "Stopped": .stopped
        case "NeedsLogin", "NeedsMachineAuth": .needsLogin
        case "Starting": .starting
        case "NoState": .notRunning
        default: .unknown(backend)
        }
        var s = TailscaleStatus(state: state)
        if let me = json["Self"] as? [String: Any] {
            s.selfName = (me["DNSName"] as? String)?.split(separator: ".").first.map(String.init)
        }
        if let t = json["CurrentTailnet"] as? [String: Any] { s.tailnet = t["MagicDNSSuffix"] as? String }
        if let peers = json["Peer"] as? [String: Any] {
            for case let p as [String: Any] in peers.values {
                let dns = (p["DNSName"] as? String) ?? ""
                let ips = (p["TailscaleIPs"] as? [String]) ?? []
                if !Server.host.isEmpty, dns.hasPrefix(Server.host) || ips.contains(Server.host) {
                    s.vpsOnline = p["Online"] as? Bool
                    s.vpsIP = (p["TailscaleIPs"] as? [String])?.first
                }
            }
        }
        return s
    }

    /// `tailscale up` without questions. If the CLI insists that all previously set
    /// options are repeated, it uses the command the CLI suggests.
    static func up() async -> Bool {
        guard let cli else { return false }
        var r = await run(cli, ["up", "--timeout=15s"], timeout: 20)
        if r.code != 0, let line = (r.err + r.out).split(separator: "\n")
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { $0.hasPrefix("tailscale up ") }) {
            let args = line.split(separator: " ").dropFirst().map(String.init)
            if args.allSatisfy({ $0.hasPrefix("--") && !$0.hasPrefix("--reset") && !$0.hasPrefix("--auth") }) {
                r = await run(cli, args + ["--timeout=15s"], timeout: 20)
            }
        }
        return r.code == 0
    }

    static func openApp() {
        guard let url = appURL else { return }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: cfg)
    }

    private static func run(_ path: String, _ args: [String], timeout: TimeInterval) async -> ShellResult {
        await Shell.run(path, args, timeout: timeout)
    }
}

// MARK: - Network (only through the tunnel on localhost)

enum Net {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        c.timeoutIntervalForResource = 12
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static func isAllowed(_ url: URL) -> Bool { Ports.isLocal(url) && Ports.remote(forLocal: url.port ?? 0) != nil }

    static func get<T: Decodable>(_ type: T.Type, _ path: String) async throws -> (T, Int) {
        let url = Server.api(path)
        guard isAllowed(url) else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "X-Dashboard")
        let t0 = Date()
        let (data, resp) = try await session.data(for: req)
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return (try JSONDecoder().decode(T.self, from: data), ms)
    }
}

// MARK: - Terminal

enum Terminal {
    static func openSSH() { if Config.current != nil { run(Server.sshCommand) } }

    /// Run a command in a new Terminal window (where you see and confirm it yourself).
    static func run(_ command: String) {
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Terminal"
            activate
            do script "\(escaped)"
        end tell
        """
        Task {
            let r = await Shell.run("/usr/bin/osascript", ["-e", script], timeout: 15)
            if r.code != 0 { await MainActor.run { openViaCommandFile(command) } }
        }
    }

    /// Fallback without the automation permission: a .command file that Terminal opens.
    @MainActor static func openViaCommandFile(_ command: String = Server.sshCommand) {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Keepwatch", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("ssh.command")
        let body = command == Server.sshCommand ? "#!/bin/sh\nclear\nexec \(command)\n" : "#!/bin/sh\nclear\n\(command)\n"
        try? body.write(to: file, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        let term = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        NSWorkspace.shared.open([file], withApplicationAt: term, configuration: NSWorkspace.OpenConfiguration())
    }
}

// MARK: - Open at login (LaunchAgent, works with ad-hoc signing too)

enum LoginItem {
    static let label = "io.github.keepwatch.desktop.login"
    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }
    static var isEnabled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }
    /// Only the installed copy registers itself - never a test run from build/.
    static var isInstalled: Bool { Bundle.main.bundlePath.hasPrefix("/Applications/") }

    static func setEnabled(_ on: Bool) {
        if on { write() } else { try? FileManager.default.removeItem(at: plistURL) }
    }

    /// After the app moved, update the LaunchAgent. Takes effect at the next login
    /// (launchd reads the file again then).
    static func refreshPathIfNeeded() {
        guard isEnabled, isInstalled,
              let dict = NSDictionary(contentsOf: plistURL) as? [String: Any],
              let args = dict["ProgramArguments"] as? [String],
              args.first != executable || dict["KeepAlive"] == nil else { return }
        write()
    }

    private static var executable: String { Bundle.main.executablePath ?? "\(Bundle.main.bundlePath)/Contents/MacOS/Keepwatch" }

    /// Starts the app at login without a window (menu bar only). launchd starts it directly
    /// (not through `open`) so KeepAlive applies: after a crash it comes back, after
    /// "Quit" (exit 0) it does not.
    private static func write() {
        let dict: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executable, "--hidden"],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 30,
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Interactive",
        ]
        try? FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        (dict as NSDictionary).write(to: plistURL, atomically: true)
    }
}

// MARK: - Notifications: server unreachable / reachable again

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    private var asked = false

    func setUp() { UNUserNotificationCenter.current().delegate = self }

    /// Only on a change: red (after 2 failures) or back to reachable.
    func postState(up: Bool, server: String, detail: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let c = UNMutableNotificationContent()
            c.title = up ? "\(server) is reachable again" : "\(server) is unreachable"
            c.body = detail
            c.sound = .default
            c.threadIdentifier = "server-state"
            // Same identifier: the new notification replaces the old one in Notification Center.
            center.add(UNNotificationRequest(identifier: "server-state", content: c, trigger: nil))
        }
    }

    /// Other notifications (e.g. "Backup pulled"); the same id replaces the old one.
    func post(id: String, title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            c.threadIdentifier = id
            center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let backup = response.notification.request.identifier == "backup"
        await MainActor.run {
            AppDelegate.shared?.showWindow(tab: .dashboard)
            if backup { Backup.shared.panelOpen = true }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions { [.banner, .sound] }
}

// MARK: - Widgets: hints for the extension, trigger reloads

@MainActor
enum WidgetBridge {
    private static var lastReload: Date?
    private static var lastHint: (Bool, Bool?)?

    /// After each check: store the Tailscale state for the widgets and reload them at most
    /// every 5 min (immediately when reachability changes). The widgets have no network (they
    /// cannot open a tunnel): the app fetches the data through its tunnel and stores it in the
    /// app group (`server-snapshot.json`), at most every 5 min.
    static func appRefreshed(tailscaleRunning: Bool, serverReachable: Bool?) {
        AppHint(at: Date(), tailscaleRunning: tailscaleRunning, serverReachable: serverReachable).save()
        let changed = lastHint.map { $0.0 != tailscaleRunning || $0.1 != serverReachable } ?? false
        lastHint = (tailscaleRunning, serverReachable)
        guard changed || lastReload.map({ Date().timeIntervalSince($0) >= 300 }) ?? true else { return }
        lastReload = Date()
        guard serverReachable == true else { return reloadNow() }
        let base = Ports.url(Ports.dashboard, "/api/").absoluteString
        Task {
            _ = await Loader.fetch(base: base)
            reloadNow()
        }
    }

    /// On quit: from now on the widgets show "App not running · as of ...".
    static func appQuits() {
        var h = AppHint.load() ?? AppHint(at: Date(), tailscaleRunning: false, serverReachable: nil)
        h.at = Date()
        h.appQuit = true
        h.save()
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func reloadNow() {
        lastReload = Date()
        WidgetCenter.shared.reloadAllTimelines()
    }
}

// MARK: - Odds and ends

enum Clip {
    static func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
}
