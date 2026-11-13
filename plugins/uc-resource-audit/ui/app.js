"use strict";

const host = window.dbxPlugin;
const q = globalThis.UcAudit;
const el = id => document.getElementById(id);
const connection = el("connection");
const database = el("database");
const application = el("application");
const search = el("resource-search");
const state = { connections: [], schemas: new Map(), resource: null, revision: 0 };
let searchTimer;
const resourcePlaceholder = "输入资源名称、编码或 ID";

function notice(message, error = false) {
  el("notice").textContent = message;
  el("notice").classList.toggle("error", error);
}

function options(select, emptyLabel, entries) {
  select.replaceChildren(new Option(emptyLabel, ""), ...entries.map(([value, label]) => new Option(label, value)));
}

function clearResource() {
  clearTimeout(searchTimer);
  state.resource = null;
  el("choices").hidden = true;
  el("result").hidden = true;
}

function resetApps() {
  options(application, "请先选择环境", []);
  application.disabled = true;
  search.value = "";
  search.placeholder = "先选择应用";
  search.disabled = true;
  clearResource();
}

function errorText(error) {
  const message = String(error?.message || error);
  if (/PLUGIN_DATA_ACCESS_NOT_GRANTED|access not granted|拒绝授权/i.test(message)) {
    return "DBX 尚未授予此连接的查询权限。请关闭此标签页，重新打开后选中环境并允许只读查询。";
  }
  if (/Connection is not open|session.*not open|not connected/i.test(message)) {
    return "请先在 DBX 左侧打开这个连接，再点击「刷新连接」。";
  }
  if (/timed?\s*out|timeout/i.test(message)) return "查询超时，请稍后重试。";
  if (/unknown column|doesn.t exist|not found/i.test(message)) return "该库的 UC 表结构与工具不兼容。";
  return "DBX 查询失败，请检查连接和数据库权限后重试。";
}

async function query(sql, maxRows) {
  const result = await host.queryData({ connectionId: connection.value, sql, maxRows, timeoutMs: 15000 });
  return result.rows.map(row => Object.fromEntries(result.columns.map((col, index) => [col.name, row[index]])));
}

async function loadConnections(preferred = connection.value) {
  const revision = ++state.revision;
  const refresh = el("refresh-connections");
  refresh.disabled = true;
  resetApps();
  notice("正在读取 DBX 连接…");
  try {
    state.connections = (await host.getConnections()).filter(item =>
      /^(mysql|mariadb|tidb)$/i.test(item.dialect || item.dbType || ""));
    if (revision !== state.revision) return;
    state.connections.sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)) || a.name.localeCompare(b.name, "zh-CN"));
    options(connection, "请选择 UC 所在连接", state.connections.map(item =>
      [item.id, item.name + (isConnected(item) ? "" : " · 未打开")]));
    connection.disabled = false;
    if (state.connections.some(item => item.id === preferred)) connection.value = preferred;
    if (connection.value) await chooseConnection();
    else notice(state.connections.length ? "先选择 UC 所在的 DBX 连接。" : "DBX 还没有可用的 MySQL 连接。");
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  } finally {
    refresh.disabled = false;
  }
}

function isConnected(item) {
  return Boolean(item.connected ?? item.isConnected);
}

async function chooseConnection() {
  const revision = ++state.revision;
  resetApps();
  el("database-label").hidden = true;
  options(database, "请选择数据库", []);
  state.schemas = new Map();
  const selected = state.connections.find(item => item.id === connection.value);
  if (!selected) return notice("先选择 UC 所在的 DBX 连接。");
  if (!isConnected(selected)) return notice("请先在 DBX 左侧打开这个连接，再点击「刷新连接」。");
  notice("正在识别 UC 数据库…");
  try {
    const tables = await query(q.discover(), 5000);
    if (revision !== state.revision) return;
    for (const row of tables) {
      if (!state.schemas.has(row.schema_name)) state.schemas.set(row.schema_name, new Set());
      state.schemas.get(row.schema_name).add(row.table_name);
    }
    const schemas = [...state.schemas].filter(([, names]) => names.has("app") && names.has("resource")).map(([name]) => name);
    if (!schemas.length) return notice("这个连接里没有找到可读的 UC 数据库。", true);
    options(database, "请选择数据库", schemas.map(name => [name, name]));
    el("database-label").hidden = schemas.length === 1;
    database.value = schemas.length === 1 ? schemas[0] : schemas.includes(selected.database) ? selected.database : "";
    if (database.value) await loadApps();
    else notice("这个连接有多个 UC 数据库，请选择要查询的库。");
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  }
}

async function loadApps() {
  const revision = ++state.revision;
  resetApps();
  if (!database.value) return notice("请选择要查询的数据库。");
  notice("正在读取应用…");
  try {
    const apps = await query(q.apps(database.value), 2000);
    if (revision !== state.revision) return;
    options(application, "请选择应用", apps.map(row => [row.code, (row.name || row.code) + " · " + row.code]));
    application.disabled = false;
    notice(apps.length ? "请选择应用。" : "该数据库没有应用记录。");
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  }
}

async function findResources() {
  const revision = ++state.revision;
  clearResource();
  const term = search.value.trim();
  notice("正在查找资源…");
  try {
    const rows = await query(q.resources(database.value, application.value, term), 31);
    if (revision !== state.revision) return;
    const nodes = rows.slice(0, 30).map(resource => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option";
      const name = document.createElement("strong");
      name.textContent = resource.name || resource.identity || "未命名资源";
      const meta = document.createElement("span");
      meta.className = "hint";
      meta.textContent = [resource.parent_name, resource.identity, resource.type, "ID " + resource.id].filter(Boolean).join(" · ");
      button.append(name, meta);
      button.addEventListener("click", () => {
        search.value = resource.name || resource.identity || resource.id;
        state.resource = resource;
        loadHistory(resource);
      });
      item.append(button);
      return item;
    });
    el("resource-options").replaceChildren(...nodes);
    el("choices").hidden = !nodes.length;
    el("choices-note").hidden = rows.length <= 30;
    notice(nodes.length ? (term ? "" : "可直接选一级资源，也可输入任意层级资源的名称或编码。") : "没有找到符合条件的资源。");
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  }
}

function renderHistory(resource, events, names, incomplete, limited) {
  const formatActor = code => names.get(code)?.size === 1 ? [...names.get(code)][0] + "（" + code + "）" : code || "未记录";
  el("resource-name").textContent = resource.name || resource.identity || "未命名资源";
  el("resource-meta").textContent = [resource.parent_name, resource.identity, "ID " + resource.id].filter(Boolean).join(" · ");
  const badge = el("resource-status");
  badge.textContent = q.status(resource.is_halt);
  badge.className = "badge " + (({ T: "halted", F: "enabled" })[resource.is_halt] || "");
  el("last-modifier").textContent = resource.modify_user && q.timeKey(resource.modify_datetime)
    ? "资源最后写入 " + formatActor(resource.modify_user) + " · " + q.timeKey(resource.modify_datetime)
    : "";
  const shown = events.slice(0, 200);
  el("history").replaceChildren(...shown.map(event => {
    const row = document.createElement("tr");
    for (const value of [formatActor(event.actor), event.at || "未记录", event.title, event.details.join("；") || "—"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  el("history-table").hidden = !shown.length;
  const notes = [];
  if (!shown.length) notes.push("没有查到这条资源的操作历史。");
  if (limited || events.length > shown.length) notes.push("历史记录较多，显示最近查到的记录。");
  if (incomplete) notes.push("部分日志或姓名无法读取，当前显示可查到的记录和账号。");
  el("history-note").textContent = notes.join(" ");
  el("result").hidden = false;
}

async function loadHistory(resource, refreshResource = false) {
  const revision = ++state.revision;
  el("choices").hidden = true;
  el("result").hidden = true;
  notice("正在查询操作人和变更记录…");
  const schema = database.value;
  const tables = state.schemas.get(schema);
  let incomplete = !["audit_log", "operation_log", "entity_operation"].some(table => tables.has(table));
  if (refreshResource) {
    try {
      const [latest] = await query(q.resourceById(schema, application.value, resource.id), 1);
      if (revision !== state.revision) return;
      if (!latest) return notice("这条资源已经不在当前应用里，请重新查找。");
      resource = latest;
      state.resource = latest;
      search.value = latest.name || latest.identity || latest.id;
    } catch (error) {
      if (revision === state.revision) notice(errorText(error), true);
      return;
    }
  }
  async function readOptional(table, makeSql, maxRows) {
    if (!tables.has(table)) return [];
    try {
      return await query(makeSql(), maxRows);
    } catch {
      incomplete = true;
      return [];
    }
  }
  const relations = await readOptional("resource_relation", () => q.relations(schema, resource), 500);
  if (revision !== state.revision) return;
  const relationIds = relations.map(row => row.id);
  const audit = await readOptional("audit_log", () => q.audit(schema, resource, relationIds), 601);
  if (revision !== state.revision) return;
  const operations = await readOptional("operation_log", () => q.operationLog(schema, resource, relationIds), 201);
  if (revision !== state.revision) return;
  const entity = await readOptional("entity_operation", () => q.entityLog(schema, resource), 201);
  if (revision !== state.revision) return;
  const events = q.buildHistory(audit, operations, entity);
  const codes = [...new Set([resource.modify_user, ...events.slice(0, 200).map(row => row.actor)].filter(Boolean))];
  const operators = codes.length ? await readOptional("user_info", () => q.operators(schema, codes), 1001) : [];
  if (revision !== state.revision) return;
  const names = new Map();
  for (const row of operators) {
    if (!row.name) continue;
    if (!names.has(row.code)) names.set(row.code, new Set());
    names.get(row.code).add(row.name);
  }
  renderHistory(resource, events, names, incomplete, audit.length === 601 || operations.length === 201 || entity.length === 201);
  notice("");
}

connection.addEventListener("change", chooseConnection);
database.addEventListener("change", loadApps);
application.addEventListener("change", () => {
  ++state.revision;
  clearResource();
  search.disabled = !application.value;
  search.value = "";
  search.placeholder = application.value ? resourcePlaceholder : "先选择应用";
  if (application.value) {
    search.focus();
    findResources();
  } else notice("请选择应用。");
});
search.addEventListener("input", () => {
  ++state.revision;
  clearResource();
  searchTimer = setTimeout(findResources, 300);
});
search.addEventListener("keydown", event => {
  if (el("choices").hidden) return;
  const buttons = el("resource-options").querySelectorAll("button");
  if (event.key === "ArrowDown" && buttons.length) {
    event.preventDefault();
    buttons[0].focus();
  }
  if (event.key === "Enter" && buttons.length === 1) {
    event.preventDefault();
    buttons[0].click();
  }
});
el("refresh-connections").addEventListener("click", () => loadConnections());
el("refresh-history").addEventListener("click", () => {
  if (state.resource) loadHistory(state.resource, true);
});

async function start() {
  if (!host) return notice("请在 DBX 的插件工作台打开此页面。");
  const initTimer = setTimeout(() => notice("DBX 工作台尚未完成初始化，请关闭此标签页后重新打开。", true), 10000);
  try {
    await host.ready;
  } finally {
    clearTimeout(initTimer);
  }
  if (!host.capabilities?.dataApi || !host.capabilities?.connectionsApi) {
    el("refresh-connections").disabled = true;
    return notice("当前 DBX 版本缺少插件只读查询或连接列表接口，请更新 DBX。", true);
  }
  const fromContext = context => context?.connectionId || context?.id || "";
  host.onContext?.(context => {
    const preferred = fromContext(context);
    if (preferred && preferred !== connection.value) loadConnections(preferred);
  });
  await loadConnections(fromContext(host.context));
}

start().catch(error => notice(errorText(error), true));
