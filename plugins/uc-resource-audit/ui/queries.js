"use strict";

globalThis.UcAudit = (() => {
  const TABLES = ["app", "resource", "resource_relation", "audit_log", "operation_log", "entity_operation", "user_info"];
  const labels = {
    is_halt: "停用状态", name: "名称", identity: "编码", list_order: "排序",
    parent_id: "父级", hidden: "隐藏状态", permission: "权限码", link: "地址",
    unit_id: "适用单位", unit_type: "单位类型", device: "设备",
  };
  const metadata = new Set(["modify_datetime", "modify_user", "create_datetime", "create_user"]);
  const shortValueFields = ["is_halt", "name", "identity", "list_order", "hidden", "permission", "unit_type", "device"];

  // 使用 UTF-8 字节构造 SQL 字面量，避免引号和 MySQL 转义模式影响输入。
  function literal(value) {
    const hex = Array.from(new TextEncoder().encode(String(value)), b => b.toString(16).padStart(2, "0")).join("");
    return hex ? "CONVERT(0x" + hex + " USING utf8mb4)" : "''";
  }

  function table(schema, name) {
    return "`" + schema.replaceAll("`", "``") + "`.`" + name + "`";
  }

  function numericId(value) {
    if (!/^[1-9]\d{0,19}$/.test(String(value))) throw new Error("资源 ID 无效");
    return String(value);
  }

  function discover() {
    return "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name FROM information_schema.TABLES " +
      "WHERE TABLE_NAME IN (" + TABLES.map(literal).join(",") + ") " +
      "AND TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') " +
      "ORDER BY TABLE_SCHEMA,TABLE_NAME";
  }

  function apps(schema) {
    return "SELECT code, descript AS name FROM " + table(schema, "app") + " ORDER BY descript, code";
  }

  function selectResource(schema, appCode) {
    return "SELECT CAST(r.id AS CHAR) AS id,r.uuid,r.name,r.identity,r.type,r.is_halt," +
      "p.name AS parent_name,r.modify_user,r.modify_datetime " +
      "FROM " + table(schema, "resource") + " r LEFT JOIN " + table(schema, "resource") +
      " p ON p.uuid=r.parent_id WHERE r.app_code=" + literal(appCode);
  }

  function resources(schema, appCode, search) {
    const keyword = literal(search);
    const match = search
      ? " AND (LOCATE(" + keyword + ",r.identity)>0 OR LOCATE(" + keyword + ",r.name)>0" +
        " OR CAST(r.id AS CHAR)=" + keyword + ")"
      : " AND r.parent_id='-1'";
    return selectResource(schema, appCode) + match +
      " ORDER BY " + (search ? "(r.identity=" + keyword + ") DESC,(r.name=" + keyword + ") DESC," : "") +
      "r.list_order,r.id LIMIT 31";
  }

  function resourceById(schema, appCode, resourceId) {
    return selectResource(schema, appCode) + " AND r.id=" + numericId(resourceId) + " LIMIT 1";
  }

  function relations(schema, resource) {
    return "SELECT CAST(id AS CHAR) AS id FROM " + table(schema, "resource_relation") +
      " WHERE resource_id=" + literal(resource.uuid) + " ORDER BY id LIMIT 500";
  }

  function audit(schema, resource, relationIds) {
    const relationScope = relationIds.length
      ? " OR (TableName='resource_relation' AND `PrimaryKey` IN (" + relationIds.map(numericId).join(",") + "))"
      : "";
    const allow = shortValueFields.map(field => "'" + field + "'").join(",");
    return "SELECT CAST(ID AS CHAR) AS id,TableName AS entity,ColumnName AS field,Operation AS operation," +
      " CASE WHEN ColumnName IN (" + allow + ") THEN LEFT(OldValue,180) END AS before_value," +
      " CASE WHEN ColumnName IN (" + allow + ") THEN LEFT(NewValue,180) END AS after_value," +
      " CreateTime AS at_time,CreateClerk AS actor FROM " + table(schema, "audit_log") +
      " WHERE (TableName='resource' AND `PrimaryKey`=" + numericId(resource.id) + ")" + relationScope +
      " ORDER BY CreateTime DESC,ID DESC LIMIT 601";
  }

  function operationLog(schema, resource, relationIds) {
    const relationKeys = [resource.uuid, ...relationIds].map(literal).join(",");
    return "SELECT CAST(id AS CHAR) AS id,create_datetime AS at_time,create_user AS actor," +
      " CASE WHEN previous IS NULL OR previous IN ('','null','{}') THEN 'insert'" +
      " WHEN lastest IS NULL OR lastest IN ('','null','{}') THEN 'delete' ELSE 'update' END AS operation" +
      " FROM " + table(schema, "operation_log") +
      " WHERE (table_name='resource' AND table_uuid IN (" + [resource.uuid, resource.id].map(literal).join(",") + "))" +
      " OR (table_name='resource_relation' AND table_uuid IN (" + relationKeys + "))" +
      " ORDER BY create_datetime DESC,id DESC LIMIT 201";
  }

  function entityLog(schema, resource) {
    return "SELECT CAST(id AS CHAR) AS id,operation_date AS at_time,operator_user AS actor,operation_name AS title" +
      " FROM " + table(schema, "entity_operation") + " WHERE entity_type='RESOURCE'" +
      " AND entity_key IN (" + [resource.uuid, resource.id].map(literal).join(",") + ")" +
      " ORDER BY operation_date DESC,id DESC LIMIT 201";
  }

  function operators(schema, codes) {
    return "SELECT code,name FROM " + table(schema, "user_info") +
      " WHERE code IN (" + codes.map(literal).join(",") + ") GROUP BY code,name ORDER BY code,name LIMIT 1001";
  }

  function status(value) {
    return ({ T: "停用", F: "启用" })[value] || "未知";
  }

  function timeKey(value) {
    return String(value || "").replace("T", " ").slice(0, 19);
  }

  function nearTime(a, b) {
    return Math.abs(Date.parse(a.replace(" ", "T") + "Z") - Date.parse(b.replace(" ", "T") + "Z")) <= 2000;
  }

  function buildHistory(auditRows, operationRows, entityRows) {
    const events = new Map();
    const mainStatus = auditRows.filter(row => row.entity === "resource" && row.field === "is_halt");
    for (const row of auditRows) {
      // 同一次停用可能分别写入资源和关联审计，优先显示资源主记录。
      const duplicate = row.entity === "resource_relation" && row.field === "is_halt" &&
        mainStatus.some(other => other.actor === row.actor && other.operation === row.operation &&
          other.before_value === row.before_value && other.after_value === row.after_value &&
          nearTime(timeKey(other.at_time), timeKey(row.at_time)));
      if (duplicate) continue;
      const key = JSON.stringify([timeKey(row.at_time), row.actor, row.operation]);
      if (!events.has(key)) {
        events.set(key, {
          at: timeKey(row.at_time), actor: row.actor, operation: row.operation,
          details: new Set(), source: "字段审计", onlyMetadata: true,
        });
      }
      const event = events.get(key);
      if (metadata.has(row.field)) continue;
      event.onlyMetadata = false;
      const field = labels[row.field] || row.field;
      const before = row.before_value;
      const after = row.after_value;
      if (row.field === "is_halt" && row.operation === "update") {
        event.title = ({ T: "停用资源", F: "启用资源" })[after];
        event.details.add(status(before) + " → " + status(after));
      } else if (row.operation === "update") {
        const change = before == null && after == null ? "" : " · " + (before ?? "空") + " → " + (after ?? "空");
        event.details.add(field + change);
      }
    }
    const rows = [...events.values()].filter(event => !event.onlyMetadata);
    for (const event of events.values()) {
      if (event.onlyMetadata && !rows.some(other => other.actor === event.actor &&
        other.operation === event.operation && nearTime(other.at, event.at))) rows.push(event);
    }
    for (const [log, source] of [[operationRows, "操作日志"], [entityRows, "实体操作"]]) {
      for (const row of log) {
        const at = timeKey(row.at_time);
        if (rows.some(event => event.source !== source && event.actor === row.actor &&
          (!row.operation || row.operation === event.operation) && nearTime(event.at, at))) continue;
        rows.push({ at, actor: row.actor, operation: row.operation || "update", title: row.title, details: [], source });
      }
    }
    return rows.sort((a, b) => b.at.localeCompare(a.at)).map(event => ({
      ...event,
      title: event.title || ({ insert: "创建资源", update: "修改资源", delete: "删除资源" })[event.operation] || "资源操作",
      details: [...event.details],
    }));
  }

  return { discover, apps, resources, resourceById, relations, audit, operationLog, entityLog, operators, status, timeKey, buildHistory };
})();
