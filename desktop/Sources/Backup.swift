import AppKit
import Foundation
import Observation

/// "Pull backup": runs the bundled `backup-pull.sh` (Resources, = lib/backup-pull.sh) and shows
/// what it does. Runs **only on request** - never by itself, never on a schedule.
///
/// The script runs in its own process group. Cancel sends SIGINT to the whole group: restic then
/// removes its lock on the server by itself.
@MainActor @Observable
final class Backup {
    static let shared = Backup()

    enum Phase: Equatable {
        case idle
        case running
        case done(Summary)
        case failed(String)
        case cancelled
    }

    struct Summary: Equatable {
        var snapshots: Int
        var new: Int
        var bytes: Int64
        var thorough: Bool
        var newest: Date?
    }

    /// A missing requirement, with instructions.
    struct Missing: Identifiable, Equatable {
        enum Kind { case config, restic, jq, keychain, tailscale, folder }
        var kind: Kind
        var title: String
        var detail: String
        var command: String?
        var id: String { title }
    }

    static let defaultFolder = "~/Keepwatch Backups"
    static let keychainEntry = ProcessInfo.processInfo.environment["KW_BACKUP_KEYCHAIN"] ?? "Keepwatch backup"
    /// For testing only: another source repository (e.g. a local one). Tailscale does not matter then.
    static let sourceOverride = ProcessInfo.processInfo.environment["KW_BACKUP_SOURCE"]
    /// The password comes from a command instead of the keychain (inherited environment only).
    static let passwordCommand = ProcessInfo.processInfo.environment["KW_BACKUP_PASSWORD_COMMAND"]

    var phase: Phase = .idle
    var step = ""
    var fraction: Double?
    var missing: [Missing] = []
    var checked = false
    var log: [String] = []
    var mac = MacBackupState.load()
    var panelOpen = false
    var thorough = UserDefaults.standard.bool(forKey: "backupThorough") {
        didSet { UserDefaults.standard.set(thorough, forKey: "backupThorough") }
    }
    var folder: String = UserDefaults.standard.string(forKey: "backupFolder") ?? Backup.defaultFolder {
        didSet { UserDefaults.standard.set(folder, forKey: "backupFolder") }
    }

    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private var pid: pid_t = 0
    @ObservationIgnored private var userCancelled = false
    @ObservationIgnored private var toFetch = 0
    @ObservationIgnored private var saved = 0
    @ObservationIgnored private var begun = 0
    @ObservationIgnored private var packs: Double = 0
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var lastError: String?
    @ObservationIgnored private var summary: Summary?
    @ObservationIgnored private var buffer = Data()

    var isRunning: Bool { phase == .running }
    var folderURL: URL { URL(fileURLWithPath: (folder as NSString).expandingTildeInPath) }
    var folderDisplay: String { (folderURL.path as NSString).abbreviatingWithTildeInPath }

    /// Pulled successfully today?
    var doneToday: Bool { mac.lastSuccess.map { Calendar.current.isDateInToday($0) } ?? false }

    /// One line for the menu and the bar.
    var lastText: String {
        guard let t = mac.lastSuccess else { return "never pulled to this Mac" }
        return "last \(t.relativeDay())"
    }

    /// Short, for the bar while running.
    var shortStep: String {
        if toFetch > 0, step.hasPrefix("fetching"), let f = fraction {
            return "pulling · \(Int((f * 100).rounded())) %"
        }
        return step.replacingOccurrences(of: " ...", with: "")
    }

    // MARK: Requirements

    private static var searchDirs: [String] {
        let env = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (env + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]).filter { seen.insert($0).inserted }
    }

    /// For testing only: `KEEPWATCH_SNAPSHOT_MISSING=restic,jq,tailscale` pretends these are missing.
    private static let simulatedMissing = Set((ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_MISSING"] ?? "")
        .split(separator: ",").map(String.init))

    static func find(_ tool: String) -> String? {
        if simulatedMissing.contains(tool) { return nil }
        return searchDirs.map { "\($0)/\(tool)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// PATH for the script: Homebrew first (Finder starts apps with /usr/bin:/bin:/usr/sbin:/sbin).
    private static var scriptPath: String {
        let env = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (env + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
            .filter { seen.insert($0).inserted }.joined(separator: ":")
    }

    static let brewRestic = "brew install restic"
    static var keychainCommand: String { "security add-generic-password -s \"\(keychainEntry)\" -a restic -w" }

    func checkPrerequisites() async {
        var out: [Missing] = []
        if Config.current == nil {
            out.append(Missing(kind: .config, title: "Not set up yet",
                               detail: "Run ./keepwatch desktop first - the backup is pulled from the same server.", command: nil))
        }
        if Self.find("restic") == nil {
            out.append(Missing(kind: .restic, title: "restic is missing",
                               detail: "Looked in /opt/homebrew/bin and /usr/local/bin. Install it once in Terminal:",
                               command: Self.brewRestic))
        }
        if Self.find("jq") == nil {
            out.append(Missing(kind: .jq, title: "jq is missing", detail: "Install it once in Terminal:", command: "brew install jq"))
        }
        if Self.passwordCommand == nil, !(await Self.keychainHasEntry()) {
            let hint = Config.current.map { _ in " (on the server: \(Server.sshCommand) cat /etc/keepwatch/backup/restic.pass)" } ?? ""
            out.append(Missing(kind: .keychain, title: "Password missing in the keychain",
                               detail: "A keychain item \"\(Self.keychainEntry)\" with the backup's restic password\(hint). This command asks for it:",
                               command: Self.keychainCommand))
        }
        if Self.simulatedMissing.contains("tailscale")
            || (Self.sourceOverride == nil && Server.requireTailscale && Config.current != nil && Store.shared.tailscale?.state != .running) {
            out.append(Missing(kind: .tailscale, title: "Tailscale is off",
                               detail: "The backup comes from the server over SSH through Tailscale. Connect first.", command: nil))
        }
        if let problem = folderProblem() {
            out.append(Missing(kind: .folder, title: "Folder does not fit", detail: problem, command: nil))
        }
        missing = out
        checked = true
        onChange?()
    }

    private static func keychainHasEntry() async -> Bool {
        let tool = find("security") ?? "/usr/bin/security"
        // Without -w: only check whether the item exists. Only the script reads the password.
        if await Shell.run(tool, ["find-generic-password", "-s", keychainEntry], timeout: 8).code == 0 { return true }
        return await Shell.run(tool, ["find-generic-password", "-l", keychainEntry], timeout: 8).code == 0
    }

    private func folderProblem() -> String? {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        let path = folderURL.path
        if fm.fileExists(atPath: path, isDirectory: &isDir) {
            if !isDir.boolValue { return "\(folderDisplay) is a file, not a folder." }
            let isRepo = fm.fileExists(atPath: folderURL.appendingPathComponent("config").path)
            let items = (try? fm.contentsOfDirectory(atPath: path))?.filter { $0 != ".DS_Store" } ?? []
            if !isRepo && !items.isEmpty { return "\(folderDisplay) is not empty and not a backup. Choose an empty folder." }
            if !fm.isWritableFile(atPath: path) { return "The app may not write to \(folderDisplay)." }
        } else {
            // The first existing parent must be writable (an unplugged drive shows up here, for example).
            var parent = folderURL.deletingLastPathComponent()
            while !fm.fileExists(atPath: parent.path), parent.path != "/" { parent = parent.deletingLastPathComponent() }
            if parent.path.hasPrefix("/Volumes/"), parent.pathComponents.count <= 2 {
                return "The drive for \(folderDisplay) is not connected."
            }
            if !fm.isWritableFile(atPath: parent.path) { return "\(parent.path) is not writable." }
        }
        return nil
    }

    // MARK: Folder

    func chooseFolder(for window: NSWindow?) {
        let p = NSOpenPanel()
        p.title = "Folder for the Backup"
        p.message = "The app keeps its own copy of the server backup here (a restic repository)."
        p.prompt = "Choose"
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.allowsMultipleSelection = false
        let start = FileManager.default.fileExists(atPath: folderURL.path) ? folderURL : folderURL.deletingLastPathComponent()
        p.directoryURL = FileManager.default.fileExists(atPath: start.path) ? start : FileManager.default.homeDirectoryForCurrentUser
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            guard r == .OK, let url = p.url, let self else { return }
            self.folder = (url.path as NSString).abbreviatingWithTildeInPath
            Task { await self.checkPrerequisites() }
        }
        if let window { p.beginSheetModal(for: window, completionHandler: done) } else { done(p.runModal()) }
    }

    func revealFolder() {
        if FileManager.default.fileExists(atPath: folderURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([folderURL])
        } else {
            NSWorkspace.shared.open(folderURL.deletingLastPathComponent())
        }
    }

    // MARK: Start / cancel

    /// "Pull Backup" button. If something is missing, it stays with the instructions.
    func start() {
        guard !isRunning else { return }
        Task {
            await checkPrerequisites()
            guard missing.isEmpty else {
                panelOpen = true
                AppDelegate.shared?.showWindow(tab: nil)
                onChange?()
                return
            }
            launch()
        }
    }

    func cancel() {
        guard isRunning, pid > 0 else { return }
        userCancelled = true
        step = "cancelling ..."
        onChange?()
        let group = pid
        killpg(group, SIGINT)
        // If something hangs (e.g. SSH), get firmer after a while.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, self.pid == group else { return }
            killpg(group, SIGTERM)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.pid == group else { return }
            killpg(group, SIGKILL)
        }
    }

    private func launch() {
        guard let cfg = Config.current else { return }
        guard let script = Bundle.main.path(forResource: "backup-pull", ofType: "sh") else {
            phase = .failed("The script is missing from the app (Resources/backup-pull.sh). Build the app again.")
            onChange?()
            return
        }
        try? FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
        phase = .running
        step = "preparing ..."
        fraction = nil
        log = []
        toFetch = 0
        saved = 0
        begun = 0
        packs = 0
        lastError = nil
        summary = nil
        userCancelled = false
        buffer = Data()
        started = Date()
        onChange?()

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Self.scriptPath
        env["KW_APP"] = "1"
        env["KW_HOST"] = cfg.host
        env["KW_SSH_USER"] = cfg.user
        env["KW_SSH_PORT"] = String(cfg.sshPort)
        env["KW_BACKUP_KEYCHAIN"] = Self.keychainEntry
        // KW_HOST goes in bare (also for IPv6, the script adds brackets itself); our own
        // source URL needs them: sftp:user@[2001:db8::1]:/path.
        if Self.sourceOverride == nil, let repo = cfg.backupRepo, repo != AppConfig.defaultBackupRepo {
            env["KW_BACKUP_SOURCE"] = "sftp:\(cfg.sftpTarget):\(repo)"
        }
        env["LC_ALL"] = "en_US.UTF-8"
        var args = [script, folderURL.path]
        if thorough { args.append("--thorough") }

        do {
            pid = try Spawn.start("/bin/bash", args, env: env, output: { [weak self] data in
                Task { @MainActor in self?.consume(data) }
            }, exit: { [weak self] code in
                Task { @MainActor in self?.finished(code) }
            })
        } catch {
            phase = .failed("Could not start the script: \(error.localizedDescription)")
            onChange?()
        }
    }

    // MARK: Read output

    private func consume(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...nl)
            handle(line.trimmingCharacters(in: .whitespaces))
        }
    }

    private func handle(_ line: String) {
        guard !line.isEmpty else { return }
        if line.hasPrefix("::") {
            let parts = line.dropFirst(2).split(separator: " ").map(String.init)
            switch (parts.first, parts.dropFirst().first) {
            case ("step", "prepare"): step = "preparing ..."
            case ("step", "init"): step = "creating the copy ..."
            case ("step", "connect"): step = "connecting to the server ..."; fraction = 0.03
            case ("step", "fetch"):
                toFetch = Int(parts.dropFirst(2).first ?? "") ?? 0
                step = Self.fetchText(toFetch)
                fraction = 0.05
            case ("snapshot", "start"):
                begun += 1
                packs = 0
                updateFetchProgress()
            case ("snapshot", "packs"):
                if parts.count >= 3, let pct = Double(parts[2]) { packs = pct / 100 }
                updateFetchProgress()
            case ("snapshot", "saved"):
                saved += 1
                updateFetchProgress()
            case ("step", "verify"):
                step = parts.dropFirst(2).first == "1" ? "verifying all data ..." : "verifying ..."
                fraction = 0.85
            case ("step", "compare"): step = "comparing with the server ..."; fraction = 0.95
            case ("result", _): summary = Self.parseSummary(parts.dropFirst())
            default: break
            }
            onChange?()
            return
        }
        if line.lowercased().hasPrefix("error:") {
            lastError = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        }
        log.append(line)
        if log.count > 60 { log.removeFirst(log.count - 60) }
    }

    /// restic 0.19 copies several snapshots in one batch (each batch with "snapshot ... of ..." and
    /// its own pack counter) and does not know the total up front. So this is only an estimate
    /// that never goes backwards, and no "snapshot n of m".
    private func updateFetchProgress() {
        guard toFetch > 0 else { return }
        let done = min(max(Double(saved), Double(max(begun - 1, 0)) + packs), Double(toFetch))
        fraction = max(fraction ?? 0, 0.05 + 0.8 * done / Double(toFetch))
        step = Self.fetchText(toFetch)
    }

    private static func fetchText(_ n: Int) -> String {
        n == 0 ? "no new snapshots, verifying next ..." : n == 1 ? "fetching 1 new snapshot ..." : "fetching \(n) new snapshots ..."
    }

    private static func parseSummary(_ kv: ArraySlice<String>) -> Summary {
        var d: [String: String] = [:]
        for p in kv { let x = p.split(separator: "=", maxSplits: 1); if x.count == 2 { d[String(x[0])] = String(x[1]) } }
        let iso = ISO8601DateFormatter()
        return Summary(snapshots: Int(d["snapshots"] ?? "") ?? 0,
                       new: Int(d["new"] ?? "") ?? 0,
                       bytes: (Int64(d["kib"] ?? "") ?? 0) * 1024,
                       thorough: d["thorough"] == "1",
                       newest: d["latest"].flatMap { iso.date(from: $0) })
    }

    private func finished(_ code: Int32) {
        if !buffer.isEmpty { handle(String(decoding: buffer, as: UTF8.self)); buffer = Data() }
        pid = 0
        let now = Date()
        mac.lastRun = now
        if userCancelled {
            phase = .cancelled
            mac.lastRunOK = false
            mac.lastError = MacBackupState.cancelled
        } else if code == 0, let s = summary {
            phase = .done(s)
            mac.lastSuccess = now
            mac.lastSuccessSnapshots = s.snapshots
            mac.lastSuccessBytes = s.bytes
            mac.lastRunOK = true
            mac.lastError = nil
        } else {
            let msg = lastError ?? (code == 0 ? "The script reported no result." : "The script exited with error \(code).")
            phase = .failed(msg)
            mac.lastRunOK = false
            mac.lastError = msg
        }
        step = ""
        fraction = nil
        mac.save()
        WidgetBridge.reloadNow()
        notifyIfHidden()
        onChange?()
    }

    private func notifyIfHidden() {
        if NSApp.isActive, AppDelegate.shared?.mainWindow?.isVisible == true { return }
        switch phase {
        case .done(let s):
            Notifier.shared.post(id: "backup", title: "Backup pulled to this Mac",
                                 body: "\(Self.newText(s.new)) · \(Self.snapshotsText(s.snapshots)) · \(Self.bytes(s.bytes)) · verified ✓")
        case .failed(let m):
            Notifier.shared.post(id: "backup", title: "Pulling the backup failed", body: m)
        default: break
        }
    }

    // MARK: Texts

    static func newText(_ n: Int) -> String { n == 0 ? "nothing new" : n == 1 ? "1 new snapshot" : "\(n) new snapshots" }
    static func snapshotsText(_ n: Int) -> String { n == 1 ? "1 snapshot" : "\(n) snapshots" }

    static func bytes(_ b: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useMB, .useGB, .useTB]
        return f.string(fromByteCount: b)
    }

    /// Result in one line (for the menu and the bar).
    var resultText: String? {
        switch phase {
        case .done(let s): "\(Self.newText(s.new)) · \(Self.snapshotsText(s.snapshots)) · \(Self.bytes(s.bytes)) · verified ✓"
        case .failed(let m): m
        case .cancelled: "Cancelled. Everything that was already complete stays on this Mac."
        default: nil
        }
    }
}

// MARK: - Process in its own group (for a clean cancel)

enum Spawn {
    struct Failure: LocalizedError {
        var code: Int32
        var errorDescription: String? { String(cString: strerror(code)) }
    }

    /// Starts `path` with `args` in a new process group (pgid = pid). stdout and stderr both
    /// go to `output`, stdin is /dev/null.
    static func start(_ path: String, _ args: [String], env: [String: String],
                      output: @escaping @Sendable (Data) -> Void,
                      exit: @escaping @Sendable (Int32) -> Void) throws -> pid_t {
        let pipe = Pipe()
        let readFD = pipe.fileHandleForReading.fileDescriptor
        let writeFD = pipe.fileHandleForWriting.fileDescriptor

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)

        var fa: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fa)
        defer { posix_spawn_file_actions_destroy(&fa) }
        posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&fa, writeFD, 1)
        posix_spawn_file_actions_adddup2(&fa, writeFD, 2)

        let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, &fa, &attr, argv, envp)
        try? pipe.fileHandleForWriting.close()
        guard rc == 0 else { throw Failure(code: rc) }

        let reader = pipe.fileHandleForReading
        DispatchQueue.global(qos: .userInitiated).async {
            while true {
                let data = reader.availableData
                if data.isEmpty { break }
                output(data)
            }
            var status: Int32 = 0
            waitpid(pid, &status, 0)
            let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
            exit(code)
        }
        _ = readFD
        return pid
    }
}
