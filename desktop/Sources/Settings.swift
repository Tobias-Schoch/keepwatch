import AppKit
import SwiftUI

/// Small settings window: host, user, SSH port and Tailscale. The list of UIs comes from
/// `./keepwatch desktop` (or editing config.json by hand) and is only shown here.
@MainActor
enum SettingsWindow {
    private static var window: NSWindow?

    static func show() {
        let w = window ?? {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 420),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Keepwatch Settings"
            w.isReleasedWhenClosed = false
            w.appearance = NSAppearance(named: .darkAqua)
            w.center()
            return w
        }()
        window = w
        // Fresh view each time, so it shows the current file.
        w.contentView = NSHostingView(rootView: SettingsView(close: { w.close() }).preferredColorScheme(.dark))
        NSApp.setActivationPolicy(.regular)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}

struct SettingsView: View {
    var close: () -> Void

    @State private var host = Config.current?.host ?? ""
    @State private var user = Config.current?.user ?? "root"
    @State private var port = String(Config.current?.sshPort ?? 22)
    @State private var tailscale = Config.current?.requireTailscale ?? true
    @State private var error: String?

    private var uis: [RemoteUI] { Config.current?.uis ?? AppConfig.defaultUIs }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Form {
                TextField("Host", text: $host, prompt: Text("203.0.113.10 or server.example.com"))
                TextField("SSH user", text: $user)
                TextField("SSH port", text: $port)
                Toggle("Require Tailscale", isOn: $tailscale)
                    .help("On: the app checks and starts Tailscale before opening the tunnel. Off: plain SSH.")
            }
            .formStyle(.grouped)
            .frame(height: 210)

            VStack(alignment: .leading, spacing: 4) {
                Text("Tabs").font(.system(size: 12, weight: .semibold))
                Text(uis.enumerated().map { "\($0.offset < 9 ? "Cmd-\($0.offset + 1)" : "-")  \($0.element.name) (port \($0.element.port))" }
                    .joined(separator: "\n"))
                    .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.secondary)
                Text("Run ./keepwatch desktop again after changing modules or KW_EXTRA_UIS, or edit \(Config.displayPath).")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 6)

            if let error { Text(error).font(.system(size: 12)).foregroundStyle(.red) }

            HStack {
                Button("Show File") { AppDelegate.shared?.revealConfig(nil) }
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button("Save", action: save).keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 460)
    }

    private func save() {
        var c = Config.current ?? AppConfig(host: "")
        c.host = host.trimmingCharacters(in: .whitespaces)
        c.user = user.trimmingCharacters(in: .whitespaces)
        guard let p = Int(port.trimmingCharacters(in: .whitespaces)) else { error = "The SSH port must be a number."; return }
        c.sshPort = p
        c.requireTailscale = tailscale
        if let problem = c.problem { error = problem; return }
        do {
            let changed = c != Config.current
            try Config.save(c)
            if changed { Store.shared.configChanged() }
            close()
        } catch {
            self.error = "Could not write \(Config.displayPath): \(error.localizedDescription)"
        }
    }
}
