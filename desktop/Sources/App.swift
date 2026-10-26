import AppKit

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    static var shared: AppDelegate?
    static let launchedHidden = CommandLine.arguments.contains("--hidden")

    private var window: NSWindow?
    private let status = StatusMenu()

    static func main() {
        let app = NSApplication.shared
        let d = AppDelegate()
        shared = d
        app.delegate = d
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSApp.mainMenu = MainMenu.build()
        status.install()
        Store.shared.onChange = { [weak self] in self?.status.update() }
        Backup.shared.onChange = { [weak self] in self?.status.update() }
        AppLock.shared.start()
        Store.shared.start()
        if Self.launchedHidden {
            NSApp.setActivationPolicy(.accessory)
        } else {
            showWindow(tab: nil)
        }
        Snapshot.scheduleIfRequested()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Close the tunnel cleanly; from now on the widgets show "App not running".
    func applicationWillTerminate(_ notification: Notification) {
        Tunnel.shared.stop()
        WidgetBridge.appQuits()
    }

    /// Back in the app (Cmd-Tab, Dock): if it is locked and the window is visible, ask for Touch ID right away.
    func applicationDidBecomeActive(_ notification: Notification) {
        if window?.isVisible == true, window?.isMiniaturized == false { AppLock.shared.autoPrompt() }
    }

    /// After locking/unlocking: refresh the menu bar, load the page if needed.
    func lockChanged() {
        status.update()
        if !AppLock.shared.locked, Store.shared.isReady { Web.shared.activate() }
    }

    /// The list of UIs may have changed: tabs in the main menu and the status menu.
    func rebuildMenus() {
        NSApp.mainMenu = MainMenu.build()
        status.update()
    }

    /// Run an action only after unlocking (right away if unlocked).
    private func guarded(_ action: @escaping @MainActor () -> Void) { AppLock.shared.unlock(then: action) }

    /// Widget click: keepwatch://open/<page> -> dashboard on that page (after unlocking).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let page = DashPage.from(url) else { continue }
            showWindow(tab: nil)
            guarded {
                Web.shared.open(page: page)
                if page == .backups, url.query?.contains("pull") == true { Backup.shared.panelOpen = true }
            }
        }
    }

    /// Do not just cut off a running backup pull.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard Backup.shared.isRunning else { return .terminateNow }
        let a = NSAlert()
        a.messageText = "A backup is being pulled right now."
        a.informativeText = "Quitting cancels the run. Everything that is already complete stays on this Mac."
        a.addButton(withTitle: "Keep Running")
        a.addButton(withTitle: "Cancel and Quit")
        guard a.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        Backup.shared.cancel()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    /// Click on the app icon (Dock or Finder) while the app is running.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow(tab: nil) }
        return true
    }

    var mainWindow: NSWindow? { window }

    /// Show the window. Locked: first the lock (content covered) and Touch ID, the tab is chosen afterwards.
    func showWindow(tab: Tab?) {
        let w = window ?? makeMainWindow(delegate: self)
        window = w
        NSApp.setActivationPolicy(.regular)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate()
        if let tab { guarded { Web.shared.choose(tab) } } else { AppLock.shared.autoPrompt() }
    }

    // MARK: Window

    func windowDidChangeOcclusionState(_ notification: Notification) {
        guard let w = window, notification.object as? NSWindow === w else { return }
        Store.shared.setWindowVisible(w.isVisible && w.occlusionState.contains(.visible))
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === window else { return }
        Store.shared.setWindowVisible(false)
        // Without a window the app lives in the menu bar only.
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    // MARK: Menu commands

    @objc func selectTab(_ sender: NSMenuItem) {
        guard let t = Tab(rawValue: sender.tag) else { return }
        showWindow(tab: t)
    }
    /// Open in browser: http://localhost:<local port> - works while this app's tunnel is up.
    @objc func openTabInBrowser(_ sender: NSMenuItem) {
        guard let t = Tab(rawValue: sender.tag) else { return }
        guarded { NSWorkspace.shared.open(Web.shared.views[t]?.url ?? t.home) }
    }
    @objc func openMain(_ sender: Any?) { showWindow(tab: nil) }
    @objc func reload(_ sender: Any?) { guarded { Web.shared.reload() } }
    @objc func back(_ sender: Any?) { guarded { Web.shared.goBack() } }
    @objc func forward(_ sender: Any?) { guarded { Web.shared.goForward() } }
    @objc func zoomIn(_ sender: Any?) { guarded { Web.shared.zoom(0.1) } }
    @objc func zoomOut(_ sender: Any?) { guarded { Web.shared.zoom(-0.1) } }
    @objc func zoomReset(_ sender: Any?) { guarded { Web.shared.zoom(nil) } }
    @objc func openInBrowser(_ sender: Any?) { guarded { Web.shared.openInBrowser() } }
    @objc func openTerminal(_ sender: Any?) { guarded { Terminal.openSSH() } }
    @objc func copySSH(_ sender: Any?) { guarded { Clip.copy(Server.sshCommand) } }
    @objc func connect(_ sender: Any?) { Store.shared.userConnect() }
    @objc func toggleLogin(_ sender: Any?) { guarded { Store.shared.setLoginItem(!Store.shared.loginItem) } }
    @objc func showDashboard(_ sender: Any?) { showWindow(tab: .dashboard) }
    @objc func fetchBackup(_ sender: Any?) { guarded { Backup.shared.start() } }
    @objc func cancelBackup(_ sender: Any?) { guarded { Backup.shared.cancel() } }
    @objc func showBackupPanel(_ sender: Any?) {
        showWindow(tab: nil)
        guarded { DispatchQueue.main.async { Backup.shared.panelOpen = true } }
    }
    @objc func lockNow(_ sender: Any?) { AppLock.shared.lock() }
    @objc func showSettings(_ sender: Any?) { guarded { SettingsWindow.show() } }
    @objc func reloadConfig(_ sender: Any?) {
        if Config.reload() { Store.shared.configChanged() } else { Task { await Store.shared.refresh(autoConnect: true) } }
    }
    @objc func revealConfig(_ sender: Any?) {
        if Config.exists { NSWorkspace.shared.activateFileViewerSelecting([Config.file]) }
        else {
            try? FileManager.default.createDirectory(at: Config.directory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(Config.directory)
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(lockNow(_:)) { return !AppLock.shared.locked }
        if item.action == #selector(toggleLogin(_:)) { item.state = Store.shared.loginItem ? .on : .off }
        if item.action == #selector(fetchBackup(_:)) { return !Backup.shared.isRunning && Config.current != nil }
        if [#selector(openTerminal(_:)), #selector(copySSH(_:))].contains(item.action) { return Config.current != nil }
        return true
    }
}

// MARK: - Main menu (with Edit, so copy/paste work in the pages)

enum MainMenu {
    @MainActor static func build() -> NSMenu {
        let main = NSMenu()
        let d = AppDelegate.shared

        let app = submenu(main, "Keepwatch")
        app.addItem(withTitle: "About Keepwatch", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(item("Settings ...", #selector(AppDelegate.showSettings(_:)), ",", d))
        app.addItem(item("Open at Login", #selector(AppDelegate.toggleLogin(_:)), "", d))
        app.addItem(.separator())
        app.addItem(item("Lock", #selector(AppDelegate.lockNow(_:)), "l", d))
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Keepwatch", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Keepwatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let edit = submenu(main, "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu(main, "View")
        for t in Tab.allCases {
            let i = item(t.title, #selector(AppDelegate.selectTab(_:)), t.shortcut, d)
            i.tag = t.rawValue
            view.addItem(i)
        }
        view.addItem(.separator())
        view.addItem(item("Reload", #selector(AppDelegate.reload(_:)), "r", d))
        view.addItem(item("Back", #selector(AppDelegate.back(_:)), "[", d))
        view.addItem(item("Forward", #selector(AppDelegate.forward(_:)), "]", d))
        view.addItem(.separator())
        view.addItem(item("Zoom In", #selector(AppDelegate.zoomIn(_:)), "+", d))
        view.addItem(item("Zoom Out", #selector(AppDelegate.zoomOut(_:)), "-", d))
        view.addItem(item("Actual Size", #selector(AppDelegate.zoomReset(_:)), "0", d))

        let server = submenu(main, "Server")
        server.addItem(item("Open Terminal", #selector(AppDelegate.openTerminal(_:)), "t", d))
        let copy = item("Copy SSH Command", #selector(AppDelegate.copySSH(_:)), "c", d)
        copy.keyEquivalentModifierMask = [.command, .shift]
        server.addItem(copy)
        let browser = item("Open in Browser", #selector(AppDelegate.openInBrowser(_:)), "o", d)
        browser.keyEquivalentModifierMask = [.command, .shift]
        server.addItem(browser)
        server.addItem(.separator())
        let fetch = item("Pull Backup", #selector(AppDelegate.fetchBackup(_:)), "s", d)
        fetch.keyEquivalentModifierMask = [.command, .shift]
        server.addItem(fetch)
        server.addItem(item("Backup on This Mac ...", #selector(AppDelegate.showBackupPanel(_:)), "", d))
        server.addItem(.separator())
        server.addItem(item("Check Connection", #selector(AppDelegate.connect(_:)), "", d))
        server.addItem(item("Reload Configuration", #selector(AppDelegate.reloadConfig(_:)), "", d))
        server.addItem(item("Show Configuration File", #selector(AppDelegate.revealConfig(_:)), "", d))

        let win = submenu(main, "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = win
        return main
    }

    @MainActor private static func submenu(_ main: NSMenu, _ title: String) -> NSMenu {
        let m = NSMenu(title: title)
        let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        it.submenu = m
        main.addItem(it)
        return m
    }

    @MainActor static func item(_ title: String, _ action: Selector, _ key: String, _ target: AnyObject?) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = target
        return i
    }
}
