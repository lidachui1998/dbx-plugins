"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
require("../ui/unit-queries.js");

const q = globalThis.UcUnitMaintenance;
const schema = "uc_plugin_fixture";
const port = process.env.UC_PLUGIN_TEST_MYSQL_PORT;
const mysql = process.env.UC_PLUGIN_TEST_MYSQL_EXE ?? "mysql";
const administrator = "test-user";
const serverB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function sql(statement, database = schema) {
  const options = ["--no-defaults", "--protocol=TCP", "--host=127.0.0.1", "--port=" + port, "--user=root",
    "--default-character-set=utf8mb4", "--batch", "--raw", "--column-names"];
  if (database) options.push(database);
  const execution = spawnSync(mysql, options, { input: statement, encoding: "utf8", windowsHide: true });
  assert.equal(execution.status, 0, execution.stderr || String(execution.error));
  return execution.stdout.trim();
}

function rows(result) {
  if (!result) return [];
  const [header, ...data] = result.split(/\r?\n/).map(line => line.split("\t"));
  return data.map(row => Object.fromEntries(header.map((name, i) => [name, row[i] === "NULL" ? null : row[i]])));
}

function makePlan(code, action, value = "", changeInner = false) {
  const [unit] = rows(sql(q.findUnit(schema, code)));
  assert.equal(unit.code, code);
  const tables = q.catalog(rows(sql(q.metadata(schema))));
  const references = rows(sql(q.foreignKeys(schema)));
  const plan = q.plan({ schema, tables, unit, action, value, operator: administrator, changeInner, references });
  const counts = new Map();
  for (const query of q.previewQueries(schema, plan.checks)) {
    for (const row of rows(sql(query))) counts.set(row.check_key, row.matched);
  }
  return [plan, q.assess(plan, counts)];
}

function runPlan(plan, assessment, finish = "ROLLBACK;", uuid) {
  const serverUuid = uuid ?? rows(sql("SELECT @@server_uuid AS server_uuid"))[0].server_uuid;
  const script = q.makeScript(plan, assessment, serverUuid);
  assert.doesNotMatch(script, /^\s*COMMIT\b/m);
  return sql(script + "\n" + finish);
}

test("单位查找把引号和 SQL 模式敏感字符编码为安全字面量", () => {
  const input = "'\\;DROP TABLE 组织";
  const query = q.findUnit("uc-name", input);
  assert.ok(query.includes("_utf8mb4 X'"));
  assert.ok(!query.includes(input));
  assert.match(query, /parent_id = '-1'/);
});

test("真实 MySQL 执行三类事务并阻止不匹配范围", { skip: !port }, async t => {
  if (!/^[1-9]\d{3,4}$/.test(port) || Number(port) <= 1024 || Number(port) === 3306) {
    throw new Error("测试只允许运行在独立 MySQL 实例的专用端口。");
  }
  sql("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "");
  sql(
    "CREATE TABLE app (id INT PRIMARY KEY) ENGINE=InnoDB;" +
    "CREATE TABLE organization (id BIGINT PRIMARY KEY, uuid VARCHAR(60) NOT NULL UNIQUE, code VARCHAR(50) NOT NULL, " +
    "inner_code VARCHAR(50), type VARCHAR(20) NOT NULL, parent_id VARCHAR(60), unit_id VARCHAR(60), name VARCHAR(60), " +
    "is_halt CHAR(1) DEFAULT 'F', modify_user VARCHAR(30), modify_datetime DATETIME) ENGINE=InnoDB;" +
    "CREATE TABLE unit_app (id INT PRIMARY KEY, unit_id VARCHAR(60)) ENGINE=InnoDB;" +
    "CREATE TABLE app_step (id INT PRIMARY KEY, org_code VARCHAR(32) CHARACTER SET utf8 NOT NULL, " +
    "state INT NOT NULL, INDEX idx_org_code (org_code)) ENGINE=InnoDB;" +
    "CREATE TABLE user_hotel_map (unit_id VARCHAR(60), hotel_group_code VARCHAR(50), hotel_code VARCHAR(50)) ENGINE=InnoDB;" +
    "CREATE TABLE user_unit_map (unit_id VARCHAR(60), manage_unit_code VARCHAR(50)) ENGINE=InnoDB;" +
    "CREATE TABLE unit_tree_relation (child_key VARCHAR(50), parent_key VARCHAR(50)) ENGINE=InnoDB;" +
    "CREATE TABLE unit_associate (child_code VARCHAR(50), parent_code VARCHAR(50)) ENGINE=InnoDB;" +
    "CREATE TABLE resource_relation (unit_id TEXT, unit_type VARCHAR(20)) ENGINE=InnoDB;" +
    "CREATE TABLE organization_change_record (organization_id VARCHAR(64), change_type VARCHAR(32), before_value VARCHAR(255), " +
    "after_value VARCHAR(255), change_source VARCHAR(32), create_user VARCHAR(64), create_datetime DATETIME) ENGINE=InnoDB;" +
    "CREATE TABLE plugin_custom_ref (own_key VARCHAR(60), FOREIGN KEY (own_key) REFERENCES organization(uuid) ON DELETE CASCADE) ENGINE=InnoDB;" +
    "INSERT INTO organization (id, uuid, code, inner_code, type, parent_id, unit_id, name) VALUES " +
    "(1,'hotel-01','HOTEL-OLD','KEY001','HOTEL','-1',NULL,'第一酒店')," +
    "(2,'dept-01','HOTEL-OLD_DEPT_DEF',NULL,'','hotel-01','hotel-01','默认部门')," +
    "(3,'empty-03','EMPTY-03','KEY003','HOTEL','-1',NULL,'空酒店')," +
    "(4,'type-04','TYPE-04','KEY004','HOTEL','-1',NULL,'待变更酒店')," +
    "(5,'delete-05','DELETE-05','KEY005','HOTEL','-1',NULL,'含外键酒店')," +
    "(6,'other-06','OTHER-06','HOTEL-OLD','HOTEL','-1',NULL,'其他酒店');" +
    "INSERT INTO unit_app VALUES (1,'empty-03');" +
    "INSERT INTO app_step VALUES (1,'KEY001',0),(2,'KEY001',1),(3,'KEY001',2)," +
    "(4,'-1',0),(5,'HOTEL-OLD',2),(6,'KEY004',2);" +
    "INSERT INTO user_hotel_map VALUES ('other','GROUP','HOTEL-OLD');" +
    "INSERT INTO user_unit_map VALUES ('other','KEY001');" +
    "INSERT INTO unit_tree_relation VALUES ('KEY001','GROUPKEY');" +
    "INSERT INTO unit_associate VALUES ('KEY001','GROUPKEY');" +
    "INSERT INTO plugin_custom_ref VALUES ('delete-05');"
  );

  await t.test("外码和默认部门、引用、历史在同一事务内变更", () => {
    const [plan, assessment] = makePlan("HOTEL-OLD", "code", "HOTEL-NEW");
    assert.equal(assessment.blocked, false);
    assert.match(runPlan(plan, assessment, "COMMIT;"), /verification_ok\tresult\r?\n1\t/);
    assert.deepEqual(rows(sql("SELECT code, inner_code, modify_user FROM organization WHERE id=1")),
      [{ code: "HOTEL-NEW", inner_code: "KEY001", modify_user: administrator }]);
    assert.equal(rows(sql("SELECT code FROM organization WHERE id=2"))[0].code, "HOTEL-NEW_DEPT_DEF");
    assert.equal(rows(sql("SELECT hotel_code FROM user_hotel_map"))[0].hotel_code, "HOTEL-NEW");
    const steps = assessment.rows.find(row => row.label === "app_step.org_code");
    assert.equal(steps.effect, "info");
    assert.equal(steps.matched, "3");
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM app_step WHERE org_code='KEY001'"))[0].total, "3");
    assert.equal(rows(sql("SELECT before_value, after_value, change_source FROM organization_change_record"))[0].change_source, "MANUAL");
  });

  await t.test("同步内部码的关系可随事务整体回滚", () => {
    const [plan, assessment] = makePlan("HOTEL-NEW", "code", "HOTEL-INNER", true);
    assert.equal(assessment.blocked, false);
    const steps = assessment.rows.find(row => row.label === "app_step.org_code");
    assert.equal(steps.effect, "write");
    assert.equal(steps.matched, "3");
    const result = runPlan(plan, assessment, [
      "SELECT child_key FROM unit_tree_relation;",
      "SELECT manage_unit_code FROM user_unit_map;",
      "SELECT id, org_code, state FROM app_step ORDER BY id;",
      "ROLLBACK;",
    ].join("\n"));
    assert.match(result, /child_key\r?\nHOTEL-INNER/);
    assert.match(result, /manage_unit_code\r?\nHOTEL-INNER/);
    assert.match(result, /1\tHOTEL-INNER\t0\r?\n2\tHOTEL-INNER\t1\r?\n3\tHOTEL-INNER\t2/);
    assert.match(result, /4\t-1\t0\r?\n5\tHOTEL-OLD\t2/);
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM app_step WHERE org_code='KEY001'"))[0].total, "3");
    const tooLong = makePlan("HOTEL-NEW", "code", "A".repeat(33), true)[1];
    assert.equal(tooLong.rows.find(row => row.label === "app_step.org_code").blocked, true);
    assert.equal(rows(sql("SELECT child_code FROM unit_associate"))[0].child_code, "KEY001");
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM organization_change_record"))[0].total, "1");
  });

  await t.test("类型修改处理资源多单位关系及 MySQL 实例保护", () => {
    sql("INSERT INTO resource_relation VALUES ('different,type-04','HOTEL');");
    assert.equal(makePlan("TYPE-04", "type", "CATERING")[1].blocked, true);
    sql("DELETE FROM resource_relation;");
    const [plan, assessment] = makePlan("TYPE-04", "type", "CATERING");
    assert.equal(assessment.blocked, false);
    assert.match(runPlan(plan, assessment, "ROLLBACK;", serverB), /verification_ok\tresult\r?\n0\t/);
    assert.match(runPlan(plan, assessment, "COMMIT;"), /verification_ok\tresult\r?\n1\t/);
    assert.equal(rows(sql("SELECT type FROM organization WHERE id=4"))[0].type, "CATERING");
  });

  await t.test("存在部门、外键或预览后出现新引用时阻止删除", () => {
    assert.equal(makePlan("HOTEL-NEW", "delete")[1].blocked, true);
    assert.equal(makePlan("DELETE-05", "delete")[1].blocked, true);
    const [plan, assessment] = makePlan("EMPTY-03", "delete");
    assert.equal(assessment.blocked, false);
    sql("INSERT INTO unit_app VALUES (2,'empty-03');");
    assert.match(runPlan(plan, assessment), /verification_ok\tresult\r?\n0\t/);
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM unit_app"))[0].total, "2");
    sql("DELETE FROM unit_app WHERE id=2;");
    assert.match(runPlan(plan, assessment, "COMMIT;"), /verification_ok\tresult\r?\n1\t/);
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM unit_app"))[0].total, "0");
    assert.equal(rows(sql("SELECT COUNT(*) AS total FROM organization WHERE id=3"))[0].total, "0");
  });
});
