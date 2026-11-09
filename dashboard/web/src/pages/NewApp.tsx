import { ArrowLeft, Check, GitBranch, Layers, RefreshCw, Rocket } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, MOCK, refreshAll } from "../api";
import { Button, Callout, cx, DialogHead, Field, Overlay, useCloseOverlay } from "../design/ui";
import type { AppWizardData, HostJob, NewAppBody } from "../hosts";
import { normalize } from "../ip";
import { useNav } from "../nav";
import { AccessStep, DomainStep, JobRun, looksLikeDomain, NpmMissing, useDomainCheck, type Row } from "./NewSite";
import { openSetting } from "./settingsOpen";
import "./newsite.css";

/**
 * "New app": one form from a Git repository to a live site (server/apps.py).
 * Portainer deploys the stack, then the proxy host and certificate follow, with live progress.
 * Everything the backend can work out itself (stack name, container, port) sits under Advanced.
 */

const REPO = /^https:\/\/[^\s/@:]+(:\d{1,5})?\/[^\s@?#]+$/;

function repoName(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
}

export function NewAppWizard({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<AppWizardData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const { domain, setDomain, www, setWww, checking, cur, curErr, runCheck } = useDomainCheck();

  const [mode, setMode] = useState<"open" | "list">("open");
  const [rows, setRows] = useState<Row[]>([]);
  const [prefilled, setPrefilled] = useState(false);
  const nextKey = useRef(1);

  const [branch, setBranch] = useState("main");
  const [composeFile, setComposeFile] = useState("docker-compose.yml");
  const [stackName, setStackName] = useState("");
  const [gitUsername, setGitUsername] = useState("");
  const [container, setContainer] = useState("");
  const [port, setPort] = useState("");

  const [job, setJob] = useState<HostJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<AppWizardData>("/api/apps/new");
      setData(d);
      setLoadError(null);
      // Start with the addresses your other sites already allow: a new app is then closed to the rest by default.
      const entries = d.ipLists.flatMap((l) => l.entries.map((e) => ({ value: normalize(e.value), note: e.note || (l.named ? l.name : "") })));
      if (entries.length) {
        const unique = [...new Map(entries.map((e) => [e.value, e])).values()];
        setRows((rs) => (rs.length ? rs : unique.map((e) => ({ key: nextKey.current++, value: e.value, note: e.note }))));
        setMode("list");
        setPrefilled(true);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const repoOk = REPO.test(repo.trim());
  const portOk = port === "" || (Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535);
  const nameOk = stackName === "" || /^[a-z0-9][a-z0-9_-]{0,62}$/.test(stackName);
  const accessOk = mode === "open" || rows.length > 0;
  const connected = !!data?.npm.connected && !!data?.portainer.connected;
  const canStart = connected && repoOk && !!cur?.ok && accessOk && portOk && nameOk && !!branch.trim() && !!composeFile.trim();

  const missing = !repoOk ? "Enter the repository" : !cur?.ok ? "Enter a domain that points to this server" : !accessOk ? "Add at least one address" : null;

  const running = job?.state === "running" || starting;

  const start = async () => {
    if (!cur || !canStart) return;
    const body: NewAppBody = {
      repoUrl: repo.trim(),
      branch: branch.trim(),
      composeFile: composeFile.trim(),
      stackName: stackName.trim(),
      gitUsername: gitUsername.trim(),
      gitToken: token.trim(),
      container: container.trim(),
      port: port ? Number(port) : null,
      domain: cur.domain,
      www,
      access: { mode, entries: mode === "list" ? rows.map((r) => ({ value: normalize(r.value), note: r.note.trim() })) : [] },
    };
    setStarting(true);
    setStartErr(null);
    setJob(null);
    try {
      const r = await api.post<{ ok: true; job: string }>("/api/apps", body);
      setJob(await api.get<HostJob>(`/api/apps/jobs/${r.job}`));
    } catch (e) {
      setStartErr(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = setTimeout(async () => {
      try {
        setJob(await api.get<HostJob>(`/api/apps/jobs/${job.id}`));
      } catch (e) {
        setStartErr(e instanceof Error ? e.message : String(e));
      }
    }, 900);
    return () => clearTimeout(t);
  }, [job]);

  useEffect(() => {
    if (job && job.state !== "running") refreshAll();
  }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Overlay onClose={onClose} label="New app" size="xl" align="top" className="ns-dialog" onEscape={() => running}>
      <DialogHead icon={Rocket} title="New app" sub="Enter a repository and a domain. Keepwatch does the rest." />
      <div className="o-dialog-scroll">
        <div className="o-dialog-body ns-body">
          {loadError ? (
            <Callout tone="rose" title="Couldn't load the form" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
              {loadError}
            </Callout>
          ) : !data ? (
            <div className="o-empty !py-10">Loading…</div>
          ) : job ? (
            <div className="flex flex-col gap-4">
              {startErr && (
                <Callout tone="rose" title="Lost contact with the job">
                  {startErr}
                </Callout>
              )}
              <JobRun job={job} stack={job.stack} />
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {!data.npm.connected && <NpmMissing npm={data.npm} />}
              {!data.portainer.connected && <PortainerMissing reason={data.portainer.reason} />}

              <section className="flex flex-col gap-4">
                <h3 className="o-micro">Repository</h3>
                <Field
                  label="Git address"
                  htmlFor="na-repo"
                  error={repo && !repoOk ? "An https:// address without a login in it, e.g. https://github.com/you/app" : undefined}
                  hint={repoOk ? `Becomes the stack ${stackName || repoName(repo)}.` : "The repository needs a compose file."}
                >
                  <input
                    id="na-repo"
                    data-autofocus
                    className={cx("o-input d-mono", repo && !repoOk && "is-bad")}
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="https://github.com/you/app"
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                  />
                </Field>
                <Field label="Access token" htmlFor="na-token" aside="only for private repositories" hint="Read access is enough. Portainer stores it for later redeploys, Keepwatch does not.">
                  <input id="na-token" type="password" className="o-input d-mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" spellCheck={false} />
                </Field>
              </section>

              <section className="flex flex-col gap-4">
                <h3 className="o-micro">Domain</h3>
                <DomainStep domain={domain} setDomain={setDomain} www={www} setWww={setWww} checking={checking} res={cur} err={curErr} onRecheck={() => looksLikeDomain(domain) && void runCheck(domain, www)} onEnter={() => void start()} />
              </section>

              <section className="flex flex-col gap-4">
                <h3 className="o-micro">Who can open it</h3>
                {prefilled && mode === "list" && <p className="o-hint !mt-0">Filled in with the addresses your other sites allow. Change them as you like.</p>}
                <AccessStep
                  data={data}
                  mode={mode}
                  setMode={setMode}
                  rows={rows}
                  add={(value, note) => {
                    if (rows.some((r) => normalize(r.value) === normalize(value))) return false;
                    setRows((rs) => [...rs, { key: nextKey.current++, value: normalize(value), note }]);
                    return true;
                  }}
                  remove={(values) => setRows((rs) => rs.filter((r) => !values.includes(normalize(r.value))))}
                  setNote={(k, note) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, note } : r)))}
                />
              </section>

              <details className="ns-advanced">
                <summary>Advanced</summary>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Branch" htmlFor="na-branch">
                    <input id="na-branch" className="o-input d-mono" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label="Compose file" htmlFor="na-file">
                    <input id="na-file" className="o-input d-mono" value={composeFile} onChange={(e) => setComposeFile(e.target.value)} spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label="Stack name" htmlFor="na-name" error={nameOk ? undefined : "Lowercase letters, digits, - and _"} hint="Empty: from the repository.">
                    <input id="na-name" className={cx("o-input d-mono", !nameOk && "is-bad")} value={stackName} onChange={(e) => setStackName(e.target.value)} placeholder={repoOk ? repoName(repo) : ""} spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label="Git user" htmlFor="na-user" hint="Only if your Git host requires the real name.">
                    <input id="na-user" className="o-input d-mono" value={gitUsername} onChange={(e) => setGitUsername(e.target.value)} placeholder="git" spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label="Container" htmlFor="na-container" hint="Empty: chosen automatically.">
                    <input id="na-container" className="o-input d-mono" value={container} onChange={(e) => setContainer(e.target.value)} spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label="Port in the container" htmlFor="na-port" error={portOk ? undefined : "A number from 1 to 65535"} hint="Empty: the port the app listens on.">
                    <input id="na-port" className={cx("o-input d-mono", !portOk && "is-bad")} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" autoComplete="off" />
                  </Field>
                </div>
              </details>

              {MOCK && <p className="ns-mock">Mock: a repository containing <b>fail</b> fails to deploy and is rolled back. Anything else works.</p>}
              {startErr && (
                <Callout tone="rose" title="Not deployed">
                  {startErr}
                </Callout>
              )}
            </div>
          )}
        </div>
      </div>
      <Foot job={job} running={running} canStart={canStart} hint={connected ? missing : "Connect Portainer and the Proxy Manager first"} onStart={() => void start()} onBack={() => setJob(null)} />
    </Overlay>
  );
}

function PortainerMissing({ reason }: { reason: string | null }) {
  const { go } = useNav();
  const close = useCloseOverlay();
  return (
    <Callout
      tone="sand"
      icon={Layers}
      title="Portainer isn't connected"
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            close(() => {
              go("settings");
              openSetting("portainer");
            })
          }
        >
          Open setting
        </Button>
      }
    >
      {reason ?? "Without a Portainer token nothing can be deployed."}
    </Callout>
  );
}

function Foot({ job, running, canStart, hint, onStart, onBack }: { job: HostJob | null; running: boolean; canStart: boolean; hint: string | null; onStart: () => void; onBack: () => void }) {
  const close = useCloseOverlay();
  return (
    <div className="o-dialog-foot">
      <span className="o-hint mr-auto">{job?.state === "running" ? "Deploying – keep this open…" : !job && !canStart ? hint : null}</span>
      {job?.state === "done" ? (
        <Button variant="primary" onClick={() => close()}>
          <Check className="h-4 w-4" /> Done
        </Button>
      ) : job?.state === "failed" ? (
        <>
          <Button variant="ghost" onClick={() => close()}>
            Close
          </Button>
          <Button variant="secondary" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back to the form
          </Button>
        </>
      ) : (
        <Button variant="primary" onClick={onStart} disabled={!canStart || running}>
          {running ? <RefreshCw className="h-4 w-4 o-spin" /> : <GitBranch className="h-4 w-4" />}
          {running ? "Deploying…" : "Deploy"}
        </Button>
      )}
    </div>
  );
}
