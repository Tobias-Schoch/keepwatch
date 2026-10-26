import { useEffect } from "react";
import { EVERY, usePoll } from "./api";
import { UpdateHint } from "./common";
import { LightRays } from "./design/Backdrop";
import { useEdgeLight } from "./design/fx";
import { Shell } from "./design/Shell";
import { Toasts } from "./design/Toasts";
import { LogsHost } from "./logs/LogsSheet";
import { MessagesProvider } from "./messages";
import { NavProvider, useNav, type View } from "./nav";
import { PaletteHost } from "./palette/Palette";
import { BackupsPage } from "./pages/Backups";
import { OverviewPage } from "./pages/Overview";
import { SecurityPage } from "./pages/Security";
import { SettingsPage } from "./pages/Settings";
import { TouchIdPrompt } from "./pages/TouchId";
import { ServicesPage } from "./pages/Services";
import { TimelinePage } from "./pages/Timeline";
import type { Overview } from "./types";
import { useConfig } from "./config";
import "./design/obsidian.css";
import "./design/variants.css";
import "./dash.css";

/**
 * Keepwatch dashboard, design "Obsidian Graphite".
 * No login: it only listens on 127.0.0.1 of the server, so you reach it through an SSH tunnel
 * (`./keepwatch tunnel`, the macOS app or `ssh -L`) – your SSH key is the login.
 */
export default function App() {
  useEdgeLight();
  useEffect(() => {
    const onVis = () => document.documentElement.toggleAttribute("data-o-hidden", document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const overview = usePoll<Overview>("/api/overview", EVERY.overview);
  const { passkey } = useConfig();

  return (
    <MessagesProvider>
      <NavProvider overview={overview.data} overviewError={overview.error} overviewAt={overview.at}>
        <LightRays />
        <Shell>
          <Page />
        </Shell>
        <LogsHost />
        <PaletteHost />
        <Toasts />
        {passkey && <TouchIdPrompt />}
        <UpdateHint />
      </NavProvider>
    </MessagesProvider>
  );
}

const PAGES: Record<View, () => JSX.Element> = {
  overview: OverviewPage,
  services: ServicesPage,
  backups: BackupsPage,
  security: SecurityPage,
  settings: SettingsPage,
  timeline: TimelinePage,
};

function Page() {
  const { view } = useNav();
  const P = PAGES[view];
  return <P />;
}
