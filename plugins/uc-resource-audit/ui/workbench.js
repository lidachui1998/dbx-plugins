"use strict";

(async () => {
  const host = window.dbxPlugin;
  const message = document.getElementById("workbench-loading");
  const timeout = setTimeout(() => {
    message.textContent = "DBX 工作台尚未完成初始化，请关闭后重新打开。";
  }, 10000);
  try {
    await host?.ready;
    const maintenance = host?.contributionId === "com.greencloud.uc.resource-audit.unit-maintenance";
    const scripts = maintenance ? ["unit-queries.js", "unit-app.js"] : ["queries.js", "history.js", "app.js"];
    document.getElementById(maintenance ? "unit-maintenance" : "resource-audit").hidden = false;
    for (const path of scripts) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./" + path;
        script.onload = resolve;
        script.onerror = reject;
        document.body.append(script);
      });
    }
    message.hidden = true;
  } catch {
    message.textContent = "工作台加载失败，请关闭后重新打开。";
  } finally {
    clearTimeout(timeout);
  }
})();
