/** Misma familia que la consola de Meta (v25 en UI); v22 suele ser estable en Cloud API. */
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";

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
  /** Opcional: si GET al número falla con token temporal, pasa el WABA ID de la pantalla de Meta. */
  const wabaIdOverride = String(req.query.waba_id || "").replace(/\D/g, "");

  if (!verifyToken || !accessToken) {
    res.writeHead(500);
    res.end(
      JSON.stringify({
        ok: false,
        error: "Faltan variables en Vercel",
        env: {
          WHATSAPP_VERIFY_TOKEN: Boolean(verifyToken),
          WHATSAPP_ACCESS_TOKEN: Boolean(accessToken),
          WHATSAPP_PHONE_NUMBER_ID: Boolean(phoneNumberId),
          hint: "Si solo falta phone id, usa ?waba_id=TU_WABA_ID (solo dígitos) en la misma URL.",
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
    let wabaId = wabaIdOverride || null;
    let phone = null;

    if (wabaId) {
      try {
        phone = await graphJson(wabaId, accessToken, {
          fields: "id,name,account_review_status",
        });
      } catch {
        phone = null;
      }
    } else if (phoneNumberId) {
      try {
        phone = await graphJson(phoneNumberId, accessToken, {
          fields: "id,display_phone_number,verified_name,whatsapp_business_account",
        });
        wabaId = phone?.whatsapp_business_account?.id || null;
      } catch (e) {
        res.writeHead(e.status || 400);
        res.end(
          JSON.stringify({
            ok: false,
            error: e.message,
            details: e.data || null,
            hint:
              "El token de 'Generar' en la consola caduca y a veces no puede leer el número. Opciones: (1) En Business Manager crea un token permanente de usuario del sistema con permisos WhatsApp para este WABA y ponlo en WHATSAPP_ACCESS_TOKEN. (2) Añade a esta URL &waba_id=TU_WABA_ID (solo dígitos; es el 'Identificador de la cuenta de WhatsApp Business' en la misma pantalla de Meta) y vuelve a intentar.",
          })
        );
        return;
      }
    } else {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          ok: false,
          error: "Falta WHATSAPP_PHONE_NUMBER_ID y no se pasó waba_id en la URL",
        })
      );
      return;
    }

    if (!wabaId) {
      res.writeHead(500);
      res.end(
        JSON.stringify({
          ok: false,
          error: "No se pudo obtener el WABA",
          phone,
          hint: "Prueba el mismo enlace añadiendo &waba_id=TU_WABA_ID (solo dígitos, el de Meta junto al número).",
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
        phone: phone
          ? {
              id: phone.id,
              display_phone_number: phone.display_phone_number,
              verified_name: phone.verified_name,
            }
          : null,
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
