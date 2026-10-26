import SwiftUI
import WidgetKit

// Widget extension of the Keepwatch app (io.github.keepwatch.desktop.widgets).
// Reads the snapshot the app fetches through its tunnel about every 15 min; the app triggers a
// reload after each new snapshot (at most every 5 min). Without the app: "App not running · as of ...".

struct ServerProvider: TimelineProvider {
    func placeholder(in context: Context) -> ServerEntry { .sample() }

    func getSnapshot(in context: Context, completion: @escaping (ServerEntry) -> Void) {
        // Gallery: a sample, otherwise the last known snapshot (fast, no network).
        if context.isPreview, Shared.read(ServerSnapshot.self, ServerSnapshot.file) == nil {
            return completion(.sample())
        }
        Task {
            let r = await Loader.shared.load()
            completion(ServerEntry(date: Date(), snapshot: r.snapshot, mac: MacBackupState.load(), failure: r.failure))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ServerEntry>) -> Void) {
        Task {
            let r = await Loader.shared.load()
            let now = Date()
            let mac = MacBackupState.load()
            var entries = [ServerEntry(date: now, snapshot: r.snapshot, mac: mac, failure: r.failure)]
            // After midnight "today"/"yesterday" are right immediately, even without a new fetch.
            let next = now.addingTimeInterval(r.failure == nil ? 15 * 60 : 5 * 60)
            if let midnight = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now)),
               midnight < next {
                entries.append(ServerEntry(date: midnight.addingTimeInterval(1), snapshot: r.snapshot, mac: mac, failure: r.failure))
            }
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }
}

struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "status", provider: ServerProvider()) { StatusView(entry: $0) }
            .configurationDisplayName("Status")
            .description("One sentence about your server: all good, or the most important problem.")
            .supportedFamilies([.systemSmall])
    }
}

struct AttacksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "attacks", provider: ServerProvider()) { AttacksView(entry: $0) }
            .configurationDisplayName("Attacks")
            .description("SSH attempts today, and how many came from addresses banned today.")
            .supportedFamilies([.systemSmall])
    }
}

struct ServicesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "services", provider: ServerProvider()) { ServicesView(entry: $0) }
            .configurationDisplayName("Services")
            .description("One line per service. Only what deviates is colored.")
            .supportedFamilies([.systemMedium])
    }
}

struct MaintenanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "maintenance", provider: ServerProvider()) { MaintenanceView(entry: $0) }
            .configurationDisplayName("Backup & Maintenance")
            .description("Last backup, copy on this Mac, updates and certificates.")
            .supportedFamilies([.systemMedium])
    }
}

@main
struct KeepwatchWidgets: WidgetBundle {
    var body: some Widget {
        StatusWidget()
        AttacksWidget()
        ServicesWidget()
        MaintenanceWidget()
    }
}
