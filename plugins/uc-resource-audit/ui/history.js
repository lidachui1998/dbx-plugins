"use strict";

globalThis.UcAuditHistory = (() => {
  const labels = {
    id: "ID", uuid: "UUID", app_code: "应用", name: "名称", identity: "编码", type: "资源类型",
    is_halt: "停用状态", list_order: "排序", parent_id: "父级", hidden: "隐藏状态",
    permission: "权限码", link: "地址", unit_id: "适用单位", unit_type: "单位类型",
    device: "设备", resource_id: "资源 UUID", override_id: "覆盖资源", is_dir: "目录",
    icon: "图标", icon_type: "图标类型", win_type: "窗口类型", win_name: "窗口名称",
    lic_code: "授权码", auth: "授权控制", stretch: "平铺", sync_hotel: "同步到酒店",
    create_user: "创建人", create_datetime: "创建时间", modify_user: "修改人", modify_datetime: "修改时间",
  };
  const writeFields = new Set(["id", "uuid", "modify_user", "modify_datetime"]);
  const source = { audit: "字段审计", operation: "操作日志", entity: "实体操作", record: "资源主记录" };
  const target = entity => entity === "resource_relation" ? "资源关系" : "资源";
  const fieldKey = field => String(field || "").replace(/[A-Z]/g, char => "_" + char.toLowerCase());
  const asText = value => value == null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
  const changed = (field, before, after) => ({ field: fieldKey(field), before: asText(before), after: asText(after) });

  function event(row, operation, origin, changes = []) {
    return {
      at: UcAudit.timeKey(row.at_time), actor: row.actor, title: row.title, operation,
      entity: row.entity || "resource", recordId: row.record_id || "",
      source: origin, changes: changes.filter(change => change.field && change.before !== change.after),
    };
  }

  function auditEvents(rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = row.audit_parent && row.audit_parent !== "0" ? row.audit_parent : row.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups].map(([key, group]) => {
      const root = group.find(row => row.id === key) || group[0];
      return event(root, String(root.operation).toLowerCase(), source.audit,
        group.map(row => changed(row.field, row.before_value, row.after_value)));
    });
  }

  function snapshot(text) {
    if (text == null || text.trim() === "") return { values: null };
    try {
      const values = JSON.parse(text);
      if (values === null) return { values: null };
      if (typeof values === "object" && !Array.isArray(values)) {
        return { values: Object.keys(values).length ? values : null };
      }
    } catch {
      // 部分旧日志保留的快照不是有效 JSON，仍展示原文。
    }
    return { values: null, raw: text };
  }

  function snapshotEvent(row) {
    const before = snapshot(row.before_value);
    const after = snapshot(row.after_value);
    const operation = before.raw || after.raw ? "record"
      : !before.values && after.values ? "insert"
      : before.values && !after.values ? "delete" : "update";
    const oldValues = before.values || {};
    const newValues = after.values || {};
    // 更新日志的 after 是 DAO 更新参数，省略的字段不代表被删除。
    const fields = Object.keys(operation === "delete" ? oldValues : newValues);
    const changes = fields.map(field => changed(field, oldValues[field], newValues[field]));
    if (before.raw || after.raw) changes.push(changed("快照", before.raw ?? row.before_value, after.raw ?? row.after_value));
    return event(row, operation, source.operation, changes);
  }

  function entityEvents(rows, details) {
    const byEvent = new Map();
    for (const row of details) {
      if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
      byEvent.get(row.event_id).push(changed(row.field, row.before_value, row.after_value));
    }
    return rows.map(row => {
      const operation = /创建|新增|\binsert\b|\bcreate\b/i.test(row.title) ? "insert"
        : /删除|\bdelete\b/i.test(row.title) ? "delete"
        : /更新|修改|\bupdate\b/i.test(row.title) ? "update" : "record";
      return event(row, operation, source.entity, byEvent.get(row.id));
    });
  }

  function build(resource, auditRows, operationRows, entityRows, details) {
    const events = auditEvents(auditRows);
    for (const row of operationRows) {
      const next = snapshotEvent(row);
      const fields = next.changes.filter(change => !writeFields.has(change.field));
      const match = fields.length && events.find(existing => existing.source === source.audit &&
        existing.entity === next.entity && (existing.recordId === next.recordId ||
          (next.entity === "resource" && next.recordId === resource.uuid)) && existing.operation === next.operation &&
        existing.actor === next.actor && existing.at === next.at && fields.every(change =>
          existing.changes.some(other => other.field === change.field && other.before === change.before && other.after === change.after)));
      if (match) {
        match.source += " + " + source.operation;
        for (const change of next.changes) {
          if (!match.changes.some(other => other.field === change.field && other.before === change.before && other.after === change.after)) {
            match.changes.push(change);
          }
        }
      } else events.push(next);
    }
    events.push(...entityEvents(entityRows, details));
    const creation = { at_time: resource.create_datetime, actor: resource.create_user };
    if ((creation.at_time || creation.actor) && !events.some(row => row.entity === "resource" &&
      row.operation === "insert" && (!creation.at_time || row.at === UcAudit.timeKey(creation.at_time)) &&
      (!creation.actor || row.actor === creation.actor))) {
      events.push(event(creation, "insert", resource.deleted ? "删除前快照" : source.record));
    }
    for (const row of events) {
      if (row.title) continue;
      const subject = target(row.entity);
      const status = row.operation === "update" && row.changes.find(change => change.field === "is_halt");
      const action = status?.after === "T" ? "停用" : status?.after === "F" ? "启用"
        : ({ insert: "创建", update: "修改", delete: "删除" })[row.operation];
      row.title = action ? action + subject : subject + "操作";
    }
    return events.sort((a, b) => (a.at || "0000").localeCompare(b.at || "0000"));
  }

  return { build, labels };
})();
