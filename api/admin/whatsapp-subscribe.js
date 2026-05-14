const GRAPH_VERSION = "v21.0";

async function graphJson(path, accessToken, options = {}) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  url.searchParams.set("access_token", accessToken);

  if (options.fields) {
    url.searchParams.set("fields", options.fields);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
  });
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Graph API ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const verifyToken = String(process.env.WHATSAPP_VERIFY_TOKEN || "").trim();
  const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const providedToken = String(req.query.token || req.headers["x-admin-token"] || "").trim();

  if (!verifyToken || !accessToken || !phoneNumberId) {
    res.writeHead(500);
    res.end(
      JSON.stringify({
        ok: false,
        error: "Faltan variables en Vercel",
        env: {
          WHATSAPP_VERIFY_TOKEN: Boolean(verifyToken),
          WHATSAPP_ACCESS_TOKEN: Boolean(accessToken),
          WHATSAPP_PHONE_NUMBER_ID: Boolean(phoneNumberId),
        },
      })
    );
    return;
  }

  if (providedToken !== verifyToken) {
    res.writeHead(403);
    res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
    return;
  }

  try {
    const phone = await graphJson(phoneNumberId, accessToken, {
      fields: "id,display_phone_number,verified_name,whatsapp_business_account",
    });

    const wabaId = phone?.whatsapp_business_account?.id;
    if (!wabaId) {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          ok: false,
          error: "No se pudo obtener el WABA desde WHATSAPP_PHONE_NUMBER_ID",
          phone,
        })
      );
      return;
    }

    let before = null;
    try {
      before = await graphJson(`${wabaId}/subscribed_apps`, accessToken);
    } catch (error) {
      before = { ok: false, status: error.status, error: error.data };
    }

    const subscription = await graphJson(`${wabaId}/subscribed_apps`, accessToken, {
      method: "POST",
    });

    let after = null;
    try {
      after = await graphJson(`${wabaId}/subscribed_apps`, accessToken);
    } catch (error) {
      after = { ok: false, status: error.status, error: error.data };
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        ok: true,
        phone: {
          id: phone.id,
          display_phone_number: phone.display_phone_number,
          verified_name: phone.verified_name,
        },
        wabaId,
        subscribed_apps_before: before,
        subscribe_result: subscription,
        subscribed_apps_after: after,
        next: "Ahora envia un WhatsApp real y revisa que aparezca POST /webhook/whatsapp en Vercel Logs.",
      })
    );
  } catch (error) {
    console.error("Admin WhatsApp subscribe error:", error);
    res.writeHead(error.status || 500);
    res.end(
      JSON.stringify({
        ok: false,
        error: error.message,
        details: error.data || null,
      })
    );
  }
};
