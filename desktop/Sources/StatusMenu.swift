import AppKit

/// Menu bar: a native NSMenu, no SwiftUI views. Only built when it opens.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    private var item: NSStatusItem?
    private let menu = NSMenu()
    private var isOpen = false
    private var lastLevel: Level??
    private var lastBusy: Bool?

    func install() {
        let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        it.button?.toolTip = "Keepwatch"
        menu.delegate = self
        menu.autoenablesItems = false
        it.menu = menu
        item = it
        update()
    }

    /// After each check: repaint the dot, refresh the open menu.
    func update() {
        let s = Store.shared
        let busy = s.phase == .checking || s.phase == .connecting
        let level = s.trayLevel
        if lastLevel == nil || level != lastLevel! || busy != lastBusy {
            item?.button?.image = StatusIcon.image(level: level, hollow: busy)
            lastLevel = .some(level)
            lastBusy = busy
        }
        item?.button?.toolTip = "\(s.trayText) · This Mac: \(s.macText)"
        if isOpen { rebuild() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) { rebuild() }
    func menuWillOpen(_ menu: NSMenu) { isOpen = true; Store.shared.setMenuOpen(true) }
    func menuDidClose(_ menu: NSMenu) { isOpen = false; Store.shared.setMenuOpen(false) }

    private func rebuild() {
        let s = Store.shared
        let d = AppDelegate.shared
        menu.removeAllItems()

        // Server: everything that comes from the server
        menu.addItem(.sectionHeader(title: Server.host.isEmpty ? "Server" : "Server · \(Server.host)"))
        let line = s.isReady && s.health.isEmpty ? "All good · \(s.serverText)"
            : s.phase == .ready || s.phase == .serverDown ? s.serverText.prefix(1).uppercased() + s.serverText.dropFirst()
            : s.phase == .noConfig ? "Not set up - run ./keepwatch desktop"
            : s.phase == .tunnelFailed ? "Not checked - this Mac's SSH tunnel is down"
            : s.phase == .tunnel ? "Checking - opening the SSH tunnel"
            : s.phase == .checking ? "Checking ..."
            : "Not checked - Tailscale on this Mac is not connected"
        menu.addItem(info(line, dot: s.trayLevel))
        for p in s.health.prefix(6) {
            let i = MainMenu.item(p.title, #selector(AppDelegate.showDashboard(_:)), "", d)
            i.image = StatusIcon.dot(p.isCrit ? .crit : .warn)
            i.toolTip = p.detail
            i.indentationLevel = 1
            menu.addItem(i)
        }

        // This Mac: only its own connection
        menu.addItem(.sectionHeader(title: "This Mac"))
        menu.addItem(info(s.macText, dot: s.macLevel))
        if !s.isReady && s.phase != .checking && s.phase != .connecting && s.phase != .tunnel {
            menu.addItem(MainMenu.item(s.phase == .noConfig ? "Check Again" : s.phase == .needsLogin ? "Open Tailscale"
                                       : s.phase == .tunnelFailed ? "Try Tunnel Again" : "Connect",
                                       #selector(AppDelegate.connect(_:)), "", d))
        }
        if AppLock.shared.locked {
            menu.addItem(info("App locked - actions need Touch ID first", dot: nil))
        }

        // Backup on this Mac: only on request
        let b = Backup.shared
        menu.addItem(.sectionHeader(title: "Backup on This Mac"))
        if b.isRunning {
            menu.addItem(info(b.step.isEmpty ? "running ..." : b.step.prefix(1).uppercased() + b.step.dropFirst(), dot: nil, hollow: true))
            let stop = MainMenu.item("Cancel", #selector(AppDelegate.cancelBackup(_:)), "", d)
            stop.image = symbol("xmark.circle")
            menu.addItem(stop)
        } else {
            switch b.phase {
            case .done, .failed, .cancelled:
                if let r = b.resultText {
                    let ok: Level = if case .done = b.phase { .ok } else if case .failed = b.phase { .crit } else { .warn }
                    let i = info(r, dot: ok)
                    i.toolTip = r
                    menu.addItem(i)
                }
            case .idle, .running: break
            }
            if case .done = b.phase {} else {
                menu.addItem(info(b.doneToday ? "Pulled today · \(b.lastText)" : "Not pulled today · \(b.lastText)",
                                  dot: b.doneToday ? .ok : .warn))
            }
            let fetch = MainMenu.item("Pull Backup", #selector(AppDelegate.fetchBackup(_:)), "", d)
            fetch.image = symbol("externaldrive.badge.icloud")
            menu.addItem(fetch)
            let more = MainMenu.item("Folder, Requirements, Output ...", #selector(AppDelegate.showBackupPanel(_:)), "", d)
            more.image = symbol("slider.horizontal.3")
            more.isAlternate = true
            more.keyEquivalentModifierMask = [.option]
            menu.addItem(more)
        }

        menu.addItem(.separator())
        let dash = MainMenu.item("Open Dashboard", #selector(AppDelegate.showDashboard(_:)), "", d)
        dash.image = symbol("macwindow")
        menu.addItem(dash)
        menu.addItem(.separator())
        for t in Tab.allCases {
            let i = MainMenu.item(t.title, #selector(AppDelegate.selectTab(_:)), t.shortcut, d)
            i.tag = t.rawValue
            i.image = symbol(t.symbol)
            menu.addItem(i)
            // Option held: open in browser
            let alt = MainMenu.item("Open \(t.title) in Browser", #selector(AppDelegate.openTabInBrowser(_:)), t.shortcut, d)
            alt.tag = t.rawValue
            alt.image = symbol("safari")
            alt.keyEquivalentModifierMask = [.command, .option]
            alt.isAlternate = true
            menu.addItem(alt)
        }
        let term = MainMenu.item("Open Terminal", #selector(AppDelegate.openTerminal(_:)), "t", d)
        term.image = symbol("terminal")
        menu.addItem(term)
        let copy = MainMenu.item("Copy SSH Command", #selector(AppDelegate.copySSH(_:)), "t", d)
        copy.image = symbol("doc.on.doc")
        copy.keyEquivalentModifierMask = [.command, .option]
        copy.isAlternate = true
        menu.addItem(copy)

        menu.addItem(.separator())
        menu.addItem(MainMenu.item("Open Window", #selector(AppDelegate.openMain(_:)), "0", d))
        if !AppLock.shared.locked {
            let lk = MainMenu.item("Lock", #selector(AppDelegate.lockNow(_:)), "l", d)
            lk.image = symbol("lock")
            menu.addItem(lk)
        }
        let login = MainMenu.item("Open at Login", #selector(AppDelegate.toggleLogin(_:)), "", d)
        login.state = s.loginItem ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Keepwatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func info(_ text: String, dot: Level?, hollow: Bool = false) -> NSMenuItem {
        let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        i.isEnabled = false
        i.image = hollow ? StatusIcon.ring() : (dot.map(StatusIcon.dot) ?? StatusIcon.dot(nil))
        i.attributedTitle = NSAttributedString(string: text, attributes: [
            .font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.labelColor])
        return i
    }

    private func symbol(_ name: String) -> NSImage? {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
    }
}

enum StatusIcon {
    static func color(_ l: Level) -> NSColor {
        switch l {
        case .ok: NSColor(srgbRed: 120 / 255, green: 205 / 255, blue: 160 / 255, alpha: 1)
        case .warn: NSColor(srgbRed: 232 / 255, green: 190 / 255, blue: 100 / 255, alpha: 1)
        case .crit: NSColor(srgbRed: 238 / 255, green: 110 / 255, blue: 125 / 255, alpha: 1)
        }
    }

    /// Server rack in the menu bar's text color, dot at the bottom right.
    /// level nil = gray dot (Tailscale off, nothing checked); hollow = a check is running.
    static func image(level: Level?, hollow: Bool = false) -> NSImage {
        let dot = level.map(color) ?? NSColor.tertiaryLabelColor
        let img = NSImage(size: NSSize(width: 20, height: 16), flipped: false) { rect in
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let cfg = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
                .applying(NSImage.SymbolConfiguration(paletteColors: [dark ? .white : .black]))
            if let sym = NSImage(systemSymbolName: "server.rack", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
                sym.draw(in: NSRect(x: 1, y: (rect.height - sym.size.height) / 2, width: sym.size.width, height: sym.size.height))
            }
            let r = NSRect(x: rect.width - 7.5, y: 0.5, width: 7, height: 7)
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: r.insetBy(dx: -1.6, dy: -1.6)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            if hollow {
                dot.setStroke()
                let ring = NSBezierPath(ovalIn: r.insetBy(dx: 0.9, dy: 0.9))
                ring.lineWidth = 1.6
                ring.stroke()
            } else {
                dot.setFill()
                NSBezierPath(ovalIn: r).fill()
            }
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = switch level {
        case .ok: "Server reachable"
        case .warn: "Server reports a problem"
        case .crit: "Server unreachable"
        case nil: "Server not checked"
        }
        return img
    }

    /// Ring: running right now.
    static func ring() -> NSImage {
        NSImage(size: NSSize(width: 14, height: 14), flipped: false) { _ in
            NSColor.secondaryLabelColor.setStroke()
            let p = NSBezierPath(ovalIn: NSRect(x: 3.8, y: 3.8, width: 6.4, height: 6.4))
            p.lineWidth = 1.4
            p.stroke()
            return true
        }
    }

    static func dot(_ l: Level?) -> NSImage {
        let c = l.map(color) ?? NSColor.tertiaryLabelColor
        let img = NSImage(size: NSSize(width: 14, height: 14), flipped: false) { _ in
            c.setFill()
            NSBezierPath(ovalIn: NSRect(x: 3.5, y: 3.5, width: 7, height: 7)).fill()
            return true
        }
        return img
    }
}
