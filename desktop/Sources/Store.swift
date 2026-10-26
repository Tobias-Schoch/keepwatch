import AppKit
import Foundation
import Observation

// MARK: - Data from the dashboard (only what the shell needs)

struct Overview: Decodable {
    var health: [Problem]?
}

struct Problem: Decodable, Hashable, Identifiable {
    var level: String
    var area: String?
    var title: String
    var detail: String?
    var id: String { "\(level)|\(area ?? "")|\(title)" }
    var isCrit: Bool { level == "crit" }

    private enum CodingKeys: String, CodingKey { case level, area, title, detail }
    /// Tolerant: a missing or renamed field must not make the whole overview unreadable.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = (try? c.decodeIfPresent(String.self, forKey: .level)).flatMap { $0 } ?? "warn"
        area = (try? c.decodeIfPresent(String.self, forKey: .area)).flatMap { $0 }
        title = (try? c.decodeIfPresent(String.self, forKey: .title)).flatMap { $0 } ?? "Problem"
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)).flatMap { $0 }
    }
}

enum Level { case ok, warn, crit }

/// Where the connection stands - from the user's point of view.
enum Phase: Equatable {
    /// No (usable) ~/Library/Application Support/Keepwatch/config.json yet.
    case noConfig
    case checking, connecting, tailscaleOff, needsLogin, missing, serverDown, ready
    /// SSH tunnel is opening / fails (key, known_hosts, ports - a problem of this Mac).
    case tunnel, tunnelFailed
}

/// Connection and state. Checks every 60 s (menu bar watcher), every 30 s while the menu is open,
/// once more after 15 s after a single failure, and every 5 s while there is no connection and
/// the window is open.
///
/// Menu bar: green = reachable, yellow = the dashboard reports a problem, red = unreachable (only
/// after 2 failures in a row), gray = Tailscale off on this Mac or tunnel fails because of this Mac
/// (no server alarm). Notifications only on the change to red and back.
@MainActor @Observable
final class Store {
    static let shared = Store()

    var phase: Phase = Config.current == nil ? .noConfig : .checking
    var tailscale: TailscaleStatus?
    var serverMs: Int?
    var health: [Problem] = []
    var loginItem = LoginItem.isEnabled

    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private var updatedAt: Date?
    @ObservationIgnored private var busy = false
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var menuOpen = false
    @ObservationIgnored private var windowVisible = false
    @ObservationIgnored private var lastAutoConnect: Date?
    /// Failures in a row fetching the dashboard (with a working tunnel path).
    @ObservationIgnored private var failures = 0
    /// Red was reported ("unreachable" notification is out); does not survive an app restart.
    @ObservationIgnored private var alarm = false

    var critCount: Int { health.filter(\.isCrit).count }
    var warnCount: Int { health.count - critCount }
    var isReady: Bool { phase == .ready }
    var usesTailscale: Bool { Server.requireTailscale }

    /// Dot in the menu bar. nil = gray (not checked, Tailscale off) - no server alarm.
    var trayLevel: Level? {
        switch phase {
        case .ready: health.isEmpty ? .ok : .warn
        case .serverDown: .crit
        default: nil
        }
    }

    /// Short, for the menu and tooltip.
    var trayText: String {
        switch phase {
        case .ready: health.isEmpty ? "Server reachable" : "Server reachable · \(serverText)"
        case .serverDown: "Server unreachable"
        case .noConfig: "Not set up yet"
        case .tailscaleOff, .needsLogin, .missing: "\(macText) - server not checked"
        case .tunnelFailed: "SSH tunnel fails - server not checked"
        case .checking, .connecting, .tunnel: "Checking ..."
        }
    }

    // Texts. Strictly separate: "This Mac" = only this computer's connection (Tailscale, tunnel),
    // "Server" = everything that comes from the server. The app shows no Mac metrics anywhere.

    static var serverName: String { Server.name }

    /// State of this Mac's connection.
    var macText: String {
        if phase == .noConfig { return "not set up" }
        if phase == .connecting { return "Tailscale connecting ..." }
        if phase == .tunnel { return "opening SSH tunnel ..." }
        if phase == .tunnelFailed { return "SSH tunnel fails" }
        guard usesTailscale else {
            return Tunnel.shared.isUp ? "SSH tunnel up" : (phase == .checking ? "checking" : "SSH tunnel down")
        }
        switch tailscale?.state {
        case .running: return Tunnel.shared.isUp ? "Tailscale + SSH tunnel up" : "Tailscale connected"
        case .stopped: return "Tailscale off"
        case .needsLogin: return "Tailscale needs a login"
        case .starting: return "Tailscale starting ..."
        case .missing: return "Tailscale missing"
        case .notRunning: return "Tailscale not running"
        case nil, .unknown: return "checking Tailscale"
        }
    }

    var macLevel: Level {
        if phase == .connecting || phase == .checking || phase == .tunnel || phase == .noConfig { return .warn }
        if phase == .tunnelFailed { return .crit }
        if !usesTailscale { return Tunnel.shared.isUp ? .ok : .crit }
        return tailscale?.state == .running ? .ok : .crit
    }

    /// Server state as the dashboard reports it. nil = unknown (no connection).
    var serverLevel: Level? {
        switch phase {
        case .ready: critCount > 0 ? .crit : (warnCount > 0 ? .warn : .ok)
        case .serverDown: .crit
        default: nil
        }
    }

    var serverText: String {
        switch phase {
        case .ready:
            if critCount > 0 { return critCount == 1 ? "1 problem" : "\(critCount) problems" }
            if warnCount > 0 { return warnCount == 1 ? "1 warning" : "\(warnCount) warnings" }
            return serverMs.map { "reachable · \($0) ms" } ?? "reachable"
        case .serverDown: return "not responding"
        case .checking, .connecting, .tunnel: return "checking"
        case .noConfig: return "not set up"
        default: return "unreachable"
        }
    }

    var headline: String {
        switch phase {
        case .noConfig: Config.loadError == nil ? "Welcome to Keepwatch" : "The configuration needs a fix"
        case .checking: "One moment ..."
        case .connecting: "Connecting to the server ..."
        case .tailscaleOff: "Tailscale is off on this Mac."
        case .needsLogin: "Tailscale wants you to log in on this Mac."
        case .missing: "Tailscale is not installed on this Mac."
        case .serverDown: "The server is not responding."
        case .tunnel: "Opening the SSH tunnel ..."
        case .tunnelFailed: tunnelHeadline
        case .ready:
            critCount > 0 ? "Server: \(critCount == 1 ? "1 problem" : "\(critCount) problems")"
                : warnCount > 0 ? "Server: \(warnCount == 1 ? "1 warning" : "\(warnCount) warnings")"
                : "Server: all good"
        }
    }

    var guidance: String {
        switch phase {
        case .noConfig:
            if let e = Config.loadError { return "\(e) Fix \(Config.displayPath) or run ./keepwatch desktop again." }
            return "This app opens your Keepwatch server's dashboard and admin UIs through an SSH tunnel. "
                + "In your keepwatch folder, run ./keepwatch desktop - it writes \(Config.displayPath) from keepwatch.conf. "
                + "The app picks it up by itself."
        case .checking: return usesTailscale ? "Checking Tailscale on this Mac, then the server." : "Checking the server."
        case .connecting: return "Turning on Tailscale on this Mac. This takes a few seconds."
        case .tailscaleOff: return "Open Tailscale in the menu bar and click \"Connect\". The dashboard loads by itself afterwards."
        case .needsLogin: return "Open Tailscale and log in with your account. The dashboard loads by itself afterwards."
        case .missing: return "Install Tailscale from the App Store or tailscale.com and log in - or set \"requireTailscale\": false in \(Config.displayPath)."
        case .serverDown:
            return usesTailscale && tailscale?.vpsOnline == false
                ? "This Mac is connected, but the server is offline in your tailnet. Check it in your provider's console."
                : "This Mac is connected, but the dashboard does not respond. Trying again."
        case .tunnel:
            return "The admin UIs are only reachable through an SSH tunnel (your key from ~/.ssh)."
        case .tunnelFailed:
            return tunnelGuidance
        case .ready:
            return "Connected through \(usesTailscale ? "Tailscale and " : "")an SSH tunnel. Everything in this window is about the server \(Store.serverName)."
        }
    }

    private var tunnelHeadline: String {
        switch Tunnel.shared.problem {
        case .noConfig: "No configuration."
        case .noKey: "No SSH key on this Mac."
        case .unknownHost: "The server is not in known_hosts."
        case .hostKeyChanged: "The server presents a different host key."
        case .denied: "The server rejects the SSH key."
        case .portsBusy: "The local tunnel ports are busy."
        case .sshMissing: "/usr/bin/ssh is missing."
        case .unreachable, nil: "The SSH tunnel is down."
        }
    }

    private var tunnelGuidance: String {
        let ssh = Server.sshCommand
        switch Tunnel.shared.problem {
        case .noConfig:
            return "Run ./keepwatch desktop."
        case .noKey:
            return "The app needs your SSH key in ~/.ssh (or in the ssh-agent) - the same one that makes \"\(ssh)\" work in Terminal. Put it back, then \"Try again\"."
        case .unknownHost:
            return "Run \"\(ssh)\" once in Terminal and confirm the server's fingerprint, then \"Try again\"."
        case .hostKeyChanged:
            return "That can be a freshly installed server - or an attack. Check in Terminal first and remove the old line from ~/.ssh/known_hosts, then \"Try again\"."
        case .denied:
            return "Check \"\(ssh)\" in Terminal. Do not keep trying: after a few rejected logins fail2ban on the server bans this Mac (by default for a week)."
        case .portsBusy:
            let first = Ports.remote.map { Ports.local($0, offset: 0) }.map(String.init).joined(separator: ", ")
            return "\(first) and the fallback ports are busy. Stop the other tunnel (lsof -iTCP -sTCP:LISTEN), then \"Try again\"."
        case .sshMissing:
            return "The tunnel needs the SSH client that comes with macOS."
        case .unreachable(let m):
            return "\(m). Trying again."
        case nil:
            return "Trying again."
        }
    }

    // MARK: Schedule

    func start() {
        Notifier.shared.setUp()
        LoginItem.refreshPathIfNeeded()
        // From the first install in /Applications: open at login (can be turned off).
        if LoginItem.isInstalled, !UserDefaults.standard.bool(forKey: "loginItemDefaulted") {
            UserDefaults.standard.set(true, forKey: "loginItemDefaulted")
            LoginItem.setEnabled(true)
            loginItem = LoginItem.isEnabled
        }
        Task { await refresh(autoConnect: true) }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                await Store.shared.refresh(autoConnect: true)
            }
        }
        reschedule()
    }

    func setMenuOpen(_ on: Bool) {
        menuOpen = on
        if on, updatedAt.map({ Date().timeIntervalSince($0) > 30 }) ?? true { Task { await refresh() } }
        reschedule()
    }

    func setWindowVisible(_ on: Bool) {
        guard on != windowVisible else { return }
        windowVisible = on
        if on, !isReady { Task { await refresh(autoConnect: true) } }
        reschedule()
    }

    private var interval: Double {
        if windowVisible && !isReady { return 5 }
        if phase == .noConfig { return 15 }   // notice the file soon after ./keepwatch desktop
        if failures == 1 { return 15 }   // a single hiccup: check again soon
        return menuOpen ? 30 : 60
    }

    private func reschedule() {
        loop?.cancel()
        let wait = interval
        loop = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
            self.reschedule()
        }
    }

    /// The configuration file changed (Settings, "Reload Configuration", or it appeared).
    func configChanged() {
        Tunnel.shared.stop()
        Ports.offset = 0
        health = []
        failures = 0
        alarm = false
        phase = Config.current == nil ? .noConfig : .checking
        Web.shared.portsChanged()
        AppDelegate.shared?.rebuildMenus()
        onChange?()
        Task { await refresh(autoConnect: true) }
    }

    // MARK: Loading

    func refresh(autoConnect: Bool = false) async {
        if busy { return }
        // Pick up a config.json that appeared or changed since the last check.
        if Config.current == nil || phase == .noConfig, Config.reload() { return configChanged() }
        guard Config.current != nil else {
            phase = .noConfig
            onChange?()
            return
        }
        busy = true
        defer {
            busy = false
            onChange?()
            WidgetBridge.appRefreshed(tailscaleRunning: !usesTailscale || tailscale?.state == .running,
                                      serverReachable: phase == .ready ? true : (phase == .serverDown ? false : nil))
        }
        let before = phase

        if usesTailscale {
            var ts = await Tailscale.status()
            tailscale = ts
            if ts.state != .running {
                let mayTry = autoConnect || lastAutoConnect.map { Date().timeIntervalSince($0) > 90 } ?? true
                if mayTry, [.stopped, .notRunning, .starting].contains(ts.state) {
                    lastAutoConnect = Date()
                    ts = await connect(openAppOnFailure: autoConnect)
                }
            }
            guard ts.state == .running else {
                // Without Tailscale the server cannot be checked: own state, no alarm.
                failures = 0
                phase = switch ts.state {
                case .needsLogin: .needsLogin
                case .missing: .missing
                default: .tailscaleOff
                }
                if phase != before { reschedule() }
                return
            }
        } else {
            tailscale = nil
        }

        let failuresBefore = failures
        // SSH tunnel: the only way to the dashboard and the other admin UIs.
        if !Tunnel.shared.isUp {
            if phase != .ready && phase != .serverDown { phase = .tunnel; onChange?() }
            let t = await Tunnel.shared.ensureUp()
            if case .failed(let p) = t, !p.retriesAutomatically {
                // A problem of this Mac (key, known_hosts, ports): no server alarm.
                failures = 0
                phase = p == .noConfig ? .noConfig : .tunnelFailed
                if phase != before { reschedule() }
                return
            }
        }
        do {
            guard Tunnel.shared.isUp else { throw URLError(.cannotConnectToHost) }
            let (ov, ms): (Overview, Int)
            do {
                (ov, ms) = try await Net.get(Overview.self, "overview")
            } catch {
                // After sleep or a network change the old connection hangs: reconnect and try once more.
                guard await Tunnel.shared.probeOrRestart() == false, Tunnel.shared.isUp else { throw error }
                (ov, ms) = try await Net.get(Overview.self, "overview")
            }
            serverMs = ms
            health = ov.health ?? []
            phase = .ready
            updatedAt = Date()
            failures = 0
            if alarm {
                alarm = false
                Notifier.shared.postState(up: true, server: Store.serverName, detail: health.isEmpty
                    ? "The dashboard responds again, all good."
                    : "The dashboard responds again and reports \(serverText).")
            }
        } catch {
            failures += 1
            // A single hiccup of a previously reachable server does not change the display.
            if failures >= 2 || before != .ready { phase = .serverDown }
            if failures >= 2 && !alarm {
                alarm = true
                Notifier.shared.postState(up: false, server: Store.serverName, detail: usesTailscale && tailscale?.vpsOnline == false
                    ? "The server is offline in your tailnet. Check it in your provider's console."
                    : Tunnel.shared.isUp
                        ? "The dashboard has not responded for 2 attempts (the SSH tunnel is up)."
                        : "The SSH tunnel to the server has failed for 2 attempts (this Mac's connection works).")
            }
        }
        if phase != before || failures != failuresBefore { reschedule() }
    }

    func connect(openAppOnFailure: Bool = true) async -> TailscaleStatus {
        phase = .connecting
        onChange?()
        var ts = tailscale ?? TailscaleStatus(state: .unknown(""))
        if ts.state == .notRunning, Tailscale.appURL != nil {
            Tailscale.openApp()   // the app usually connects by itself
            ts = await waitForRunning(seconds: 20)
            if ts.state == .running { return ts }
        }
        if ts.state == .stopped || ts.state == .starting {
            if await Tailscale.up() {
                ts = await waitForRunning(seconds: 10)
                if ts.state == .running { return ts }
            }
        }
        ts = await Tailscale.status()
        tailscale = ts
        if ts.state != .running, openAppOnFailure, ts.state != .missing { Tailscale.openApp() }
        return ts
    }

    private func waitForRunning(seconds: Int) async -> TailscaleStatus {
        var ts = await Tailscale.status()
        for _ in 0..<seconds {
            if ts.state == .running || ts.state == .needsLogin { break }
            try? await Task.sleep(for: .seconds(1))
            ts = await Tailscale.status()
        }
        tailscale = ts
        return ts
    }

    /// "Connect" / "Check again" / "Try again" buttons.
    func userConnect() {
        if phase == .noConfig {
            if Config.reload() { configChanged() }
            return
        }
        if phase == .tunnelFailed || phase == .serverDown { Tunnel.shared.retry() }
        if usesTailscale, tailscale?.state == .needsLogin { Tailscale.openApp() }
        if usesTailscale, tailscale?.state == .missing { NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!); return }
        Task { await refresh(autoConnect: true) }
    }

    func setLoginItem(_ on: Bool) {
        LoginItem.setEnabled(on)
        loginItem = LoginItem.isEnabled
        onChange?()
    }
}
