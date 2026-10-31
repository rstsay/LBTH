async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "無法確認登入，請重新申請登入。");
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

document.querySelectorAll("[data-verification]").forEach((form) => {
  let submitting = false;
  const button = form.querySelector("button[type=submit]");
  const status = document.querySelector("[data-verification-status]");
  const error = document.querySelector(".form-error");

  const confirm = async () => {
    if (submitting) return;
    submitting = true;
    button.disabled = true;
    try {
      const values = new FormData(form);
      const role = form.dataset.verification;
      await postJson(role === "admin" ? "/admin/auth/verify" : "/auth/verify", {
        token: values.get("token"),
        requestId: values.get("requestId"),
      });
      document.querySelector("main").innerHTML =
        "<p class=\"muted\" data-verification-status>已確認，請回到登入頁面。</p>";
    } catch (verificationError) {
      if (status) status.textContent = "";
      if (verificationError.code === "PLAYER_SESSION_ACTIVE" || verificationError.code === "PLAYER_GAME_SESSION_ACTIVE") {
        if (error) error.textContent = verificationError.message;
        form.hidden = true;
        return;
      }
      if (error) error.textContent = verificationError.message;
      form.hidden = false;
      button.hidden = false;
      button.disabled = false;
      submitting = false;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void confirm();
  });
  void confirm();
});
