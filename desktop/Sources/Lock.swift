import AppKit
import LocalAuthentication
import Observation

// App lock: at launch and after 15 min without input in the window, the content is covered until
// Touch ID (or the Mac's password as a fallback) confirms. The menu bar icon keeps showing the
// status; every action (window content, pull backup, Terminal, tabs ...) asks first.
//
// Shorter timeout for testing (seconds, at least 5):
//   defaults write io.github.keepwatch.desktop lockAfterSeconds -int 20
//   defaults delete io.github.keepwatch.desktop lockAfterSeconds      # back to 15 min

@MainActor @Observable
final class AppLock {
    static let shared = AppLock()

    var locked = true
    var prompting = false
    /// Why the last unlock failed (nil = nothing to say).
    var message: String?

    @ObservationIgnored private var lastActivity = Date()
    @ObservationIgnored private var monitor: Any?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pending: [@MainActor () -> Void] = []
    @ObservationIgnored private var promptEnded: Date?

    static var timeout: TimeInterval {
        let v = UserDefaults.standard.double(forKey: "lockAfterSeconds")
        return v >= 5 ? v : 15 * 60
    }

    /// Only for testing a build (`KEEPWATCH_NOLOCK=1`), never in the installed copy.
    static var bypass: Bool {
        !LoginItem.isInstalled && ProcessInfo.processInfo.environment["KEEPWATCH_NOLOCK"] == "1"
    }

    /// Only for testing a build: do not ask for Touch ID by itself (to capture the lock screen).
    static var noPrompt: Bool {
        !LoginItem.isInstalled && ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_NOPROMPT"] == "1"
    }

    /// In test mode (KEEPWATCH_SNAPSHOT) write the sequence to lock.txt.
    static func trace(_ line: String) {
        guard let dir = ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT"] else { return }
        let path = dir + "/lock.txt", text = "\(Date()) \(line)\n"
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(Data(text.utf8)); h.closeFile() }
        else { try? text.write(toFile: path, atomically: true, encoding: .utf8) }
    }

    func start() {
        Self.trace("start locked=\(locked) bypass=\(Self.bypass) timeout=\(Self.timeout)")
        if Self.bypass { locked = false }
        // Only for testing a build: start unlocked, the timeout lock applies (e.g. `... -lockAfterSeconds 8`).
        if !LoginItem.isInstalled, ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT_UNLOCKED"] == "1" { locked = false }
        let kinds: NSEvent.EventTypeMask = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                            .leftMouseDragged, .mouseMoved, .scrollWheel, .magnify, .swipe]
        monitor = NSEvent.addLocalMonitorForEvents(matching: kinds) { e in
            guard let w = e.window, !w.className.contains("StatusBar") else { return e }
            // Read keyCode ONLY for key events: for mouse/scroll events NSEvent throws an exception
            // ("Invalid message sent to event") and AppKit then drops every click.
            let number = w.windowNumber, isKey = e.type == .keyDown
            let keyCode: UInt16 = isKey ? e.keyCode : 0
            let command = e.modifierFlags.contains(.command)
            let swallow = MainActor.assumeIsolated {
                AppLock.shared.event(window: number, keyDown: isKey, keyCode: keyCode, command: command)
            }
            return swallow ? nil : e
        }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            MainActor.assumeIsolated { AppLock.shared.tick() }
        }
        // Sleep counts as inactivity: afterwards tick() checks the elapsed time right away.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { AppLock.shared.tick() }
        }
    }

    /// true = swallow the event. Unlocked: counts as activity. Locked: typing does not reach the
    /// covered page (Cmd shortcuts go to the menu, which asks first); Return/Space unlock.
    private func event(window: Int, keyDown: Bool, keyCode: UInt16, command: Bool) -> Bool {
        if !locked { lastActivity = Date(); return false }
        guard keyDown, !command, window == AppDelegate.shared?.mainWindow?.windowNumber else { return false }
        if keyCode == 36 || keyCode == 49 { unlock() }
        return true
    }

    private func tick() {
        guard !locked, !Self.bypass else { return }
        if Date().timeIntervalSince(lastActivity) >= Self.timeout { lock() }
    }

    func lock() {
        guard !locked else { return }
        Self.trace("lock")
        locked = true
        message = nil
        pending.removeAll()
        Backup.shared.panelOpen = false
        Web.shared.setHidden(true)
        if let w = AppDelegate.shared?.mainWindow { w.makeFirstResponder(nil) }
        AppDelegate.shared?.lockChanged()
    }

    /// Unlock (Touch ID, otherwise the Mac password). `then` runs on success - right away if unlocked.
    func unlock(then action: (@MainActor () -> Void)? = nil) {
        if !locked { action?(); return }
        if let action { pending.append(action) }
        guard !prompting else { return }
        prompting = true
        message = nil
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            prompting = false
            pending.removeAll()
            message = "Cannot unlock: \(err?.localizedDescription ?? "no authentication available")."
            return
        }
        Self.trace("Touch ID prompt")
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "unlock Keepwatch") { ok, error in
            let text: String? = ok ? nil : Self.text(error)
            Task { @MainActor in AppLock.shared.finish(ok, text) }
        }
    }

    /// Ask by itself (window comes to the front) - not right after a cancel, otherwise closing
    /// the dialog brings the app to the front and it asks forever.
    func autoPrompt() {
        guard locked, !prompting, !Self.noPrompt else { return }
        if let t = promptEnded, Date().timeIntervalSince(t) < 3 { return }
        unlock()
    }

    /// Test mode only (build/, KEEPWATCH_SNAPSHOT): unlock without a finger.
    func testUnlock() {
        guard !LoginItem.isInstalled, ProcessInfo.processInfo.environment["KEEPWATCH_SNAPSHOT"] != nil else { return }
        finish(true, nil)
    }

    private func finish(_ ok: Bool, _ text: String?) {
        Self.trace("result ok=\(ok) \(text ?? "")")
        prompting = false
        promptEnded = Date()
        guard ok else {
            pending.removeAll()
            message = text
            return
        }
        locked = false
        message = nil
        lastActivity = Date()
        Web.shared.setHidden(false)
        AppDelegate.shared?.lockChanged()
        let run = pending
        pending.removeAll()
        for a in run { a() }
    }

    nonisolated private static func text(_ error: Error?) -> String? {
        guard let la = error as? LAError else { return error?.localizedDescription }
        switch la.code {
        case .userCancel, .appCancel, .systemCancel: return nil
        case .biometryLockout: return "Touch ID is locked - unlock with the Mac password."
        default: return la.localizedDescription
        }
    }
}
