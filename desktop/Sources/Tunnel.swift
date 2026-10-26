import Darwin
import Foundation
import Observation

// SSH tunnel to the admin UIs. On a Keepwatch server they listen on 127.0.0.1 only, so the
// only way in is SSH with your key (and, with requireTailscale, over Tailscale). The app opens
// the tunnel itself, using the keys you already have in ~/.ssh or the ssh-agent:
//
//   ssh -N -L 19004:127.0.0.1:9004 -L 19002:127.0.0.1:9002 -L 19001:127.0.0.1:9001 [-p 2222] root@<host>
//
// and loads the pages from http://localhost:<local port>.
//
// fail2ban: Keepwatch bans an address after very few failed SSH logins (by default for a week) -
// and sshd also logs "Connection closed by authenticating user ... [preauth]" when a BatchMode
// client simply has no usable key, which the aggressive sshd jail counts as well. So:
//  - the app checks locally first that a usable key (agent, or a key file without passphrase)
//    and the server's host key (known_hosts) are there - without contacting the server;
//  - after ANY failure that is not clearly a network error before authentication, it never
//    connects again by itself: not on the next check, not after sleep, not after a restart of
//    the app (the block is stored in UserDefaults). Only "Try Again" or a configuration change
//    lifts it, and each of those starts exactly one attempt.
// So without user action there is at most one failed authentication, ever.

/// Local tunnel ports. Local port = 10000 + remote port (remote ports above 54635: remote - 10000).
/// If one of them is busy (another service, a second copy of the app), all move by 100, then 200 ...
/// up to 900. Changed on the main thread only; also read by Net.get (hence not MainActor).
enum Ports {
    nonisolated(unsafe) static var offset = 0
    /// Window address - "localhost" (not 127.0.0.1): Touch ID needs a name as its RP ID.
    static let host = "localhost"

    /// Distinct remote ports of all configured UIs, dashboard first.
    static var remote: [Int] {
        var seen = Set<Int>()
        return (Config.current?.uis ?? AppConfig.defaultUIs).map(\.port).filter { seen.insert($0).inserted }
    }
    static var dashboard: Int { Config.current?.uis.first?.port ?? 9004 }

    static func base(_ remote: Int) -> Int { remote + 10900 <= 65535 ? remote + 10000 : remote - 10000 }
    static func local(_ remote: Int) -> Int { base(remote) + offset }
    static func local(_ remote: Int, offset: Int) -> Int { base(remote) + offset }

    static func url(_ remote: Int, _ path: String = "/") -> URL {
        URL(string: "http://\(host):\(local(remote))\(path.hasPrefix("/") ? path : "/" + path)")!
    }
    static func isLocal(_ url: URL) -> Bool { ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host ?? "") }
    /// Local port -> port on the server (nil = not ours).
    static func remote(forLocal port: Int) -> Int? { remote.first { local($0) == port } }
}

@MainActor @Observable
final class Tunnel {
    static let shared = Tunnel()
    /// Marker on the command line (`-o Tag=...`, only affects Match blocks): lets the app find its
    /// own orphaned ssh processes after a crash.
    static let tag = "keepwatch-desktop-tunnel"
    static let ssh = "/usr/bin/ssh"

    enum Problem: Equatable {
        case noConfig
        case sshMissing
        case noKey
        /// A key exists but ssh cannot use it non-interactively (passphrase, agent refused).
        /// Associated value: the key file name, if known.
        case keyUnavailable(String?)
        case unknownHost
        case hostKeyChanged
        case denied
        case portsBusy
        /// Network/server (before authentication) - retried automatically.
        case unreachable(String)

        var retriesAutomatically: Bool { if case .unreachable = self { true } else { false } }
    }

    enum State: Equatable { case off, connecting, up, failed(Problem) }

    var state: State = .off

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var stderrTail = ""
    @ObservationIgnored private var intent: Intent = .run
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var nextAttempt: Date?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lastRestart: Date?
    @ObservationIgnored private var timedOut = false

    private enum Intent { case run, restart, stop }

    // MARK: Authentication block (persists across launches)

    private static let blockKey = "tunnelAuthBlock"

    /// The failure that stopped automatic connecting, or nil.
    static var authBlock: Problem? {
        get {
            guard let v = UserDefaults.standard.string(forKey: blockKey) else { return nil }
            switch v {
            case "denied": return .denied
            case "hostKeyChanged": return .hostKeyChanged
            case "unknownHost": return .unknownHost
            default: return v.hasPrefix("key:") ? .keyUnavailable(v.count > 4 ? String(v.dropFirst(4)) : nil) : .denied
            }
        }
        set {
            let v: String? = switch newValue {
            case nil: nil
            case .denied: "denied"
            case .hostKeyChanged: "hostKeyChanged"
            case .unknownHost: "unknownHost"
            case .keyUnavailable(let k): "key:\(k ?? "")"
            default: "denied"
            }
            UserDefaults.standard.set(v, forKey: blockKey)
        }
    }

    /// Lift the block: the user changed the configuration (other host, user or port).
    func clearAuthBlock() { Self.authBlock = nil }

    var isUp: Bool { state == .up }
    var problem: Problem? { if case .failed(let p) = state { p } else { nil } }

    // MARK: Control

    /// Bring the tunnel up if needed and wait up to `wait` s for the result.
    /// After a rejection (key, known_hosts, ports) do nothing - only `retry()` tries again.
    @discardableResult
    func ensureUp(wait: Double = 20) async -> State {
        switch state {
        case .up:
            if process?.isRunning == true { return .up }
            state = .off
        case .failed(let p):
            if !p.retriesAutomatically && p != .noConfig { return state }
            if let n = nextAttempt, Date() < n { return state }
        case .connecting, .off:
            break
        }
        if state != .connecting { start() }
        let deadline = Date().addingTimeInterval(wait)
        while state == .connecting && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(150))
        }
        return state
    }

    /// "Try again" button: the only way out of an authentication block, and exactly one attempt.
    /// While an attempt is running it does nothing - killing ssh in the middle of the login
    /// would itself be logged as an aborted authentication.
    func retry() {
        guard state != .connecting else { return }
        attempts = 0
        nextAttempt = nil
        retryTask?.cancel()
        Self.authBlock = nil
        if process?.isRunning == true { restart() } else { state = .off; start() }
    }

    /// Reconnect (e.g. requests through the tunnel fail after sleep).
    func restart() {
        guard let p = process, p.isRunning else { state = .off; start(); return }
        intent = .restart
        p.terminate()
    }

    /// On quit or when the configuration changes: end ssh and wait briefly until it is gone.
    func stop() {
        retryTask?.cancel()
        generation += 1
        intent = .stop
        attempts = 0
        nextAttempt = nil
        guard let p = process, p.isRunning else { state = .off; return }
        p.terminate()
        for _ in 0..<20 where p.isRunning { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
        state = .off
    }

    /// Is the connection stuck? HEAD on the dashboard through the tunnel; if that fails, reconnect.
    /// true = the tunnel answers.
    func probeOrRestart() async -> Bool {
        guard state == .up else { return false }
        if await Self.probe() { return true }
        // If only the dashboard is down (ssh is fine), reconnecting does not help - at most every 2 min.
        if let t = lastRestart, Date().timeIntervalSince(t) < 120 { return false }
        lastRestart = Date()
        restart()
        let s = await ensureUp(wait: 20)
        return s == .up
    }

    nonisolated static func probe() async -> Bool {
        var req = URLRequest(url: Ports.url(Ports.dashboard, "/"))
        req.httpMethod = "HEAD"
        req.timeoutInterval = 6
        guard let (_, resp) = try? await Net.session.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: Setup

    private func start() {
        retryTask?.cancel()
        // After an authentication failure: never by itself (also after a relaunch or wake).
        if let blocked = Self.authBlock {
            process = nil
            state = .failed(blocked)
            return
        }
        generation += 1
        let gen = generation
        state = .connecting
        intent = .run
        Task { await launch(gen) }
    }

    private func launch(_ gen: Int) async {
        guard let cfg = Config.current else { return fail(.noConfig, gen) }
        guard FileManager.default.isExecutableFile(atPath: Self.ssh) else { return fail(.sshMissing, gen) }
        // 1. Check up front what would otherwise count as a failed login for fail2ban.
        let ssh = await Self.sshConfig()
        switch await Self.keyCheck(ssh) {
        case .ok: break
        case .none: return fail(.noKey, gen)
        case .locked(let name): return fail(.keyUnavailable(name), gen)
        }
        if !(await Self.knowsHost(ssh)) { return fail(.unknownHost, gen) }
        // 2. Clean up tunnels of a crashed app (their parent is launchd then).
        await Self.killOrphans()
        // 3. Free local ports: 10000 + remote first, otherwise shifted by 100, 200 ...
        let remote = Ports.remote
        guard let offset = await Task.detached(operation: { Self.freeOffset(remote) }).value else { return fail(.portsBusy, gen) }
        guard gen == generation else { return }
        if offset != Ports.offset {
            Ports.offset = offset
            Web.shared.portsChanged()
        }

        var args = ["-N", "-T",
                    "-o", "ExitOnForwardFailure=yes",
                    "-o", "ServerAliveInterval=15",
                    "-o", "ServerAliveCountMax=3",
                    "-o", "BatchMode=yes",
                    "-o", "PreferredAuthentications=publickey",
                    "-o", "IdentitiesOnly=no",
                    "-o", "ConnectTimeout=15",
                    "-o", "StrictHostKeyChecking=yes",
                    "-o", "ControlMaster=no",
                    "-o", "ControlPath=none",
                    "-o", "Tag=\(Self.tag)"]
        for r in remote { args += ["-L", "\(Ports.local(r)):127.0.0.1:\(r)"] }
        args += Server.sshPortArgs
        args += ["--", cfg.target]

        let p = Process()
        p.executableURL = URL(fileURLWithPath: Self.ssh)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        let err = Pipe()
        p.standardError = err
        stderrTail = ""
        err.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty else { h.readabilityHandler = nil; return }
            let s = String(decoding: d, as: UTF8.self)
            Task { @MainActor in
                let t = Tunnel.shared
                t.stderrTail = String((t.stderrTail + s).suffix(2000))
            }
        }
        p.terminationHandler = { proc in
            let code = proc.terminationStatus
            Task { @MainActor in
                // Wait for the rest of stderr
                try? await Task.sleep(for: .milliseconds(100))
                Tunnel.shared.exited(proc, code: code)
            }
        }
        do { try p.run() } catch { return fail(.unreachable(error.localizedDescription), gen) }
        process = p

        // 4. Ready as soon as ssh listens locally (it only does after a successful login).
        //    ConnectTimeout covers TCP and the banner; a login that hangs longer than this is
        //    usually an agent waiting for approval. Killing it is logged as an aborted login,
        //    so it counts as an authentication failure (no automatic retry).
        let port = Ports.local(Ports.dashboard)
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, p.isRunning, gen == generation {
            if await Task.detached(operation: { Self.canConnect(port) }).value {
                state = .up
                attempts = 0
                nextAttempt = nil
                Self.authBlock = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        if p.isRunning && gen == generation && state == .connecting {
            timedOut = true
            p.terminate()
        }
    }

    private func exited(_ proc: Process, code: Int32) {
        guard proc === process else { return }
        process = nil
        let wasUp = state == .up
        switch intent {
        case .stop:
            state = .off
            return
        case .restart:
            state = .off
            start()
            return
        case .run:
            break
        }
        let err = stderrTail
        var problem: Problem = timedOut ? .keyUnavailable(nil) : Self.classify(err, code: code)
        timedOut = false
        // It was up, so the login had worked: a drop without an explicit auth error is the network.
        if wasUp, !Self.isAuthError(err), !problem.retriesAutomatically, problem != .portsBusy {
            problem = .unreachable(Self.lastLine(err, code))
        }
        if wasUp, problem.retriesAutomatically {
            // It was up and dropped (sleep, network change): reconnect right away.
            state = .connecting
            retryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                self.start()
            }
            return
        }
        if problem == .portsBusy && attempts == 0 {
            // A port got taken in the meantime: one more try with a new choice.
            attempts = 1
            start()
            return
        }
        // Anything the server may have logged as a failed or aborted login: stop for good.
        if !problem.retriesAutomatically && problem != .portsBusy { Self.authBlock = problem }
        fail(problem, generation)
    }

    private func fail(_ p: Problem, _ gen: Int) {
        guard gen == generation else { return }
        state = .failed(p)
        guard p.retriesAutomatically else { return }
        attempts += 1
        let wait = [3.0, 5, 10, 20, 30, 60][min(attempts - 1, 5)]
        nextAttempt = Date().addingTimeInterval(wait)
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self, case .failed = self.state else { return }
            // Without Tailscale (when required) stop trying - Store kicks it again once it runs.
            if Config.current?.requireTailscale ?? true, Store.shared.tailscale?.state != .running { return }
            self.start()
        }
    }

    // MARK: Classify errors

    nonisolated static let authPatterns = [
        "permission denied", "too many authentication failures", "no more authentication methods",
        "authentication failed", "no such identity", "enter passphrase", "incorrect passphrase",
        "agent refused", "agent admitted failure", "sign_and_send_pubkey", "communication with agent failed",
        "could not open a connection to your authentication agent",
    ]
    nonisolated static let keyPatterns = [
        "no such identity", "enter passphrase", "incorrect passphrase", "agent refused", "agent admitted failure",
        "sign_and_send_pubkey", "communication with agent failed", "could not open a connection to your authentication agent",
    ]
    /// Errors that happen before authentication (or after the tunnel was up) - safe to retry.
    nonisolated static let networkPatterns = [
        "could not resolve hostname", "nodename nor servname", "name or service not known",
        "temporary failure in name resolution", "connection refused", "connection timed out",
        "operation timed out", "network is unreachable", "no route to host", "host is down",
        "kex_exchange_identification", "connection reset", "closed by remote host", "broken pipe",
        "server not responding", "software caused connection abort", "can't assign requested address",
    ]

    nonisolated static func isAuthError(_ err: String) -> Bool {
        let e = err.lowercased()
        return authPatterns.contains { e.contains($0) }
    }

    nonisolated static func lastLine(_ err: String, _ code: Int32) -> String {
        let line = err.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .last(where: { !$0.isEmpty && !$0.hasPrefix("Warning:") }) ?? "ssh exited (code \(code))"
        return String(line.prefix(160))
    }

    /// Conservative: only a clearly recognized network error before authentication is retried.
    /// Everything else - explicit auth errors and any unexplained exit 255 - counts as a failed
    /// login and needs the user.
    nonisolated static func classify(_ err: String, code: Int32) -> Problem {
        let e = err.lowercased()
        if e.contains("remote host identification has changed") || e.contains("host key for") && e.contains("has changed") {
            return .hostKeyChanged
        }
        if e.contains("host key verification failed") || e.contains("no ") && e.contains("host key is known") { return .unknownHost }
        if isAuthError(err) {
            return keyPatterns.contains { e.contains($0) } ? .keyUnavailable(nil) : .denied
        }
        if e.contains("address already in use") || e.contains("cannot listen to port") || e.contains("could not request local forwarding") {
            return .portsBusy
        }
        if networkPatterns.contains(where: { e.contains($0) }) { return .unreachable(lastLine(err, code)) }
        return .denied
    }

    // MARK: Local pre-checks (without asking the server)

    struct SSHConfig {
        var identityFiles: [String]
        var knownHosts: [String]
        var identityAgent: String?
        /// Names under which the host key may be stored in known_hosts.
        var hostKeyNames: [String]
    }

    nonisolated static func sshConfig() async -> SSHConfig {
        let host = Config.current?.host ?? ""
        let r = await Shell.run(ssh, ["-G"] + Server.sshPortArgs + ["--", Config.current?.target ?? host], timeout: 8)
        var ids: [String] = [], known: [String] = [], agent: String?
        var hostname = host, port = Config.current?.sshPort ?? 22, alias: String?
        let home = NSHomeDirectory()
        func expand(_ s: String) -> String {
            s.hasPrefix("~/") ? home + s.dropFirst(1) : s.replacingOccurrences(of: "%d", with: home)
        }
        for line in r.out.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            switch parts[0] {
            case "identityfile": ids.append(expand(parts[1]))
            case "userknownhostsfile", "globalknownhostsfile":
                known += parts[1].split(separator: " ").map { expand(String($0)) }
            case "identityagent": agent = parts[1]
            case "hostname": hostname = parts[1]
            case "port": port = Int(parts[1]) ?? port
            case "hostkeyalias": alias = parts[1]
            default: break
            }
        }
        if known.isEmpty { known = [home + "/.ssh/known_hosts"] }
        // known_hosts stores non-standard ports as "[host]:port".
        let names = [alias, hostname, host].compactMap { $0 }.filter { !$0.isEmpty }
            .map { port == 22 ? $0 : "[\($0)]:\(port)" }
        return SSHConfig(identityFiles: ids, knownHosts: known, identityAgent: agent, hostKeyNames: Array(Set(names)))
    }

    enum KeyCheck { case ok, none, locked(String) }

    /// Is there a key ssh can use without asking? The agent (incl. keys added with
    /// `ssh-add --apple-use-keychain`), or a key file without passphrase. A key file with a passphrase
    /// that is not in the agent would make BatchMode ssh give up mid-login - which sshd logs and
    /// fail2ban counts - so that is caught here, without contacting the server.
    nonisolated static func keyCheck(_ c: SSHConfig) async -> KeyCheck {
        // A custom agent via IdentityAgent (e.g. 1Password) cannot be checked here.
        if let a = c.identityAgent, a != "none", a != "SSH_AUTH_SOCK" { return .ok }
        if c.identityAgent != "none", await Shell.run("/usr/bin/ssh-add", ["-l"], timeout: 5).code == 0 { return .ok }
        let files = c.identityFiles.filter { FileManager.default.isReadableFile(atPath: $0) }
        guard let first = files.first else { return .none }
        for f in files {
            if await Shell.run("/usr/bin/ssh-keygen", ["-y", "-P", "", "-f", f], timeout: 5).code == 0 { return .ok }
        }
        return .locked((first as NSString).lastPathComponent)
    }

    nonisolated static func knowsHost(_ c: SSHConfig) async -> Bool {
        for f in c.knownHosts where FileManager.default.fileExists(atPath: f) {
            for name in c.hostKeyNames {
                if await Shell.run("/usr/bin/ssh-keygen", ["-F", name, "-f", f], timeout: 5).code == 0 { return true }
            }
        }
        return false
    }

    /// Our own ssh processes whose app is gone (parent is launchd).
    nonisolated static func killOrphans() async {
        let r = await Shell.run("/usr/bin/pgrep", ["-f", "Tag=\(tag)"], timeout: 5)
        for pid in r.out.split(separator: "\n").compactMap({ Int32($0.trimmingCharacters(in: .whitespaces)) }) {
            let pp = await Shell.run("/bin/ps", ["-o", "ppid=", "-p", "\(pid)"], timeout: 5)
            if Int32(pp.out.trimmingCharacters(in: .whitespacesAndNewlines)) == 1 {
                kill(pid, SIGTERM)
                usleep(300_000)
            }
        }
    }

    // MARK: Ports

    /// First offset (0, 100 ... 900) at which every local port is distinct, valid and free.
    nonisolated static func freeOffset(_ remote: [Int]) -> Int? {
        for offset in stride(from: 0, through: 900, by: 100) {
            let locals = remote.map { Ports.local($0, offset: offset) }
            guard Set(locals).count == locals.count, locals.allSatisfy({ $0 <= 65535 }) else { continue }
            if locals.allSatisfy(isFree) { return offset }
        }
        return nil
    }

    /// Free = nobody accepts connections there and the port can be bound on 127.0.0.1 and ::1.
    nonisolated static func isFree(_ port: Int) -> Bool {
        !canConnect(port) && canBind(port, v6: false) && canBind(port, v6: true)
    }

    nonisolated static func canConnect(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var a = sockaddr_in()
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = in_port_t(UInt16(port).bigEndian)
        a.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &a) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0
    }

    nonisolated static func canBind(_ port: Int, v6: Bool) -> Bool {
        let fd = socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return !v6 ? false : true }   // without IPv6 only IPv4 counts
        defer { close(fd) }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))   // like ssh itself
        if v6 {
            var a = sockaddr_in6()
            a.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            a.sin6_family = sa_family_t(AF_INET6)
            a.sin6_port = in_port_t(UInt16(port).bigEndian)
            a.sin6_addr = in6addr_loopback
            let r = withUnsafePointer(to: &a) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) }
            }
            return r == 0 || errno == EADDRNOTAVAIL
        }
        var a = sockaddr_in()
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = in_port_t(UInt16(port).bigEndian)
        a.sin_addr.s_addr = inet_addr("127.0.0.1")
        return withUnsafePointer(to: &a) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0
    }
}
