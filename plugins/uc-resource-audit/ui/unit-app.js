"use strict";

(() => {
  const host = window.dbxPlugin;
  const q = globalThis.UcUnitMaintenance;
  const el = id => document.getElementById("unit-" + id);
  const connection = el("connection");
  const database = el("database");
  const search = el("search");
  const action = el("action");
  const state = { connections: [], unit: null, targetVersion: 0, searchVersion: 0, previewVersion: 0, script: "" };

  function status(text, error = false, target = "status") {
    el(target).textContent = text;
    el(target).classList.toggle("error", error);
  }

  function selectOptions(select, placeholder, values) {
    select.replaceChildren(new Option(placeholder, ""), ...values.map(([value, label]) => new Option(label, value)));
  }

  function message(error) {
    const detail = String(error?.message || error);
    if (/PLUGIN_DATA_ACCESS_NOT_GRANTED|access not granted/i.test(detail)) return "请在 DBX 弹窗中允许对此连接进行只读查询。";
    if (/connection is not open|session.*not open|not connected/i.test(detail)) return "请先打开此连接，再刷新连接。";
    if (/timeout|timed?\s*out/i.test(detail)) return "数据库查询超时，请稍后重试。";
    return detail;
  }

  async function query(connectionId, sql, maxRows) {
    const result = await host.queryData({ connectionId, sql, maxRows, timeoutMs: 15000 });
    if (result.truncated) throw new Error("DBX 截断了查询结果，请重新检查后再生成脚本。");
    return result.rows.map(row => Object.fromEntries(result.columns.map(({name}, index) => [name, row[index]])));
  }

  function resetPreview() {
    state.previewVersion++;
    state.script = "";
    el("impact").hidden = true;
    el("script-panel").hidden = true;
    el("script").value = "";
    el("preview").disabled = false;
    status("", false, "preview-status");
  }

  function resetTarget() {
    state.targetVersion++;
    state.searchVersion++;
    state.unit = null;
    el("results-panel").hidden = true;
    el("selected").hidden = true;
    resetPreview();
  }

  function setupSearch() {
    resetTarget();
    const enabled = Boolean(connection.value && database.value);
    search.disabled = !enabled;
    el("search-submit").disabled = !enabled;
    status(enabled ? "" : "请选择 UC 数据库。");
  }

  function connected(item) {
    return Boolean(item.connected ?? item.isConnected);
  }

  async function loadConnections(preferred = connection.value) {
    resetTarget();
    const version = state.targetVersion;
    el("refresh").disabled = true;
    connection.disabled = true;
    database.disabled = true;
    search.disabled = true;
    el("search-submit").disabled = true;
    selectOptions(database, "请选择数据库", []);
    status("正在读取连接…");
    try {
      const items = (await host.getConnections()).filter(item => /^mysql$/i.test(item.dialect || item.dbType || ""));
      if (version !== state.targetVersion) return;
      state.connections = items.sort((a, b) => Number(connected(b)) - Number(connected(a)) || a.name.localeCompare(b.name, "zh-CN"));
      selectOptions(connection, "请选择连接", items.map(item => [item.id, item.name + (connected(item) ? "" : " · 未打开")]));
      connection.disabled = false;
      if (items.some(item => item.id === preferred)) connection.value = preferred;
      if (connection.value) await loadDatabases();
      else status(items.length ? "请选择已打开的 MySQL 连接。" : "DBX 中还没有 MySQL 连接。");
    } catch (error) {
      if (version === state.targetVersion) status(message(error), true);
    } finally {
      el("refresh").disabled = false;
    }
  }

  async function loadDatabases() {
    selectOptions(database, "请选择数据库", []);
    database.disabled = true;
    setupSearch();
    const version = state.targetVersion;
    const selected = state.connections.find(item => item.id === connection.value);
    if (!selected) return status("请选择已打开的 MySQL 连接。");
    if (!connected(selected)) return status("请先在 DBX 打开此连接，再刷新连接。");
    status("正在识别 UC 数据库…");
    try {
      const rows = await query(selected.id, q.discover(), 1000);
      if (version !== state.targetVersion) return;
      selectOptions(database, "请选择数据库", rows.map(row => [row.db, row.db]));
      database.disabled = !rows.length;
      if (rows.length === 1) database.value = rows[0].db;
      else if (rows.some(row => row.db === selected.database)) database.value = selected.database;
      setupSearch();
      if (!rows.length) status("此连接上未找到可读的 UC 数据库。", true);
    } catch (error) {
      if (version === state.targetVersion) status(message(error), true);
    }
  }

  function renderUnits(rows) {
    const results = el("results");
    results.replaceChildren();
    for (const unit of rows.slice(0, 30)) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const details = document.createElement("span");
      button.type = "button";
      button.className = "option";
      title.textContent = unit.name;
      details.textContent = [unit.code, q.types[unit.type] || unit.type, "ID " + unit.id].join(" · ");
      button.append(title, details);
      button.addEventListener("click", () => chooseUnit(unit));
      row.append(button);
      results.append(row);
    }
    el("results-panel").hidden = rows.length === 0;
    status(!rows.length ? "未找到单位。" : rows.length > 30 ? "显示前 30 项，请缩小搜索范围。" : "请选择要维护的单位。");
  }

  async function searchUnits() {
    const value = search.value.trim();
    if (!value || !database.value) return;
    state.unit = null;
    el("selected").hidden = true;
    el("results-panel").hidden = true;
    resetPreview();
    const version = ++state.searchVersion;
    el("search-submit").disabled = true;
    status("正在查找单位…");
    try {
      const rows = await query(connection.value, q.findUnit(database.value, value), 31);
      if (version === state.searchVersion) renderUnits(rows);
    } catch (error) {
      if (version === state.searchVersion) status(message(error), true);
    } finally {
      if (version === state.searchVersion) el("search-submit").disabled = false;
    }
  }

  function chooseUnit(unit) {
    state.unit = unit;
    const selected = state.connections.find(item => item.id === connection.value);
    el("identity-name").textContent = unit.name;
    el("identity-detail").textContent = [
      selected.name + " / " + database.value,
      "外部码 " + unit.code,
      "内部码 " + (unit.inner_code || "空"),
      (q.types[unit.type] || unit.type) + " (" + unit.type + ")",
      "ID " + unit.id,
      unit.is_halt === "T" ? "停用" : "启用",
    ].join(" · ");
    selectOptions(el("type"), "请选择新类型", Object.entries(q.types)
      .filter(([code]) => code !== unit.type).map(([code, name]) => [code, name + " · " + code]));
    el("code").value = "";
    el("inner").checked = Boolean(unit.inner_code) && unit.inner_code === unit.code;
    el("selected").hidden = false;
    el("results-panel").hidden = true;
    status("");
    setupAction();
  }

  function setupAction() {
    el("code-label").hidden = action.value !== "code";
    el("inner-label").hidden = action.value !== "code";
    el("inner").disabled = !state.unit?.inner_code;
    el("type-label").hidden = action.value !== "type";
    el("operator-label").hidden = action.value === "delete";
    el("code").required = action.value === "code";
    el("type").required = action.value === "type";
    el("operator").required = action.value !== "delete";
    resetPreview();
  }

  function rowEffect(row) {
    if (row.blocked) return row.effect === "review" ? "需核对引用" : "阻止生成";
    if (row.effect === "required") return "已确认";
    if (row.effect === "write") return row.write.remove ? "随单位删除" : "随改码更新";
    return "预览";
  }

  function renderImpact(result) {
    const visible = result.rows.filter(row => row.matched !== "0" || row.blocked);
    el("checks").replaceChildren(...visible.map(row => {
      const tr = document.createElement("tr");
      const values = [row.label, row.matched, rowEffect(row)];
      for (const value of values) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      if (row.blocked) tr.classList.add("blocked");
      return tr;
    }));
    el("impact").hidden = false;
  }

  async function preview() {
    if (!state.unit) return;
    resetPreview();
    const version = state.previewVersion;
    const connectionId = connection.value;
    const schema = database.value;
    const unit = state.unit;
    const operation = action.value;
    const value = el(operation === "type" ? "type" : "code").value.trim();
    const operator = el("operator").value.trim();
    const changeInner = el("inner").checked;
    el("preview").disabled = true;
    status("正在读取表结构和相关记录…", false, "preview-status");
    try {
      const metadata = await query(connectionId, q.metadata(schema), 5000);
      if (version !== state.previewVersion) return;
      const references = operation === "delete" ? await query(connectionId, q.foreignKeys(schema), 5000) : [];
      if (version !== state.previewVersion) return;
      const plan = q.plan({ schema, tables: q.catalog(metadata), unit, action: operation, value, operator, references, changeInner });
      const counts = new Map();
      for (const sql of q.previewQueries(schema, plan.checks)) {
        const rows = await query(connectionId, sql, 20);
        if (version !== state.previewVersion) return;
        for (const row of rows) counts.set(row.check_key, row.matched);
      }
      const result = q.assess(plan, counts);
      renderImpact(result);
      if (result.blocked) {
        const reason = result.unsupported.length ? "以下表不支持本插件使用的 InnoDB 事务：" + result.unsupported.join("、") :
          "存在阻止项。请核对命中记录后重新预览。";
        status(reason, true, "preview-status");
        return;
      }
      const [instance] = await query(connectionId, "SELECT @@server_uuid AS server_uuid", 1);
      if (version !== state.previewVersion) return;
      state.script = q.makeScript(plan, result, instance?.server_uuid);
      el("script").value = state.script;
      el("script-panel").hidden = false;
      status("预览通过，已生成事务脚本。", false, "preview-status");
    } catch (error) {
      if (version === state.previewVersion) status(message(error), true, "preview-status");
    } finally {
      if (version === state.previewVersion) el("preview").disabled = false;
    }
  }

  async function copy() {
    const script = state.script;
    if (!script) return;
    const field = el("script");
    try {
      if (!host.capabilities?.clipboardWrite) throw new Error("剪贴板不可用");
      await host.clipboard.writeText(script);
      if (state.script === script) status("已复制事务脚本。", false, "preview-status");
    } catch {
      field.focus();
      field.select();
      status("脚本已选中，可使用 Ctrl+C 复制。", false, "preview-status");
    }
  }

  function bindFormAction(form, button, run) {
    // DBX 沙箱禁用表单提交，显式触发按钮并保留浏览器校验。
    button.addEventListener("click", () => {
      if (form.reportValidity()) run();
    });
    form.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing ||
          !(event.target instanceof HTMLInputElement) || event.target.type === "checkbox") return;
      event.preventDefault();
      button.click();
    });
  }

  async function start() {
    if (!host?.capabilities?.dataApi || !host.capabilities.connectionsApi) {
      return status("请在支持 Host API 1.4 的 DBX 中打开单位维护工作台。", true);
    }
    selectOptions(action, "请选择维护动作", Object.entries(q.operations));
    action.value = "code";
    el("refresh").addEventListener("click", () => loadConnections());
    connection.addEventListener("change", loadDatabases);
    database.addEventListener("change", setupSearch);
    bindFormAction(el("lookup"), el("search-submit"), searchUnits);
    search.addEventListener("input", () => {
      state.searchVersion++;
      state.unit = null;
      el("selected").hidden = true;
      el("results-panel").hidden = true;
      el("search-submit").disabled = false;
      resetPreview();
      status("");
    });
    action.addEventListener("change", setupAction);
    for (const id of ["code", "operator", "inner", "type"]) el(id).addEventListener("input", resetPreview);
    bindFormAction(el("operation"), el("preview"), preview);
    el("copy").addEventListener("click", copy);
    const fromContext = context => context?.connectionId || context?.id || "";
    host.onContext?.(context => {
      const preferred = fromContext(context);
      if (preferred && preferred !== connection.value) loadConnections(preferred);
    });
    await loadConnections(fromContext(host.context));
  }

  start().catch(error => status(message(error), true));
})();
