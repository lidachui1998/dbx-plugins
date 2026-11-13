"use strict";

const host = window.dbxPlugin;
const q = globalThis.UcAudit;
const el = id => document.getElementById(id);
const connection = el("connection");
const database = el("database");
const application = el("application");
const applicationPicker = el("application-picker");
const applicationSearch = el("application-search");
const applicationChoices = el("application-choices");
const search = el("resource-search");
const history = globalThis.UcAuditHistory;
const state = {
  connections: [], schemas: new Map(), resources: new Map(), children: new Map(),
  resource: null, events: [], shown: 0, revision: 0, searchRevision: 0, expanded: new Set(),
};
const resourceName = resource => resource.name || resource.identity || "未命名资源";
const resourcePlaceholder = "输入资源名称、编码或 ID";

function notice(message, error = false) {
  el("notice").textContent = message;
  el("notice").classList.toggle("error", error);
}

function options(select, emptyLabel, entries) {
  select.replaceChildren(new Option(emptyLabel, ""), ...entries.map(([value, label]) => new Option(label, value)));
}

function clearResource() {
  ++state.searchRevision;
  state.resource = null;
  state.events = [];
  el("result").hidden = true;
  el("resource-table").hidden = true;
  el("resource-type").disabled = true;
}

function resetApps() {
  options(application, "请先选择环境", []);
  applicationSearch.value = "";
  applicationSearch.placeholder = "先选择环境";
  applicationSearch.disabled = true;
  el("toggle-applications").disabled = true;
  closeApplicationPicker();
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
    applicationSearch.disabled = !apps.length;
    el("toggle-applications").disabled = !apps.length;
    applicationSearch.placeholder = apps.length ? "搜索应用名称或编码" : "没有应用";
    notice(apps.length ? "请选择应用。" : "该数据库没有应用记录。");
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  }
}

function closeApplicationPicker() {
  applicationChoices.hidden = true;
  applicationSearch.setAttribute("aria-expanded", "false");
  el("toggle-applications").setAttribute("aria-expanded", "false");
}

function openApplicationPicker(term = "") {
  if (applicationSearch.disabled) return;
  const needle = term.trim().toLocaleLowerCase();
  const buttons = [...application.options].filter(option => option.value &&
    option.text.toLocaleLowerCase().includes(needle)).map(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.textContent = option.text;
    button.setAttribute("aria-current", String(option.value === application.value));
    button.addEventListener("click", () => {
      application.value = option.value;
      applicationSearch.value = option.text;
      closeApplicationPicker();
      applicationSearch.focus();
      loadResources();
    });
    const item = document.createElement("li");
    item.append(button);
    return item;
  });
  el("application-options").replaceChildren(...buttons);
  el("application-empty").hidden = buttons.length > 0;
  applicationChoices.hidden = false;
  applicationSearch.setAttribute("aria-expanded", "true");
  el("toggle-applications").setAttribute("aria-expanded", "true");
}

function resourcePath(resource, nodes = state.resources) {
  const path = [resource];
  const seen = new Set([resource.uuid]);
  let parentId = resource.parent_id;
  while (parentId && parentId !== "-1" && nodes.has(parentId) && !seen.has(parentId)) {
    const parent = nodes.get(parentId);
    path.unshift(parent);
    seen.add(parentId);
    parentId = parent.parent_id;
  }
  return path;
}

function pathText(resource) {
  const path = resourcePath(resource);
  const first = path[0];
  const prefix = first.parent_id && first.parent_id !== "-1" ? ["上级不可查"] : [];
  return [...prefix, ...path.map(resourceName)].join(" › ");
}

async function loadResources() {
  const revision = ++state.revision;
  clearResource();
  search.disabled = true;
  search.value = "";
  search.placeholder = application.value ? "正在读取资源…" : "先选择应用";
  state.resources.clear();
  state.children.clear();
  state.expanded.clear();
  if (!application.value) return notice("请选择应用。");
  const schema = database.value;
  const appCode = application.value;
  const all = [];
  notice("正在读取资源层级…");
  try {
    let cursor = "0";
    for (;;) {
      const rows = await query(q.resources(schema, appCode, cursor), q.treePageSize);
      if (revision !== state.revision) return;
      all.push(...rows);
      if (rows.length < q.treePageSize) break;
      cursor = rows.at(-1).id;
    }
    all.sort((a, b) => Number(a.list_order || 0) - Number(b.list_order || 0) || compareIds(a.id, b.id));
    state.resources = new Map(all.map(row => [row.uuid, row]));
    for (const row of all) {
      const parent = resourcePath(row)[0];
      const key = parent.uuid === row.uuid || parent.parent_id === row.uuid ? "" : row.parent_id;
      if (!state.children.has(key)) state.children.set(key, []);
      state.children.get(key).push(row);
    }
    search.disabled = false;
    search.placeholder = resourcePlaceholder;
    const types = [...new Set(all.map(row => row.type).filter(Boolean))].sort();
    options(el("resource-type"), "全部类型", types.map(type => [type, typeLabel(type)]));
    el("resource-type").disabled = !types.length;
    notice("");
    renderResourceTree("");
    el("resource-table").hidden = false;
  } catch (error) {
    if (revision === state.revision) notice(errorText(error), true);
  }
}

function compareIds(a, b) {
  return a.length - b.length || a.localeCompare(b);
}

function renderResourceTree(term, deleted = [], limited = false) {
  const needle = term.toLocaleLowerCase();
  const type = el("resource-type").value;
  const filtering = Boolean(needle || type);
  const hits = filtering ? [...state.resources.values()].filter(row => (!type || row.type === type) &&
    (!needle || String(row.name || "").toLocaleLowerCase().includes(needle) ||
     String(row.identity || "").toLocaleLowerCase().includes(needle) || row.id === needle)) : [];
  deleted = deleted.filter(row => !type || row.type === type);
  const visible = new Set();
  let roots = state.children.get("") || [];
  let children = state.children;
  if (filtering) {
    const linked = new Map();
    roots = [];
    for (const resource of [...hits, ...deleted]) {
      const path = resourcePath(resource);
      for (const [index, row] of path.entries()) {
        if (visible.has(row.uuid)) continue;
        visible.add(row.uuid);
        const parent = path[index - 1];
        if (parent) {
          if (!linked.has(parent.uuid)) linked.set(parent.uuid, []);
          linked.get(parent.uuid).push(row);
        } else roots.push(row);
      }
    }
    children = linked;
  }
  const deletedButton = el("search-deleted");
  deletedButton.hidden = !term || !state.schemas.get(database.value)?.has("audit_log");
  deletedButton.disabled = false;
  el("deleted-note").textContent = limited ? "仅显示前 100 条删除记录，可缩小搜索范围。"
    : deleted.length ? "找到 " + deleted.length + " 条删除记录" : "";
  renderResourceTable(roots, children, filtering);
}

function typeLabel(type) {
  return ({ MENU: "菜单", BUTTON: "按钮", OPERATION: "操作权限", REPORT: "报表" })[type] || type || "—";
}

function parentLabel(resource) {
  const parent = state.resources.get(resource.parent_id);
  return parent ? resourceName(parent) : resource.parent_id && resource.parent_id !== "-1" ? "不可查" : "无（一级资源）";
}

function markSelectedResource() {
  for (const row of el("resource-rows").rows) {
    const selected = row.dataset.resource === state.resource?.uuid;
    row.classList.toggle("selected-resource", selected);
    row.querySelector(".resource-link").setAttribute("aria-current", String(selected));
  }
}

function selectResource(resource) {
  state.resource = resource;
  markSelectedResource();
  loadHistory(resource, true);
}

function renderResourceTable(roots, children, filtering) {
  const tbody = el("resource-rows");
  const rows = [];
  function addRows(items, depth) {
    for (const resource of items) {
      const row = document.createElement("tr");
      row.dataset.resource = resource.uuid;
      if (resource.is_halt === "T" || resource.deleted) row.className = "inactive-resource";
      const order = document.createElement("td");
      order.textContent = resource.list_order ?? "—";
      const name = document.createElement("td");
      const branch = document.createElement("div");
      branch.className = "tree-row";
      branch.style.paddingInlineStart = Math.min(depth, 8) * 14 + "px";
      const descendants = children.get(resource.uuid);
      const expanded = descendants?.length && (state.expanded.has(resource.uuid) || (filtering && !state.expanded.has("closed:" + resource.uuid)));
      if (descendants?.length) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle";
        toggle.setAttribute("aria-expanded", String(Boolean(expanded)));
        toggle.setAttribute("aria-label", (expanded ? "收起 " : "展开 ") + resourceName(resource));
        toggle.textContent = expanded ? "−" : "+";
        toggle.addEventListener("click", () => {
          if (expanded) {
            state.expanded.delete(resource.uuid);
            state.expanded.add("closed:" + resource.uuid);
          } else {
            state.expanded.add(resource.uuid);
            state.expanded.delete("closed:" + resource.uuid);
          }
          renderResourceTable(roots, children, filtering);
          [...tbody.querySelectorAll("button[data-node]")].find(button => button.dataset.node === resource.uuid)?.focus();
        });
        toggle.dataset.node = resource.uuid;
        branch.append(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "tree-spacer";
        branch.append(spacer);
      }
      const select = document.createElement("button");
      select.type = "button";
      select.className = "resource-link";
      select.textContent = resourceName(resource);
      select.addEventListener("click", () => selectResource(resource));
      branch.append(select);
      name.append(branch);
      row.append(order, name);
      for (const value of [resource.identity, typeLabel(resource.type), parentLabel(resource)]) {
        const cell = document.createElement("td");
        cell.textContent = value || "—";
        row.append(cell);
      }
      const statusCell = document.createElement("td");
      statusCell.append(resourceStatus(resource));
      row.append(statusCell);
      rows.push(row);
      if (expanded) addRows(descendants, depth + 1);
    }
  }
  addRows(roots, 0);
  tbody.replaceChildren(...rows);
  markSelectedResource();
  el("resource-table-empty").hidden = rows.length > 0;
}

async function searchDeleted() {
  const revision = ++state.searchRevision;
  const term = search.value.trim();
  if (!term) return;
  const button = el("search-deleted");
  const note = el("deleted-note");
  button.disabled = true;
  note.textContent = "正在读取删除审计…";
  try {
    const rows = await query(q.deletedResources(database.value, application.value, term), 101);
    if (revision !== state.searchRevision) return;
    const deleted = rows.slice(0, 100).map(row => ({
      ...row, deleted: true, originalUuid: row.uuid, uuid: "deleted:" + row.id,
    }));
    const unique = [...new Map(deleted.reverse().map(row => [row.id, row])).values()].reverse();
    renderResourceTree(term, unique, rows.length > 100);
    if (!unique.length) note.textContent = "没有找到匹配的删除记录。";
  } catch (error) {
    if (revision === state.searchRevision) note.textContent = errorText(error);
  } finally {
    if (revision === state.searchRevision) button.disabled = false;
  }
}

function resourceStatus(resource, badge = document.createElement("span")) {
  badge.textContent = resource.deleted ? "已删除" : q.status(resource.is_halt);
  badge.className = "badge " + (resource.deleted || resource.is_halt === "T" ? "halted" : resource.is_halt === "F" ? "enabled" : "");
  return badge;
}

function renderHistory(resource, events, names, incomplete) {
  const formatActor = code => names.get(code)?.size === 1 ? [...names.get(code)][0] + "（" + code + "）" : code || "未记录";
  el("resource-name").textContent = resourceName(resource);
  el("resource-path").textContent = pathText(resource);
  el("resource-meta").textContent = [resource.identity, typeLabel(resource.type), "ID " + resource.id].filter(Boolean).join(" · ");
  resourceStatus(resource, el("resource-status"));
  const properties = [["地址", resource.link], ["权限", resource.permission]].filter(([, value]) => value);
  el("resource-properties").hidden = !properties.length;
  el("resource-properties").open = false;
  el("resource-property-list").replaceChildren(...properties.flatMap(([label, value]) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    return [term, description];
  }));
  el("last-modifier").textContent = resource.modify_user && q.timeKey(resource.modify_datetime)
    ? "资源最后写入 " + formatActor(resource.modify_user) + " · " + q.timeKey(resource.modify_datetime) : "";
  state.events = events;
  state.shown = 0;
  state.names = formatActor;
  el("history").replaceChildren();
  appendHistory();
  const notes = [];
  if (incomplete.length) notes.push("以下来源未能完整读取：" + [...new Set(incomplete)].join("、") + "。");
  if (!events.some(event => event.entity === "resource" && event.operation === "insert")) notes.push("当前数据未保留可确认的创建记录。");
  if (!events.length) notes.push("没有查到这条资源的操作历史。");
  el("history-note").textContent = notes.join(" ");
  el("result").hidden = false;
}

function formatValue(field, value) {
  if (value === null) return "空";
  if (field === "is_halt" && (value === "T" || value === "F")) return q.status(value);
  if (field === "parent_id") {
    if (!value || value === "-1") return "无（一级资源）";
    if (state.resources.has(value)) return resourceName(state.resources.get(value)) + "（" + value + "）";
  }
  return value === "" ? "空字符串" : value;
}

function changeList(event, changes) {
  const list = document.createElement("ul");
  list.className = "change-list";
  for (const change of changes) {
    const item = document.createElement("li");
    const field = document.createElement("strong");
    field.textContent = history.labels[change.field] || change.field;
    const before = formatValue(change.field, change.before);
    const after = formatValue(change.field, change.after);
    const value = document.createElement("span");
    value.textContent = event.operation === "insert" ? after : event.operation === "delete" ? before : before + " → " + after;
    item.append(field, value);
    list.append(item);
  }
  return list;
}

function appendHistory() {
  const rows = state.events.slice(state.shown, state.shown + 80);
  for (const event of rows) {
    const row = document.createElement("tr");
    for (const value of [event.at || "未记录", state.names(event.actor), event.title]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const cell = document.createElement("td");
    const changes = event.changes.filter(change => !history.technicalFields.has(change.field));
    changes.sort((a, b) => Number(b.field === "is_halt") - Number(a.field === "is_halt"));
    if (changes.length) cell.append(changeList(event, changes.slice(0, 2)));
    else if (event.operation === "insert") cell.textContent = "未记录创建时的字段值";
    else cell.textContent = event.changes.length ? "仅记录写入信息" : "未记录字段明细";

    const details = document.createElement("details");
    details.className = "log-details";
    const summary = document.createElement("summary");
    const related = event.related?.length || 0;
    summary.textContent = related ? "日志明细 · " + related + " 条资源关系" : "日志明细";
    details.append(summary);
    if (changes.length > 2) details.append(changeList(event, changes.slice(2)));
    const metadata = event.changes.filter(change => history.technicalFields.has(change.field));
    if (metadata.length) details.append(changeList(event, metadata));
    const origin = document.createElement("p");
    origin.className = "hint";
    origin.textContent = event.source + (event.entity === "resource_relation" && event.recordId ? " · 关系 " + event.recordId : "");
    details.append(origin);
    for (const relation of event.related || []) {
      const label = document.createElement("p");
      label.className = "related-log";
      label.textContent = relation.title + " · " + (relation.recordId || "未记录 ID") + " · " + relation.source;
      details.append(label, changeList(relation, relation.changes));
    }
    cell.append(details);
    row.append(cell);
    el("history").append(row);
  }
  state.shown += rows.length;
  el("history-table").hidden = state.events.length === 0;
  el("more-history").hidden = state.shown >= state.events.length;
  el("history-count").textContent = state.events.length
    ? "最新在上 · " + (state.shown < state.events.length ? state.shown + " / " : "") + state.events.length + " 条" : "";
}

async function loadHistory(resource, reveal = false) {
  const revision = ++state.revision;
  el("result").hidden = true;
  notice("正在读取创建、修改和删除记录…");
  const schema = database.value;
  const appCode = application.value;
  const tables = state.schemas.get(schema);
  const active = () => revision === state.revision;
  const incomplete = [];
  if (!resource.deleted) {
    try {
      const [latest] = await query(q.resourceById(schema, appCode, resource), 1);
      if (!active()) return;
      if (!latest) return notice("该资源已不在当前应用。可搜索名称或 ID，再点「查已删除」。");
      resource = { ...resource, ...latest };
    } catch (error) {
      if (active()) notice(errorText(error), true);
      return;
    }
  }
  const key = { ...resource, uuid: resource.deleted ? resource.originalUuid : resource.uuid };
  async function readPages(label, buildSql, size, descending = true) {
    const all = [];
    try {
      let cursor = "";
      while (active()) {
        const result = await host.queryData({ connectionId: connection.value, sql: buildSql(cursor), maxRows: size, timeoutMs: 15000 });
        if (!active()) break;
        const rows = result.rows.map(row => Object.fromEntries(result.columns.map((col, index) => [col.name, row[index]])));
        all.push(...rows);
        if (!result.truncated && rows.length < size) break;
        const next = rows.at(-1)?.id;
        if (!next || (cursor && (descending ? compareIds(next, cursor) >= 0 : compareIds(next, cursor) <= 0))) {
          throw new Error("无法继续读取下一页");
        }
        cursor = next;
      }
    } catch {
      incomplete.push(label);
    }
    return all;
  }
  const hasAudit = tables.has("audit_log");
  const hasRelations = tables.has("resource_relation");
  const ids = key.uuid && (hasAudit || hasRelations)
    ? await readPages("资源关系", cursor => q.relationIds(schema, key, hasRelations, hasAudit, cursor), q.treePageSize, false) : [];
  if (!active()) return;
  const relationIds = ids.map(row => row.id);
  const audit = hasAudit ? await readPages("字段审计", cursor => q.audit(schema, key, relationIds, cursor), q.logPageSize) : [];
  const operations = tables.has("operation_log") ? await readPages("操作日志", cursor => q.operationLog(schema, key, relationIds, cursor), q.logPageSize) : [];
  const entities = tables.has("entity_operation") ? await readPages("实体操作", cursor => q.entityLog(schema, key, cursor), q.logPageSize) : [];
  const details = entities.length && tables.has("entity_operation_detail")
    ? await readPages("实体操作明细", cursor => q.entityDetails(schema, key, cursor), q.logPageSize) : [];
  if (!active()) return;
  if (!hasAudit && !tables.has("operation_log") && !tables.has("entity_operation")) incomplete.push("当前库的审计与操作日志表");
  const events = history.build(key, audit, operations, entities, details);
  const codes = [...new Set([resource.modify_user, ...events.map(row => row.actor)].filter(Boolean))];
  const names = new Map();
  if (tables.has("user_info")) {
    for (let offset = 0; offset < codes.length && active(); offset += 100) {
      try {
        const users = await query(q.operators(schema, codes.slice(offset, offset + 100)), 5000);
        for (const row of users) {
          if (!row.name) continue;
          if (!names.has(row.code)) names.set(row.code, new Set());
          names.get(row.code).add(row.name);
        }
      } catch {
        incomplete.push("操作人姓名");
        break;
      }
    }
  }
  if (!active()) return;
  state.resource = resource;
  renderHistory(resource, events, names, incomplete);
  notice("");
  if (reveal) {
    el("resource-name").focus({ preventScroll: true });
    el("result").scrollIntoView({ block: "start", inline: "nearest" });
  }
}

connection.addEventListener("change", chooseConnection);
database.addEventListener("change", loadApps);
applicationSearch.addEventListener("input", () => openApplicationPicker(applicationSearch.value));
applicationSearch.addEventListener("click", () => openApplicationPicker(
  applicationSearch.value === application.selectedOptions[0]?.text ? "" : applicationSearch.value));
applicationPicker.addEventListener("keydown", event => {
  if (event.key === "Escape" && !applicationChoices.hidden) {
    event.preventDefault();
    closeApplicationPicker();
    applicationSearch.value = application.value ? application.selectedOptions[0].text : "";
    applicationSearch.focus();
  }
  if (event.target === applicationSearch && (event.key === "ArrowDown" || event.key === "Enter")) {
    event.preventDefault();
    if (applicationChoices.hidden) openApplicationPicker();
    const buttons = el("application-options").querySelectorAll("button");
    if (event.key === "Enter" && buttons.length === 1) buttons[0].click();
    else buttons[0]?.focus();
  }
});
el("toggle-applications").addEventListener("click", () => {
  if (applicationChoices.hidden) openApplicationPicker();
  else {
    closeApplicationPicker();
    applicationSearch.value = application.value ? application.selectedOptions[0].text : "";
  }
});
function filterResources() {
  ++state.searchRevision;
  state.expanded.clear();
  renderResourceTree(search.value.trim());
}

search.addEventListener("input", filterResources);
search.addEventListener("keydown", event => {
  const first = el("resource-rows").querySelector(".resource-link");
  if ((event.key === "ArrowDown" || event.key === "Enter") && first) {
    event.preventDefault();
    first.focus();
  }
});
document.addEventListener("click", event => {
  if (!applicationPicker.contains(event.target)) {
    closeApplicationPicker();
    applicationSearch.value = application.value ? application.selectedOptions[0].text : "";
  }
});
el("resource-type").addEventListener("change", filterResources);
el("search-deleted").addEventListener("click", searchDeleted);
el("more-history").addEventListener("click", appendHistory);
el("refresh-connections").addEventListener("click", () => loadConnections());
el("refresh-history").addEventListener("click", () => {
  if (state.resource) loadHistory(state.resource);
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
