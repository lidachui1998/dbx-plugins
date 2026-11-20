"use strict";

globalThis.UcUnitMaintenance = (() => {
  const types = {
    ALLIANCE: "联盟", GROUP: "集团", HOTEL: "酒店", HOTEL_TEMPLATE: "模板酒店",
    GC: "绿云", SUPPLIER: "供应商", COMPANY: "协议公司", DISTRIBUTOR: "分销商",
    SCENIC_AREA: "景区集团", SCENIC_SPOT: "景点", CATERING_CHAIN_LIKE: "餐饮集团",
    CATERING: "餐饮", MANAGE: "管理单位",
  };
  const operations = { code: "修改单位代码", type: "修改单位类型", delete: "删除单位" };
  const identity = ["id", "uuid", "code", "inner_code", "type", "parent_id", "unit_id", "name", "is_halt", "modify_user", "modify_datetime"];
  const history = ["organization_id", "change_type", "before_value", "after_value", "change_source", "create_user", "create_datetime"];
  // 当前 UC 同步链路使用的外码字段，以及 UC 已确认的酒店集团关系。
  const outer = {
    hotel_group_relation: ["hotel_code", "group_code"],
    user_hotel_map: ["hotel_code", "hotel_group_code"],
    user_hotel_group_map: ["hotel_group_code"],
    resource_access_history: ["unit_code"],
  };
  const inner = {
    unit_tree_relation: ["child_key", "parent_key"],
    unit_associate: ["child_code", "parent_code"],
    user_unit_map: ["manage_unit_code"],
  };
  const archived = /(?:^|_)(?:bak|backup|history|log|archive|audit)(?:_|$)|^entity_operation(?:_|$)|^organization_change_record$|^biz_sync_task$/i;
  const idColumn = /^(?:(?:parent_|child_|target_|from_|to_|u_)?(?:org(?:anization)?|unit|hotel(?:_group)?)(?:_unit)?_(?:id|uuid)|(?:parent|child)_(?:id|uuid))$/;
  const codeColumn = /^(?:(?:(?:e_|p_|u_|manage_|parent_|child_|qrcode_|target_|entity_|from_|to_|sync_|external_)?(?:org(?:anization)?|unit|hotel(?:_group)?)|group)_(?:inner_|outer_)?code)$/;
  const sqlName = value => "\x60" + String(value).replaceAll("\x60", "\x60\x60") + "\x60";
  const tableName = (schema, table) => sqlName(schema) + "." + sqlName(table);
  const sqlText = value => {
    const hex = Array.from(new TextEncoder().encode(String(value)), byte => byte.toString(16).padStart(2, "0")).join("");
    return "_utf8mb4 X'" + hex + "'";
  };
  const match = (column, value) => sqlName(column) + " = " + sqlText(value);
  const dbRoot = "parent_id = '-1'";
  const codePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const integerType = /^(?:tinyint|smallint|mediumint|int|bigint|decimal)$/;
  const textType = /^(?:char|varchar|tinytext|text|mediumtext|longtext)$/;

  function discover() {
    return "SELECT TABLE_SCHEMA AS db FROM information_schema.TABLES " +
      "WHERE TABLE_NAME IN ('organization','unit_app','app') AND TABLE_TYPE='BASE TABLE' " +
      "GROUP BY TABLE_SCHEMA HAVING COUNT(DISTINCT TABLE_NAME)=3 ORDER BY TABLE_SCHEMA";
  }

  function metadata(schema) {
    return "SELECT c.TABLE_NAME AS tbl, c.COLUMN_NAME AS col, c.DATA_TYPE AS kind, " +
      "c.CHARACTER_MAXIMUM_LENGTH AS capacity, t.ENGINE AS engine " +
      "FROM information_schema.COLUMNS c JOIN information_schema.TABLES t " +
      "ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME " +
      "WHERE c.TABLE_SCHEMA=" + sqlText(schema) + " AND t.TABLE_TYPE='BASE TABLE' " +
      "ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";
  }

  function foreignKeys(schema) {
    return "SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_COLUMN_NAME AS ref_col " +
      "FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=" + sqlText(schema) +
      " AND REFERENCED_TABLE_SCHEMA=TABLE_SCHEMA AND REFERENCED_TABLE_NAME='organization'";
  }

  function findUnit(schema, value) {
    const needle = sqlText(value);
    const source = tableName(schema, "organization");
    const id = /^\d{1,20}$/.test(value) ? " OR id = " + value : "";
    return "SELECT CAST(id AS CHAR) AS id, uuid, code, inner_code, type, name, is_halt FROM " + source +
      " WHERE " + dbRoot + " AND (code=" + needle + " OR uuid=" + needle + " OR inner_code=" + needle +
      id + " OR LOCATE(" + needle + ", name)>0)" +
      " ORDER BY (code=" + needle + ") DESC, code, id LIMIT 31";
  }

  function catalog(rows) {
    const tables = new Map();
    for (const {tbl, col, kind, capacity, engine} of rows) {
      if (!tables.has(tbl)) tables.set(tbl, { engine, columns: new Map() });
      tables.get(tbl).columns.set(col, { kind, capacity: Number(capacity || 0) });
    }
    return tables;
  }

  function requireColumns(tables, name, columns) {
    const table = tables.get(name);
    if (!table || !columns.every(column => table.columns.has(column))) {
      throw new Error("当前库缺少 " + name + " 的必需字段。");
    }
    return table;
  }

  function unitSnapshot(unit) {
    if (!/^[1-9]\d*$/.test(unit.id) || !unit.uuid || !unit.code || !unit.type) {
      throw new Error("单位主记录缺少必要的标识、代码或类型。");
    }
    return "id = " + unit.id + " AND " + dbRoot + ["uuid", "code", "inner_code", "type"]
      .map(column => " AND BINARY " + sqlName(column) + " <=> " +
        (unit[column] == null ? "NULL" : "BINARY " + sqlText(unit[column]))).join("");
  }

  function addCheck(checks, table, label, predicate, effect, write = null) {
    checks.push({ key: "c" + checks.length, table, label, predicate, effect, write });
  }

  function plan({ schema, tables, unit, action, value, operator, references = [], changeInner = false }) {
    if (!Object.hasOwn(operations, action)) throw new Error("请选择维护动作。");
    const organization = requireColumns(tables, "organization", identity);
    requireColumns(tables, "unit_app", ["unit_id"]);
    const snapshot = unitSnapshot(unit);
    if (action !== "delete" && (!operator || operator.length > organization.columns.get("modify_user").capacity)) {
      throw new Error("请输入有效的 UC 操作人工号，长度不能超过 " +
        organization.columns.get("modify_user").capacity + " 个字符。");
    }
    const checks = [];
    addCheck(checks, "organization", "单位主记录", snapshot, "required");
    const departmentScope = "parent_id <> '-1' AND (" + match("unit_id", unit.uuid) + " OR " + match("parent_id", unit.uuid) + ")";
    if (action === "code") {
      if (!codePattern.test(value) || value.length > organization.columns.get("code").capacity ||
          value.length + "_DEPT_DEF".length > organization.columns.get("code").capacity || value === unit.code) {
        throw new Error("新代码须不同于当前代码，使用英文字母、数字、下划线或连字符，并为默认部门后缀保留长度。");
      }
      if (changeInner && (!unit.inner_code || value.length > organization.columns.get("inner_code").capacity)) {
        throw new Error("同步内部码需要现有内部码，并符合内部码字段长度。");
      }
      requireColumns(tables, "organization_change_record", history);
      addCheck(checks, "organization", "旧外部码重复", dbRoot + " AND id <> " + unit.id +
        " AND " + match("code", unit.code), "block");
      addCheck(checks, "organization", "新代码已被其他单位使用", dbRoot + " AND id <> " + unit.id +
        " AND (" + match("code", value) + " OR " + match("inner_code", value) + ")", "block");
      if (changeInner) {
        addCheck(checks, "organization", "旧内部码重复", dbRoot + " AND id <> " + unit.id +
          " AND " + match("inner_code", unit.inner_code), "block");
      }
      const oldDefault = unit.code + "_DEPT_DEF";
      const newDefault = value + "_DEPT_DEF";
      addCheck(checks, "organization", "默认部门代码", departmentScope + " AND " + match("code", oldDefault),
        "write", { column: "code", value: newDefault, withAudit: true, maxRows: 1 });
      addCheck(checks, "organization", "新默认部门代码已存在", departmentScope + " AND " +
        match("code", newDefault) + " AND NOT (" + match("code", oldDefault) + ")", "block");
      addCodeReferences(checks, tables, unit, value, changeInner);
    } else {
      if (action === "type" && (!Object.hasOwn(types, value) || value === unit.type)) {
        throw new Error("请选择与原类型不同的 UC 单位类型。");
      }
      addCheck(checks, "organization", "下属部门", departmentScope, action === "delete" ? "block" : "info");
      addCheck(checks, "unit_app", "单位应用开通记录", match("unit_id", unit.uuid),
        action === "delete" ? "write" : "info", action === "delete" ? { remove: true } : null);
      addUnitReferences(checks, tables, unit, action);
      if (action === "delete") {
        for (const {tbl, col, ref_col} of references) {
          if (!Object.hasOwn(unit, ref_col) || unit[ref_col] == null) {
            throw new Error("存在需要人工核对的单位外键 " + tbl + "." + col + "。");
          }
          const reference = ref_col === "id" ? sqlName(col) + " = " + unit.id : match(col, unit[ref_col]);
          const predicate = reference + (tbl === "organization" ? " AND id <> " + unit.id : "");
          addCheck(checks, tbl, "外键 " + tbl + "." + col, predicate, "block");
        }
      }
    }
    return { schema, tables, unit, action, value, operator, changeInner, snapshot, checks };
  }

  function addCodeReferences(checks, tables, unit, nextCode, changeInner) {
    for (const [table, details] of tables) {
      if (table === "organization") continue;
      if (table === "sync_org_mapping") {
        const mapping = ["u_org_id", "u_unit_id"].filter(col => details.columns.has(col));
        if (mapping.length) {
          addCheck(checks, table, "上游组织映射", "(" + mapping.map(col => match(col, unit.uuid)).join(" OR ") + ")", "block");
        }
      }
      for (const [col, meta] of details.columns) {
        if (!textType.test(meta.kind)) continue;
        const changesOuter = Object.hasOwn(outer, table) && outer[table].includes(col);
        const changesInner = Object.hasOwn(inner, table) && inner[table].includes(col);
        if (changesInner) {
          if (unit.inner_code) {
            addCheck(checks, table, table + "." + col, match(col, unit.inner_code),
              changeInner && unit.inner_code !== nextCode ? "write" : "info",
              changeInner && unit.inner_code !== nextCode ? { column: col, value: nextCode } : null);
          }
        } else if (changesOuter) {
          addCheck(checks, table, table + "." + col, match(col, unit.code), "write", { column: col, value: nextCode });
        } else if (!archived.test(table) && codeColumn.test(col)) {
          const oldCodes = [unit.code];
          if (changeInner && unit.inner_code !== unit.code && unit.inner_code !== nextCode) oldCodes.push(unit.inner_code);
          const predicate = oldCodes.map(code => match(col, code)).join(" OR ");
          addCheck(checks, table, table + "." + col, "(" + predicate + ")", "review");
        }
      }
    }
  }

  function addUnitReferences(checks, tables, unit, action) {
    for (const [table, details] of tables) {
      if (table === "organization" || table === "unit_app" || archived.test(table)) continue;
      const matchedColumns = [];
      for (const [col, meta] of details.columns) {
        if (table === "resource_relation" && col === "unit_id") {
          matchedColumns.push("FIND_IN_SET(" + sqlText(unit.uuid) + ", unit_id) > 0");
        } else if (Object.hasOwn(inner, table) && inner[table].includes(col) && unit.inner_code) {
          matchedColumns.push(match(col, unit.inner_code));
        } else if (idColumn.test(col)) {
          if (integerType.test(meta.kind) && /^(?:u_)?(?:org|organization|unit)(?:_unit)?_id$/.test(col)) {
            matchedColumns.push(sqlName(col) + " = " + unit.id);
          } else if (textType.test(meta.kind)) {
            matchedColumns.push(match(col, unit.uuid));
          }
        } else if (textType.test(meta.kind) && codeColumn.test(col)) {
          matchedColumns.push(match(col, unit.code));
          if (unit.inner_code && unit.code !== unit.inner_code) matchedColumns.push(match(col, unit.inner_code));
        }
      }
      if (!matchedColumns.length) continue;
      const managesTopology = table === "hotel_group_relation" || Object.hasOwn(inner, table) ||
        /^(?:sso_unit_mapping_relation|sync_org_mapping|biz_sync_config)$/.test(table);
      const hasTypeField = ["unit_type", "org_type", "u_unit_type", "u_org_type"].some(col => details.columns.has(col));
      addCheck(checks, table, table, "(" + matchedColumns.join(" OR ") + ")",
        action === "delete" || managesTopology || hasTypeField ? "block" : "info");
    }
  }

  const countSql = (schema, check) => "(SELECT COUNT(*) FROM " + tableName(schema, check.table) + " WHERE " + check.predicate + ")";
  function previewQueries(schema, checks) {
    const batches = [];
    for (let offset = 0; offset < checks.length; offset += 20) {
      batches.push(checks.slice(offset, offset + 20).map(check =>
        "SELECT '" + check.key + "' AS check_key, CAST(" + countSql(schema, check) + " AS CHAR) AS matched"
      ).join("\nUNION ALL\n"));
    }
    return batches;
  }

  function assess(plan, counts) {
    const rows = plan.checks.map(check => {
      const matched = String(counts.get(check.key));
      if (!/^\d+$/.test(matched)) throw new Error("预览结果不完整，请重新检查。");
      return { ...check, matched };
    });
    for (const row of rows) {
      row.blocked = row.effect === "required" && row.matched !== "1" ||
        ["block", "review"].includes(row.effect) && row.matched !== "0" ||
        row.write?.maxRows != null && BigInt(row.matched) > BigInt(row.write.maxRows);
      if (row.effect === "write" && row.matched !== "0") {
        const details = plan.tables.get(row.table);
        const capacity = details.columns.get(row.write.column)?.capacity;
        if (details.engine !== "InnoDB" || capacity && row.write.value.length > capacity) row.blocked = true;
      }
    }
    const writes = ["organization", ...(plan.action === "code" ? ["organization_change_record"] : [])];
    const unsupported = writes.filter(table => plan.tables.get(table).engine !== "InnoDB");
    return { rows, unsupported, blocked: rows.some(check => check.blocked) || unsupported.length > 0 };
  }

  function makeScript(plan, assessment, serverUuid) {
    if (assessment.blocked) throw new Error("请先处理预览中的阻止项。");
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(serverUuid)) throw new Error("无法确认目标 MySQL 实例。");
    const {schema, unit, action, value, operator, changeInner, snapshot} = plan;
    const organization = tableName(schema, "organization");
    const stamp = "modify_user = " + sqlText(operator) + ", modify_datetime = NOW()";
    const sql = [
      "-- 在已预览的 MySQL 实例下使用专用 SQL 标签页运行。请先选择目标数据库。",
      "-- 脚本停在事务内。若报错、校验失败或预览数量不符，立即在同一会话执行 ROLLBACK。",
      "SET @uc_unit_ok = 0, @uc_unit_id = NULL;",
      "START TRANSACTION;",
      "SELECT id INTO @uc_unit_id FROM " + organization + " WHERE " + snapshot + " FOR UPDATE;",
      "SET @uc_unit_ok = COALESCE(@uc_unit_id = " + unit.id + " AND BINARY DATABASE() = BINARY " +
        sqlText(schema) + " AND @@server_uuid = " + sqlText(serverUuid) + ", 0);",
    ];
    for (const check of assessment.rows) {
      if (check.effect === "info") continue;
      sql.push("SET @uc_unit_ok = @uc_unit_ok AND (" + countSql(schema, check) + " = " + check.matched + ");");
    }
    const write = (statement, expected) => {
      sql.push(statement + ";", "SET @uc_unit_ok = @uc_unit_ok AND (ROW_COUNT() = " + expected + ");");
    };
    for (const check of assessment.rows) {
      if (check.effect !== "write" || check.matched === "0") continue;
      const table = tableName(schema, check.table);
      const guard = " WHERE @uc_unit_ok = 1 AND " + check.predicate;
      if (check.write.remove) {
        write("DELETE FROM " + table + guard, check.matched);
      } else {
        const update = sqlName(check.write.column) + " = " + sqlText(check.write.value);
        write("UPDATE " + table + " SET " + update + (check.write.withAudit ? ", " + stamp : "") + guard, check.matched);
      }
    }
    const unitGuard = " WHERE @uc_unit_ok = 1 AND " + snapshot;
    if (action === "delete") {
      write("DELETE FROM " + organization + unitGuard, "1");
    } else {
      const field = action === "type" ? "type" : "code";
      const setters = [sqlName(field) + " = " + sqlText(value), stamp];
      if (action === "code" && changeInner) setters.push("inner_code = " + sqlText(value));
      write("UPDATE " + organization + " SET " + setters.join(", ") + unitGuard, "1");
    }
    if (action === "code") {
      write("INSERT INTO " + tableName(schema, "organization_change_record") +
        " (organization_id, change_type, before_value, after_value, change_source, create_user, create_datetime) " +
        "SELECT " + sqlText(unit.uuid) + ", 'UNIT_CODE', " + sqlText(unit.code) + ", " +
        sqlText(value) + ", 'MANUAL', " + sqlText(operator) + ", NOW() WHERE @uc_unit_ok = 1", "1");
    }
    sql.push(
      "SELECT @uc_unit_ok AS verification_ok, " +
        "IF(@uc_unit_ok = 1, '校验通过，复核后提交', '校验失败，请回滚') AS result;",
      "SELECT CAST(id AS CHAR) AS id, uuid, code, inner_code, type FROM " + organization + " WHERE id = " + unit.id + ";",
      "-- COMMIT;",
      "-- ROLLBACK;",
      "",
    );
    return sql.join("\n");
  }

  return { types, operations, discover, metadata, foreignKeys, findUnit, catalog, plan, previewQueries, assess, makeScript };
})();
