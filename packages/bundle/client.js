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

    return {
      inject: ["slots", "locale", "configForms"],
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
      },
    };
  },
});
