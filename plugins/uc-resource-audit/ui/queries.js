"use strict";

globalThis.UcAudit = (() => {
  const TABLES = ["app", "resource", "resource_relation", "audit_log", "operation_log", "entity_operation", "entity_operation_detail", "user_info"];
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

  const treePageSize = 500;
  const logPageSize = 30;

  function resources(schema, appCode, cursor = "0") {
    return "SELECT CAST(id AS CHAR) AS id,uuid,name,identity,type,parent_id,list_order,link,permission,is_halt " +
      "FROM " + table(schema, "resource") + " WHERE app_code=" + literal(appCode) +
      " AND id>" + (cursor === "0" ? "0" : numericId(cursor)) + " ORDER BY id LIMIT " + treePageSize;
  }

  function resourceById(schema, appCode, resource) {
    return "SELECT CAST(id AS CHAR) AS id,uuid,name,identity,type,parent_id,is_halt," +
      "create_user,create_datetime,modify_user,modify_datetime FROM " + table(schema, "resource") +
      " WHERE app_code=" + literal(appCode) + " AND id=" + numericId(resource.id) +
      " AND uuid=" + literal(resource.uuid) + " LIMIT 1";
  }

  function deletedResources(schema, appCode, search) {
    const source = table(schema, "audit_log");
    const keyword = literal(search);
    const numericMatch = /^[1-9]\d{0,19}$/.test(search) ? " AND a.`PrimaryKey`=" + numericId(search) : "";
    const fields = ["app_code", "uuid", "name", "identity", "type", "parent_id", "create_user", "create_datetime"];
    const snapshot = fields.map(field => "MAX(CASE WHEN a.ColumnName='" + field + "' THEN a.OldValue END) AS " + field);
    return "SELECT CAST(a.`PrimaryKey` AS CHAR) AS id," + snapshot.join(",") +
      " FROM " + source + " a WHERE a.TableName='resource' AND a.Operation='delete'" + numericMatch +
      " GROUP BY a.`PrimaryKey`,COALESCE(NULLIF(a.ParentID,0),a.ID)" +
      " HAVING app_code=" + literal(appCode) +
      " AND (LOCATE(" + keyword + ",name)>0 OR LOCATE(" + keyword + ",identity)>0 OR id=" + keyword + ")" +
      " ORDER BY MAX(a.ID) DESC LIMIT 101";
  }

  function relationIds(schema, resource, hasCurrent, hasAudit, cursor) {
    const key = literal(resource.uuid);
    const after = cursor ? numericId(cursor) : "0";
    const sources = [];
    if (hasCurrent) sources.push("SELECT id AS relation_id FROM " + table(schema, "resource_relation") +
      " WHERE resource_id=" + key + " AND id>" + after);
    if (hasAudit) sources.push("SELECT DISTINCT `PrimaryKey` AS relation_id FROM " + table(schema, "audit_log") +
      " WHERE TableName='resource_relation' AND ColumnName='resource_id' AND `PrimaryKey`>" + after +
      " AND (OldValue=" + key + " OR NewValue=" + key + ")");
    return "SELECT CAST(relation_id AS CHAR) AS id FROM (" + sources.join(" UNION ") +
      ") rel ORDER BY relation_id LIMIT " + treePageSize;
  }

  function page(alias, cursor) {
    return (cursor ? " AND " + alias + ".id<" + numericId(cursor) : "") +
      " ORDER BY " + alias + ".id DESC LIMIT " + logPageSize;
  }

  function audit(schema, resource, ids, cursor) {
    const relationScope = ids.length
      ? " OR (a.TableName='resource_relation' AND a.`PrimaryKey` IN (" + ids.map(numericId).join(",") + "))"
      : "";
    return "SELECT CAST(a.ID AS CHAR) AS id,CAST(a.ParentID AS CHAR) AS audit_parent," +
      "CAST(a.`PrimaryKey` AS CHAR) AS record_id,a.TableName AS entity,a.ColumnName AS field,a.Operation AS operation," +
      "a.OldValue AS before_value,a.NewValue AS after_value,a.CreateTime AS at_time,a.CreateClerk AS actor" +
      " FROM " + table(schema, "audit_log") + " a WHERE ((a.TableName='resource' AND a.`PrimaryKey`=" +
      numericId(resource.id) + ")" + relationScope + ")" + page("a", cursor);
  }

  function operationLog(schema, resource, ids, cursor) {
    const keys = [resource.uuid, resource.id].filter(Boolean).map(literal).join(",");
    const relationKeys = [resource.uuid, ...ids].filter(Boolean).map(literal).join(",");
    const relations = relationKeys ? " OR (o.table_name='resource_relation' AND o.table_uuid IN (" + relationKeys + "))" : "";
    return "SELECT CAST(o.id AS CHAR) AS id,o.create_datetime AS at_time,o.create_user AS actor," +
      "o.table_name AS entity,o.table_uuid AS record_id,o.previous AS before_value,o.lastest AS after_value" +
      " FROM " + table(schema, "operation_log") + " o WHERE ((o.table_name='resource' AND o.table_uuid IN (" +
      keys + "))" + relations + ")" + page("o", cursor);
  }

  function entityScope(resource) {
    const keys = [resource.uuid, resource.id].filter(Boolean).map(literal).join(",");
    return "e.entity_type='RESOURCE' AND e.entity_key IN (" + keys + ")";
  }

  function entityLog(schema, resource, cursor) {
    return "SELECT CAST(e.id AS CHAR) AS id,e.operation_id,e.operation_date AS at_time," +
      "e.operator_user AS actor,e.operation_name AS title FROM " + table(schema, "entity_operation") +
      " e WHERE " + entityScope(resource) + page("e", cursor);
  }

  function entityDetails(schema, resource, cursor) {
    return "SELECT CAST(d.id AS CHAR) AS id,CAST(e.id AS CHAR) AS event_id,d.field," +
      "d.prev_value AS before_value,d.next_value AS after_value FROM " + table(schema, "entity_operation") +
      " e JOIN " + table(schema, "entity_operation_detail") +
      " d ON d.operation_id=e.operation_id AND d.entity_type=e.entity_type AND d.entity_key=e.entity_key" +
      " WHERE " + entityScope(resource) + page("d", cursor);
  }

  function operators(schema, codes) {
    return "SELECT code,name FROM " + table(schema, "user_info") +
      " WHERE code IN (" + codes.map(literal).join(",") + ") GROUP BY code,name ORDER BY code,name";
  }

  function status(value) {
    return ({ T: "停用", F: "启用" })[value] || "未知";
  }

  function timeKey(value) {
    return String(value || "").replace("T", " ").slice(0, 19);
  }


  return { discover, apps, resources, resourceById, deletedResources, relationIds, audit, operationLog,
    entityLog, entityDetails, operators, status, timeKey, treePageSize, logPageSize };
})();
