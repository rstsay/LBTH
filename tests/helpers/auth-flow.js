export async function completeMagicLinkLogin(baseUrl, token, requestToken, requestId) {
  const approval = await fetch(`${baseUrl}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, requestId }),
  });
  if (!approval.ok) return approval;
  return fetch(`${baseUrl}/auth/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestToken }),
  });
}
