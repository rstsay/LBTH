async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "驗證失敗，請再試一次。");
  return result;
}

document.querySelectorAll("[data-verification]").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const error = form.querySelector(".form-error")
      || document.querySelector(".form-error");
    button.disabled = true;
    error.textContent = "";
    try {
      const token = new FormData(form).get("token");
      if (form.dataset.verification === "admin") {
        await postJson("/admin/auth/verify", { token });
        window.location.assign("/app?adminLogin=success");
        return;
      }

      await postJson("/auth/verify", { token });
      let notifiedOrigin = false;
      if ("BroadcastChannel" in window) {
        try {
          const channel = new BroadcastChannel("lbs-player-auth");
          channel.postMessage({ type: "player-authenticated" });
          channel.close();
          notifiedOrigin = true;
        } catch {
          // 使用 localStorage 通知原始分頁。
        }
      }
      if (!notifiedOrigin) {
        try {
          localStorage.setItem("lbs-player-authenticated", String(Date.now()));
        } catch {
          // 頁面仍會提供返回原頁的連結。
        }
      }
      document.querySelector("main").innerHTML = `
        <img class="brand-logo" src="/app/mustard-seed-logo.png" alt="芥菜總會標誌">
        <p class="eyebrow">Email 已確認</p>
        <h1>請返回原本的尋寶頁面</h1>
        <p class="muted">登入已完成，原始分頁會自動繼續。若沒有自動切換，請關閉此頁並返回原分頁。</p>
        <a class="button button-primary" href="/app">返回尋寶頁</a>
      `;
      try {
        window.close();
      } catch {
        // 部分瀏覽器不允許網頁關閉使用者開啟的分頁。
      }
    } catch (verificationError) {
      error.textContent = verificationError.message;
      button.disabled = false;
    }
  });
});
