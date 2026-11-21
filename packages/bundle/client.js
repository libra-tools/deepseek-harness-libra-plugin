globalThis.__ModuleLoader__.load({
  id: "@libra-tools/dsh-bundle",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "libra.settings";

    const en = {
      summaryEmpty: "Libra bridge is not configured.",
      summaryReady: "Libra binary {binary}",
      title: "Libra bridge",
      intro: "These values are deployment settings. The model cannot see or change the binary path. A new binary or repository is used on the next bridge request. Outbox directory, context injection, lease, and memory budget apply when the plugin loads.",
      binary: "Libra binary",
      binaryHint: "Absolute path, relative path, or a name on PATH. Empty leaves the plugin inactive.",
      repository: "Repository root",
      repositoryHint: "Libra-initialized worktree. Empty uses LIBRA_REPO or the working directory.",
      outbox: "Outbox directory",
      outboxHint: "Durable session-event outbox outside the repository. Empty uses $DSH_HOME/libra/outbox.",
      inject: "Inject repository context on the first turn",
      lease: "Workspace lease (ms)",
      budget: "Memory token budget",
      budgetHint: "0 lets Libra choose the budget. A positive value is sent to memory.recall; this plugin does not cut the returned text.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved. Binary and repository changes apply on the next bridge request.",
      failed: "Could not save these settings.",
      unavailable: "Settings are unavailable in this profile. Set libraExecutable in the bundle configuration instead.",
      panelTitle: "Libra",
      panelGuideTitle: "Libra version control",
      panelGuideDescription: "Repository status, bounded diffs, commit history and bridge diagnostics for this Session.",
      panelLoading: "Loading…",
      panelRefresh: "Refresh",
      panelUnbound: "This Session is not bound to a Libra repository. Open a Session whose working directory is inside a Libra worktree.",
      panelNotRepository: "This Session's directory is not a Libra repository.",
      panelUnsupported: "This Libra build does not support the read methods this panel needs.",
      panelDisconnected: "The Libra bridge for this repository is unavailable right now.",
      panelMoved: "This Session moved to another worktree. Open it again in the intended repository.",
      panelError: "Could not read this repository.",
      panelEmpty: "Nothing to show.",
      statusTitle: "Changes",
      statusStaged: "Staged",
      statusUnstaged: "Unstaged",
      statusUntracked: "Untracked",
      statusRename: "Renamed",
      statusConflict: "Conflicts",
      statusFile: "File",
      statusSelectHint: "Select a file to see its diff.",
      statusMore: "Load more changes",
      diffTitle: "Diff",
      diffSides: "Side",
      diffSidesWorktree: "Worktree vs index",
      diffSidesIndex: "Index vs HEAD",
      diffSidesOid: "Worktree vs commit",
      diffBinary: "Binary file — no patch is shown.",
      diffTruncated: "Truncated: {reason}",
      diffEmpty: "No patch in this diff.",
      historyTitle: "History",
      historyCommit: "Commit",
      historyMore: "Load more",
      historyFiles: "Files in this commit",
      historyNoFiles: "This commit has no file changes.",
      detailMore: "Load more files",
      detailTitle: "Commit detail",
      diagTitle: "Bridge diagnostics",
      diagShow: "Show",
      diagHide: "Hide",
      diagUnavailable: "No live bridge evidence for this Session.",
      diagExecutable: "Executable",
      diagExecutableHash: "Executable SHA-256",
      diagPid: "Child PID",
      diagProtocol: "Protocol",
      diagMethods: "Negotiated methods",
      diagBundleDir: "Bundle package directory",
      diagBundleEntry: "Bundle entry",
      diagBundleHash: "Bundle entry SHA-256",
      diagWorktree: "Worktree id",
      diagBranch: "Branch",
      diagHead: "HEAD",
      diagSessions: "Sessions on this bridge",
      diagEmptyBranch: "unborn",
    };
    const zh = {
      summaryEmpty: "尚未配置 Libra bridge。",
      summaryReady: "Libra 二进制 {binary}",
      title: "Libra bridge",
      intro: "这些是部署设置。模型看不到、也不能改二进制路径。新的二进制或仓库会在下一次 bridge 请求时生效。outbox 目录、上下文注入、租约和记忆预算在插件加载时生效。",
      binary: "Libra 二进制",
      binaryHint: "绝对路径、相对路径，或 PATH 上的命令名。留空则插件不激活。",
      repository: "仓库根目录",
      repositoryHint: "已 libra init 的工作树。留空则使用 LIBRA_REPO 或当前工作目录。",
      outbox: "Outbox 目录",
      outboxHint: "放在仓库外的会话事件 outbox。留空则使用 $DSH_HOME/libra/outbox。",
      inject: "在第一轮注入仓库上下文",
      lease: "工作区租约（毫秒）",
      budget: "记忆 token 预算",
      budgetHint: "0 表示由 Libra 决定预算。正数会传给 memory.recall；本插件不会再截断返回的正文。",
      save: "保存",
      saving: "正在保存…",
      saved: "已保存。二进制和仓库会在下一次 bridge 请求时生效。",
      failed: "无法保存这些设置。",
      unavailable: "当前配置档没有设置服务。请改为在插件配置里填写 libraExecutable。",
      panelTitle: "Libra",
      panelGuideTitle: "Libra 版本控制",
      panelGuideDescription: "本会话的仓库状态、有界 diff、提交历史和 bridge 诊断。",
      panelLoading: "正在加载…",
      panelRefresh: "刷新",
      panelUnbound: "本会话尚未绑定 Libra 仓库。请在 Libra 工作树内的工作目录中打开会话。",
      panelNotRepository: "本会话的目录不是 Libra 仓库。",
      panelUnsupported: "当前 Libra 版本不支持本面板所需的只读方法。",
      panelDisconnected: "该仓库的 Libra bridge 当前不可用。",
      panelMoved: "本会话已移动到其他工作树。请在目标仓库中重新打开。",
      panelError: "无法读取该仓库。",
      panelEmpty: "暂无内容。",
      statusTitle: "变更",
      statusStaged: "已暂存",
      statusUnstaged: "未暂存",
      statusUntracked: "未跟踪",
      statusRename: "重命名",
      statusConflict: "冲突",
      statusFile: "文件",
      statusSelectHint: "选择文件以查看 diff。",
      statusMore: "加载更多变更",
      diffTitle: "Diff",
      diffSides: "比较侧",
      diffSidesWorktree: "工作树 vs 索引",
      diffSidesIndex: "索引 vs HEAD",
      diffSidesOid: "工作树 vs 提交",
      diffBinary: "二进制文件，不显示 patch。",
      diffTruncated: "已截断：{reason}",
      diffEmpty: "本次 diff 没有 patch。",
      historyTitle: "历史",
      historyCommit: "提交",
      historyMore: "加载更多",
      historyFiles: "该提交的文件",
      historyNoFiles: "该提交没有文件变更。",
      detailMore: "加载更多文件",
      detailTitle: "提交详情",
      diagTitle: "Bridge 诊断",
      diagShow: "显示",
      diagHide: "隐藏",
      diagUnavailable: "本会话没有运行中的 bridge 证据。",
      diagExecutable: "可执行文件",
      diagExecutableHash: "可执行文件 SHA-256",
      diagPid: "子进程 PID",
      diagProtocol: "协议",
      diagMethods: "已协商方法",
      diagBundleDir: "Bundle 包目录",
      diagBundleEntry: "Bundle 入口",
      diagBundleHash: "Bundle 入口 SHA-256",
      diagWorktree: "工作树 id",
      diagBranch: "分支",
      diagHead: "HEAD",
      diagSessions: "该 bridge 上的会话数",
      diagEmptyBranch: "unborn",
    };

    function fieldStyle() {
      return {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginBottom: 12,
        color: "inherit",
        font: "inherit",
      };
    }

    function Settings(props) {
      const form = props.formApi;
      const t = props.t;
      const snap = React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      );
      const value = snap.value ?? {};
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState("");
      const shown = draft ?? {
        libraExecutable: value.libraExecutable ?? "",
        repositoryRoot: value.repositoryRoot ?? "",
        outboxRoot: value.outboxRoot ?? "",
        injectContext: value.injectContext !== false,
        workspaceLeaseTtlMs: value.workspaceLeaseTtlMs ?? 30000,
        memoryTokenBudget: value.memoryTokenBudget ?? 0,
      };
      const set = (key, next) => setDraft({ ...shown, [key]: next });
      const save = () => {
        setStatus("saving");
        const ops = [
          ["libraExecutable", shown.libraExecutable],
          ["repositoryRoot", shown.repositoryRoot],
          ["outboxRoot", shown.outboxRoot],
          ["injectContext", shown.injectContext],
          ["workspaceLeaseTtlMs", Number(shown.workspaceLeaseTtlMs)],
          ["memoryTokenBudget", Number(shown.memoryTokenBudget)],
        ].map(([path, fieldValue]) => ({ op: "set", path: [path], value: fieldValue }));
        form.mutate(ops, snap.revision).then((ok) => {
          setStatus(ok ? "saved" : "failed");
          if (ok) setDraft(null);
        }, () => setStatus("failed"));
      };
      if (props.view === "summary") {
        const binary = typeof value.libraExecutable === "string" ? value.libraExecutable.trim() : "";
        return binary ? t("summaryReady", { binary }) : t("summaryEmpty");
      }
      if (snap.status === "unavailable") return h("p", null, t("unavailable"));
      return h("form", {
        onSubmit: (event) => {
          event.preventDefault();
          save();
        },
      },
      h("p", { style: { marginTop: 0 } }, t("intro")),
      textField(t, "binary", "binaryHint", shown.libraExecutable, (next) => set("libraExecutable", next)),
      textField(t, "repository", "repositoryHint", shown.repositoryRoot, (next) => set("repositoryRoot", next)),
      textField(t, "outbox", "outboxHint", shown.outboxRoot, (next) => set("outboxRoot", next)),
      h("label", { style: fieldStyle() },
        h("span", null, h("input", {
          type: "checkbox",
          checked: shown.injectContext === true,
          onChange: (event) => set("injectContext", event.target.checked),
        }), " ", t("inject"))),
      numberField(t, "lease", shown.workspaceLeaseTtlMs, (next) => set("workspaceLeaseTtlMs", next)),
      numberField(t, "budget", shown.memoryTokenBudget, (next) => set("memoryTokenBudget", next), "budgetHint"),
      h("button", { type: "submit", disabled: snap.writable === false || status === "saving" }, status === "saving" ? t("saving") : t("save")),
      status === "saved" || status === "failed" ? h("p", { role: "status" }, t(status)) : null);
    }

    function textField(t, label, hint, value, onChange) {
      return h("label", { style: fieldStyle() },
        t(label),
        h("input", {
          value: value ?? "",
          onChange: (event) => onChange(event.target.value),
          style: { font: "inherit", color: "inherit", background: "transparent" },
        }),
        hint ? h("small", null, t(hint)) : null);
    }

    function numberField(t, label, value, onChange, hint) {
      return h("label", { style: fieldStyle() },
        t(label),
        h("input", {
          type: "number",
          value: value ?? 0,
          onChange: (event) => onChange(event.target.value),
          style: { font: "inherit", color: "inherit", background: "transparent" },
        }),
        hint ? h("small", null, t(hint)) : null);
    }


    const TAB_ID = "@libra-tools/dsh-bundle/version-control";
    const TAB_KIND = "libra-version-control";
    const PANEL_STATUS_GROUPS = [
      ["conflict", "statusConflict"],
      ["rename", "statusRename"],
      ["staged", "statusStaged"],
      ["unstaged", "statusUnstaged"],
      ["untracked", "statusUntracked"],
    ];

    /** Group status entries for display; unknown states stay visible under their raw name. */
    function groupStatusEntries(entries) {
      const groups = [];
      for (const [state, labelKey] of PANEL_STATUS_GROUPS) {
        const rows = entries.filter((entry) => entry.state === state);
        if (rows.length > 0) groups.push({ state, labelKey, rows });
      }
      const known = new Set(PANEL_STATUS_GROUPS.map(([state]) => state));
      const rest = entries.filter((entry) => !known.has(entry.state));
      if (rest.length > 0) groups.push({ state: "other", labelKey: "statusFile", rows: rest });
      return groups;
    }

    /** Which comparison sides a status entry's diff names. */
    function sidesForState(state) {
      if (state === "staged") return "index-vs-head";
      if (state === "rename") return "index-vs-head";
      return "worktree-vs-index";
    }

    function sidesLabelKey(sides) {
      if (sides === "index-vs-head") return "diffSidesIndex";
      if (sides === "worktree-vs-oid") return "diffSidesOid";
      return "diffSidesWorktree";
    }

    /** Map a typed Host failure onto the panel's explicit state. */
    function failureState(result) {
      if (result === undefined || result.ok !== false) return { state: "ok" };
      switch (result.error.kind) {
        case "no_working_directory": return { state: "unbound", key: "panelUnbound" };
        case "not_a_repository": return { state: "not_repo", key: "panelNotRepository" };
        case "cwd_changed": return { state: "moved", key: "panelMoved" };
        case "unsupported_capability":
        case "protocol_mismatch":
          return { state: "unsupported", key: "panelUnsupported" };
        case "bridge_unavailable":
        case "disconnected":
          return { state: "disconnected", key: "panelDisconnected" };
        case "cancelled": return { state: "cancelled", key: "panelLoading" };
        default: return { state: "error", key: "panelError" };
      }
    }

    function mergeHistory(previous, page) {
      return {
        commits: previous.commits.concat(page.commits),
        next: page.cursor.next,
      };
    }

    function describeCommit(commit) {
      return { label: `${commit.oid.slice(0, 8)} ${commit.summary}`, oid: commit.oid };
    }

    function describeEvidence(evidence) {
      if (evidence === undefined || evidence.ok !== true) return { available: false };
      const data = evidence.data;
      return {
        available: true,
        worktreeId: data.identity.worktreeId,
        branch: data.identity.branch,
        head: data.identity.headOid,
        unborn: data.identity.unborn,
        bindingKey: data.bindingKey,
        sessionCount: data.sessionCount,
        executable: data.evidence.executable,
        executableSha256: data.evidence.executableSha256,
        childPid: data.evidence.childPid,
        protocol: `${data.evidence.initialize.protocol.major}.${data.evidence.initialize.protocol.minor}`,
        methods: data.evidence.initialize.methods,
        bundlePackageDir: data.evidence.bundlePackageDir,
        bundleEntryPath: data.evidence.bundleEntryPath,
        bundleEntrySha256: data.evidence.bundleEntrySha256,
      };
    }

    function panelButton(label, onClick, disabled) {
      return h("button", {
        type: "button",
        onClick,
        disabled: disabled === true,
        style: {
          font: "inherit", color: "inherit", background: "transparent",
          border: "1px solid currentColor", borderRadius: 4, padding: "2px 8px", cursor: "pointer",
        },
      }, label);
    }

    function sectionHeading(title) {
      return h("h3", { style: { margin: "12px 0 6px", fontSize: "1em" } }, title);
    }

    function statusGroupRow(group, selected, onOpen, t) {
      const items = group.rows.map((entry) => h("li", { key: `${entry.state}:${entry.path}` },
        h("button", {
          type: "button",
          onClick: () => onOpen(entry),
          "aria-pressed": selected !== null && selected.path === entry.path,
          style: {
            font: "inherit", color: "inherit", background: "transparent", border: "none",
            padding: 0, cursor: "pointer", textAlign: "start",
          },
        }, entry.oldPath === null || entry.oldPath === undefined
          ? entry.path
          : `${entry.oldPath} → ${entry.path}`)));
      return h("div", { key: group.state },
        h("div", { style: { opacity: 0.8 } }, `${t(group.labelKey)} (${group.rows.length})`),
        h("ul", { style: { margin: "2px 0 0", paddingInlineStart: 16 } }, items));
    }

    function diffSection(diff, t) {
      if (diff === null) return null;
      const file = diff.files.length > 0 ? diff.files[0] : null;
      let body;
      if (file === null) {
        body = h("p", null, t("diffEmpty"));
      } else {
        const patch = file.patch === null
          ? h("p", null, file.truncation === "binary" ? t("diffBinary") : t("diffEmpty"))
          : h("pre", { style: { whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 } }, file.patch);
        const notice = file.truncated
          ? h("p", { role: "note" }, t("diffTruncated", { reason: file.truncation }))
          : null;
        body = h("div", null,
          h("div", { style: { fontFamily: "monospace" } }, file.path),
          patch,
          notice);
      }
      return h("div", null,
        sectionHeading(t("diffTitle")),
        h("div", { style: { opacity: 0.8 } }, `${t("diffSides")}: ${t(sidesLabelKey(diff.sides))}`),
        body);
    }

    function historySection(history, detail, t, onMore, onCommit, onMoreFiles) {
      const commitItems = history.commits.map((commit) => h("li", { key: commit.oid },
        h("button", {
          type: "button",
          onClick: () => onCommit(commit.oid),
          style: {
            font: "inherit", color: "inherit", background: "transparent",
            border: "none", padding: 0, cursor: "pointer", textAlign: "start",
          },
        }, describeCommit(commit).label)));
      const list = history.commits.length === 0
        ? h("p", null, t("panelEmpty"))
        : h("ul", { style: { margin: 0, paddingInlineStart: 16 } }, commitItems);
      const more = history.next === null
        ? null
        : panelButton(t("historyMore"), () => onMore(history.next), history.loading);
      const moreFiles = detail === null || detail.next === null
        ? null
        : panelButton(t("detailMore"), () => onMoreFiles(detail.next), false);
      let detailBody = null;
      if (detail !== null) {
        const files = detail.files.map((file) => h("li", { key: `${file.state}:${file.path}` },
          file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`));
        detailBody = h("div", { style: { marginTop: 8 } },
          sectionHeading(t("detailTitle")),
          h("div", { style: { fontFamily: "monospace" } }, detail.oid),
          h("div", null, detail.summary),
          detail.files.length === 0
            ? h("p", null, t("historyNoFiles"))
            : h("ul", { style: { margin: "4px 0 0", paddingInlineStart: 16 } }, files));
      }
      return h("div", null, sectionHeading(t("historyTitle")), list, more, detailBody, moreFiles);
    }

    function diagnosticsSection(diagnostics, expanded, t, onToggle) {
      const rows = diagnostics.available === false ? [] : [
        [t("diagExecutable"), diagnostics.executable],
        [t("diagExecutableHash"), diagnostics.executableSha256],
        [t("diagPid"), String(diagnostics.childPid ?? "—")],
        [t("diagProtocol"), diagnostics.protocol],
        [t("diagMethods"), diagnostics.methods.join(", ")],
        [t("diagBundleDir"), diagnostics.bundlePackageDir],
        [t("diagBundleEntry"), diagnostics.bundleEntryPath],
        [t("diagBundleHash"), diagnostics.bundleEntrySha256],
        [t("diagWorktree"), diagnostics.worktreeId],
        [t("diagBranch"), diagnostics.unborn ? t("diagEmptyBranch") : String(diagnostics.branch ?? "—")],
        [t("diagHead"), diagnostics.head ?? "—"],
        [t("diagSessions"), String(diagnostics.sessionCount)],
      ];
      let body = null;
      if (expanded) {
        const pairs = rows.map(([label, value]) => h("div", {
          key: label,
          style: { display: "contents" },
        },
        h("dt", null, label),
        h("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, value)));
        body = diagnostics.available === false
          ? h("p", null, t("diagUnavailable"))
          : h("dl", {
            style: {
              margin: "6px 0 0", display: "grid", gridTemplateColumns: "minmax(120px, auto) 1fr",
              gap: 4, fontFamily: "monospace", fontSize: "0.85em",
            },
          }, pairs);
      }
      return h("div", null,
        sectionHeading(t("diagTitle")),
        panelButton(expanded ? t("diagHide") : t("diagShow"), onToggle),
        body);
    }

    const BINDING_FAILURES = new Set(["unbound", "not_repo", "moved", "unsupported", "disconnected"]);

    function LibraPanel(props) {
      const t = props.t;
      const libra = props.libra;
      const evidenceClient = props.evidence;
      const tab = props.useTabInfo();
      const [binding, setBinding] = React.useState(null);
      const [status, setStatus] = React.useState({ entries: [], next: null });
      const [statusLoading, setStatusLoading] = React.useState(false);
      const [history, setHistory] = React.useState({ commits: [], next: null, loading: false });
      const [selected, setSelected] = React.useState(null);
      const [diff, setDiff] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [errors, setErrors] = React.useState({});
      const [verifying, setVerifying] = React.useState(false);
      const [validationFailed, setValidationFailed] = React.useState(false);
      const visibleBefore = React.useRef(tab.tab.visible);
      const [diagnostics, setDiagnostics] = React.useState({ available: false });
      const [expanded, setExpanded] = React.useState(false);
      const channels = React.useRef(new Map());
      const sequence = React.useRef(0);

      const abortChannel = (channel) => {
        const controller = channels.current.get(channel);
        if (controller !== undefined) controller.abort();
        channels.current.delete(channel);
      };
      const abortAll = () => {
        for (const controller of channels.current.values()) controller.abort();
        channels.current.clear();
      };

      // Each channel (status, history, diff, story) has its own single-flight
      // request, so starting one read never cancels another channel's page.
      const run = (channel, call) => {
        abortChannel(channel);
        const controller = new globalThis.AbortController();
        channels.current.set(channel, controller);
        sequence.current += 1;
        const mine = sequence.current;
        const abortFromTab = () => controller.abort();
        if (tab.tab.signal.aborted) controller.abort();
        else tab.tab.signal.addEventListener("abort", abortFromTab, { once: true });
        return Promise.resolve()
          .then(() => call(controller.signal, `panel-${channel}-${mine}`))
          .then(
            (result) => (channels.current.get(channel) === controller ? result : { stale: true }),
            (error) => (controller.signal.aborted
              ? { cancelled: true }
              : { ok: false, error: { kind: "internal", message: String(error) } }),
          );
      };
      const fail = (view, channel) => {
        if (BINDING_FAILURES.has(view.state)) {
          abortAll();
          diagnosticsGeneration.current += 1;
          setBinding(view);
          setDiagnostics({ available: false });
          setStatus({ entries: [], next: null });
          setHistory({ commits: [], next: null, loading: false });
          setSelected(null);
          setDiff(null);
          setDetail(null);
          return true;
        }
        setErrors((current) => ({ ...current, [channel]: view.key ?? "panelError" }));
        return false;
      };
      const succeed = (channel) => setErrors((current) => {
        if (current[channel] === undefined) return current;
        const next = { ...current };
        delete next[channel];
        return next;
      });

      const loadStatus = (cursor) => {
        setStatusLoading(true);
        return run("status", (signal, requestId) => libra.call("status", cursor === null ? {} : { cursor }, requestId, signal))
          .then((result) => {
            setStatusLoading(false);
            if (result.stale === true || result.cancelled === true) return;
            const view = failureState(result);
            if (view.state !== "ok") { fail(view, "status"); return; }
            succeed("status");
            noteReadBinding(result.data);
            setStatus((current) => ({
              entries: cursor === null ? result.data.entries : current.entries.concat(result.data.entries),
              next: result.data.cursor.next,
            }));
          });
      };

      const loadHistory = (cursor) => {
        setHistory((current) => ({ ...current, loading: true }));
        return run("history", (signal, requestId) => libra.call("log", cursor === null ? {} : { cursor }, requestId, signal))
          .then((result) => {
            if (result.stale === true || result.cancelled === true) return;
            const view = failureState(result);
            if (view.state !== "ok") { fail(view, "history"); return; }
            succeed("history");
            noteReadBinding(result.data);
            setHistory((current) => ({
              ...mergeHistory(cursor === null ? { commits: [], next: null } : current, result.data),
              loading: false,
            }));
          });
      };

      const diagnosticsGeneration = React.useRef(0);
      const bindingState = React.useRef({ key: null, generation: null, ok: false, initialized: false });
      const lastReadBinding = React.useRef(null);
      const lastEvidenceBinding = React.useRef(null);
      const noteReadBinding = (data) => {
        if (data === null || data === undefined || data.bindingKey === undefined) return;
        lastReadBinding.current = { key: data.bindingKey, generation: data.bindingGeneration };
      };
      const checkSequence = React.useRef(0);
      const checkBinding = () => {
        checkSequence.current += 1;
        const mine = checkSequence.current;
        return Promise.resolve()
        .then(() => libra.binding())
        .then((result) => {
          if (checkSequence.current !== mine) return;
          setValidationFailed(false);
          setVerifying(false);
          const previous = bindingState.current;
          if (result === undefined || result.ok !== true) {
            bindingState.current = { key: null, generation: null, ok: false, initialized: true };
            // A binding that used to serve this tab stopped doing so: clear it.
            if (previous.initialized && (previous.ok || previous.key !== null)) refresh();
            return;
          }
          const changed = previous.ok !== true
            || previous.key !== result.bindingKey
            || previous.generation !== result.generation;
          bindingState.current = {
            key: result.bindingKey,
            generation: result.generation,
            ok: true,
            initialized: true,
          };
          // The mount's own reads may already belong to a binding the Session
          // left before this first check completed; only reuse them when they
          // prove the same identity. Later changes always reload.
          if (previous.initialized && changed) {
            refresh();
          } else if (!previous.initialized) {
            const read = lastReadBinding.current;
            const evidenceRead = lastEvidenceBinding.current;
            const staleRead = read !== null && (read.key !== result.bindingKey || read.generation !== result.generation);
            const staleEvidence = evidenceRead !== null && evidenceRead !== result.bindingKey;
            if (staleRead || staleEvidence) refresh();
          }
        })
        .catch(() => {
          if (checkSequence.current !== mine) return;
          // A rejected identity check cannot prove the cached rows belong to
          // the current binding; fail closed until a later check succeeds.
          setValidationFailed(true);
          setVerifying(false);
        });
      };

      const loadDiagnostics = (force) => {
        diagnosticsGeneration.current += 1;
        const mine = diagnosticsGeneration.current;
        if (force !== true && binding !== null) return Promise.resolve();
        return Promise.resolve()
          .then(() => evidenceClient.session())
          .then((result) => {
            if (diagnosticsGeneration.current !== mine) return;
            if (result !== null && result !== undefined && result.ok === true) {
              lastEvidenceBinding.current = result.data.bindingKey ?? null;
            }
            setDiagnostics(describeEvidence(result));
          })
          .catch(() => {
            if (diagnosticsGeneration.current !== mine) return;
            setDiagnostics({ available: false });
          });
      };

      const refresh = () => {
        // A refresh is a new generation for every channel: late results from the
        // previous generation (including a pending commit detail) must not land.
        abortAll();
        setDiff(null);
        setDetail(null);
        setSelected(null);
        setBinding(null);
        setErrors({});
        // Old evidence describes the previous binding; hide it at once and let
        // the forced load replace it after the binding check.
        diagnosticsGeneration.current += 1;
        setDiagnostics({ available: false });
        setStatus({ entries: [], next: null });
        setHistory({ commits: [], next: null, loading: false });
        loadStatus(null);
        loadHistory(null);
        loadDiagnostics(true);
        checkBinding();
      };

      React.useEffect(() => {
        refresh();
        const release = tab.tab.actions.bindCommands({ refresh });
        const abort = () => { abortAll(); };
        tab.tab.signal.addEventListener("abort", abort, { once: true });
        return () => {
          release();
          tab.tab.signal.removeEventListener("abort", abort);
          abortAll();
        };
      }, []);

      React.useEffect(() => {
        if (!tab.tab.visible) return undefined;
        // Do not show cached rows until the binding that produced them is still
        // current; a rebind or replacement bridge while hidden must not flash.
        setVerifying(true);
        checkBinding();
        // Binding identity is control-plane data; a rebind must invalidate rows
        // even when no repository read is in progress.
        const timer = globalThis.setInterval(() => { checkBinding(); }, 5_000);
        return () => { globalThis.clearInterval(timer); };
      }, [tab.tab.visible]);

      const openDiff = (entry) => {
        const sides = sidesForState(entry.state);
        setSelected({ path: entry.path, state: entry.state, sides });
        setDiff(null);
        run("diff", (signal, requestId) => libra.call("diff", { sides, paths: [entry.path], limit: 1 }, requestId, signal))
          .then((result) => {
            if (result.stale === true || result.cancelled === true) return;
            const view = failureState(result);
            if (view.state !== "ok") { setDiff(null); fail(view, "diff"); return; }
            succeed("diff");
            noteReadBinding(result.data);
            setDiff(result.data);
          });
      };

      const openCommit = (oid) => {
        // A pending file page belongs to the previously selected commit; it
        // must not append to the commit the user just selected.
        abortChannel("detailMore");
        setDetail(null);
        run("detail", (signal, requestId) => libra.call("show", { oid, limit: 20 }, requestId, signal))
          .then((result) => {
            if (result.stale === true || result.cancelled === true) return;
            const view = failureState(result);
            if (view.state !== "ok") { setDetail(null); fail(view, "detail"); return; }
            succeed("detail");
            noteReadBinding(result.data);
            setDetail({
              oid: result.data.oid,
              summary: result.data.summary,
              files: result.data.files,
              next: result.data.cursor.next,
              loading: false,
            });
          });
      };
      const loadDetailMore = (cursor) => {
        if (detail === null) return;
        const oid = detail.oid;
        setDetail({ ...detail, loading: true });
        run("detailMore", (signal, requestId) => libra.call("show", { oid, cursor, limit: 20 }, requestId, signal))
          .then((result) => {
            if (result.stale === true || result.cancelled === true) return;
            const view = failureState(result);
            if (view.state !== "ok") { fail(view, "detailMore"); return; }
            succeed("detailMore");
            setDetail((current) => current === null || current.oid !== oid ? current : ({
              ...current,
              files: current.files.concat(result.data.files),
              next: result.data.cursor.next,
              loading: false,
            }));
          });
      };

      const becameVisible = visibleBefore.current !== tab.tab.visible;
      visibleBefore.current = tab.tab.visible;
      const visibleTransition = tab.tab.visible && becameVisible;
      const suppressCached = verifying || validationFailed || visibleTransition;
      const banner = binding === null ? null : h("p", { role: "status", style: { margin: "8px 0" } }, t(binding.key));
      const groups = groupStatusEntries(status.entries);
      const loading = binding === null && status.entries.length === 0 && history.commits.length === 0
        && errors.status === undefined && errors.history === undefined;

      return h("section", { style: { display: "flex", flexDirection: "column", gap: 6, font: "inherit", color: "inherit" } },
        h("header", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
          h("strong", null, t("panelTitle")),
          panelButton(t("panelRefresh"), refresh, false)),
        loading || verifying || visibleTransition ? h("p", { role: "status" }, t("panelLoading")) : null,
        validationFailed
          ? h("p", { role: "status", style: { margin: "8px 0" } }, t("panelError"))
          : suppressCached ? null : banner,
        suppressCached || binding !== null ? null : h("div", null,
          sectionHeading(t("statusTitle")),
          errors.status !== undefined ? h("p", { role: "status" }, t(errors.status)) : null,
          groups.length === 0 && errors.status === undefined ? h("p", null, t("panelEmpty")) : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
            groups.map((group) => statusGroupRow(group, selected, openDiff, t))),
          status.next === null ? null : panelButton(t("statusMore"), () => loadStatus(status.next), statusLoading)),
        suppressCached || binding !== null ? null : diffSection(diff, t),
        suppressCached || binding !== null ? null : h("div", null,
          sectionHeading(t("historyTitle")),
          errors.history !== undefined ? h("p", { role: "status" }, t(errors.history)) : null,
          history.commits.length === 0 ? h("p", null, t("panelEmpty")) : historySection(history, detail, t, loadHistory, openCommit, loadDetailMore)),
        suppressCached ? null : errors.detail !== undefined ? h("p", { role: "status" }, t(errors.detail)) : null,
        suppressCached ? null : diagnosticsSection(diagnostics, expanded, t, () => { const next = !expanded; setExpanded(next); if (next) loadDiagnostics(); }));
    }

    function LibraTitle(props) {
      return props.t("panelTitle");
    }

    function remoteCaller(remote, sessionId) {
      return {
        call(method, params, requestId, signal) {
          return remote.libraVcs[method](sessionId, params, requestId, signal);
        },
        binding() {
          return remote.libraVcs.binding(sessionId);
        },
      };
    }

    function evidenceCaller(remote, sessionId) {
      return {
        session() {
          return remote.libraEvidence.session(sessionId);
        },
      };
    }

    return {
      inject: ["slots", "locale", "configForms", "remote", "sidebarRightTabs"],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), "libra-settings: dictionaries");
        const form = ctx.configForms.get("libra");
        ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
          name: "plugins.bundle.config",
          key: "@libra-tools/dsh-bundle",
        }, function LibraSettings(props) {
          return h(Settings, { ...props, formApi: form, t });
        })), "libra-settings: page");
        // A page type: it recognizes no resource address and is opened by kind
        // from the guide. The body distinguishes bound/unbound Sessions itself.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t("panelTitle"),
          guide: [{
            id: "version-control",
            order: 100,
            title: () => t("panelGuideTitle"),
            description: () => t("panelGuideDescription"),
          }],
        }), "libra-version-control: tab type");
        ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: TAB_ID,
          locale: NS,
          inject: (sessionId) => ({
            libra: remoteCaller(ctx.remote, sessionId),
            evidence: evidenceCaller(ctx.remote, sessionId),
          }),
        }, LibraPanel)), "libra-version-control: panel body");
        ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
          name: "sidebar.right.pane.tab.title",
          key: TAB_ID,
          locale: NS,
        }, LibraTitle)), "libra-version-control: panel title");
      },
      internal: {
        TAB_ID,
        LibraPanel,
        TAB_KIND,
        groupStatusEntries,
        sidesForState,
        sidesLabelKey,
        failureState,
        mergeHistory,
        describeCommit,
        describeEvidence,
      },
    };
  },
});
