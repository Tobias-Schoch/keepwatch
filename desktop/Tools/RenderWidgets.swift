import AppKit
import SwiftUI
import WidgetKit

// Testing only: renders the four widgets as PNG (dark, light; live data, sample, problem, offline).
//   swiftc ... Tools/RenderWidgets.swift Widgets/Model.swift Widgets/Views.swift Shared/Shared.swift
//   ./RenderWidgets <folder> [http://localhost:19004/api/]
// Live data only via GET from the dashboard API (through the running app's tunnel).

@main
struct RenderWidgets {
    @MainActor static func main() async {
        let dir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Live data through the running app's tunnel (http://localhost:19004).
        let live = await Loader.fetch(base: CommandLine.arguments.dropFirst(2).first ?? "http://localhost:19004/api/")
        var mac = MacBackupState()
        mac.lastSuccess = Calendar.current.date(byAdding: .hour, value: -26, to: Date())
        mac.lastSuccessSnapshots = 41
        let now = Date()
        let liveEntry = ServerEntry(date: now, snapshot: live.snapshot ?? .sample, mac: mac, failure: live.failure)
        var macToday = mac
        macToday.lastSuccess = Date().addingTimeInterval(-600)
        var offline = liveEntry
        offline.failure = "Tailscale off"
        offline.date = now.addingTimeInterval(3 * 3600)
        var problem = ServerSnapshot.sample
        problem.problems = [.init(level: .crit, title: "19 critical vulnerabilities", detail: nil),
                            .init(level: .warn, title: "Weak secret", detail: nil)]
        problem.services?[1] = .init(name: "Gitea", tone: .crit, note: "stopped", problem: true)

        let sets: [(String, ServerEntry)] = [
            ("live", liveEntry),
            ("sample", ServerEntry(date: now, snapshot: .sample, mac: macToday, failure: nil)),
            ("problem", ServerEntry(date: now, snapshot: problem, mac: mac, failure: nil)),
            ("offline", offline),
        ]
        for (name, e) in sets {
            for scheme in [ColorScheme.dark, .light] {
                let sheet = HStack(alignment: .top, spacing: 24) {
                    tile(StatusView(entry: e), small: true, scheme)
                    tile(AttacksView(entry: e), small: true, scheme)
                    tile(ServicesView(entry: e), small: false, scheme)
                    tile(MaintenanceView(entry: e), small: false, scheme)
                }
                .padding(28)
                .background(scheme == .dark ? Color(red: 0.07, green: 0.08, blue: 0.1) : Color(red: 0.86, green: 0.88, blue: 0.92))
                .environment(\.colorScheme, scheme)
                let r = ImageRenderer(content: sheet)
                r.scale = 2
                if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: dir.appendingPathComponent("widgets-\(name)-\(scheme == .dark ? "dark" : "light").png"))
                }
            }
        }
        print("ok \(live.failure ?? "live")")
    }

    @MainActor static func tile<V: View>(_ v: V, small: Bool, _ scheme: ColorScheme) -> some View {
        let p = Palette(scheme, .fullColor)
        return v
            .padding(16)
            .frame(width: small ? 170 : 364, height: 170)
            .background(p.bg)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(scheme == .dark ? 0.08 : 0), lineWidth: 1))
            .environment(\.colorScheme, scheme)
    }
}
