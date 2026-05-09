/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 *
 * Variables Vercel:
 *   WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *
 * Respuesta fija con la lista de datos para cotización (sin OpenAI ni lógica adicional).
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = "v21.0";

const GLADIS_CHECKLIST_REPLY = `Buenas, soy Gladis, asistente comercial de METALTEC - COMERCIAL BAUTISTA.

Para preparar tu cotización necesitamos estos datos:

Tipo de trabajo:
Medidas o medidas aprox.:
Material/acabado:
Cantidad:
Tipo hogar/industrial:
Nombre o RUC:
Ubicación/referencia:
Anexos (foto(s) referenciales, planos):

Si tienes alguna duda de algún ítem, puedes hacerme la pregunta correspondiente. Estoy aquí para guiarte.`;

const processedMessageIds = new Map();

function markProcessedMessage(id) {
  if (!id) return false;
  const now = Date.now();
  const prev = processedMessageIds.get(id);
  if (prev && now - prev < 1000 * 60 * 20) return true;
  processedMessageIds.set(id, now);
  if (processedMessageIds.size > 5000) {
    for (const [k, t] of processedMessageIds) {
      if (now - t > 1000 * 60 * 60) processedMessageIds.delete(k);
    }
  }
  return false;
}

/** Mensajes entrantes del usuario: texto, imagen o documento (mismo reply fijo). */
function extractInboundMessages(body) {
  const out = [];
  if (!body?.entry) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.messages) continue;
      for (const msg of value.messages) {
        if (msg.type === "text" && msg.text?.body && msg.from) {
          out.push({ from: msg.from, id: msg.id });
          continue;
        }
        if (msg.type === "image" && msg.from && msg.id) {
          out.push({ from: msg.from, id: msg.id });
          continue;
        }
        if (msg.type === "document" && msg.from && msg.id) {
          out.push({ from: msg.from, id: msg.id });
        }
      }
    }
  }
  return out;
}

async function sendTextReply(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !access) {
    console.error("Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  if (!r.ok) {
    console.error("Graph API error", r.status, raw);
    return;
  }
  console.log("Mensaje enviado OK:", raw);
}

async function processInbound(body) {
  if (!body || typeof body !== "object") return;

  console.log("WhatsApp webhook:", JSON.stringify(body));

  for (const { from, id } of extractInboundMessages(body)) {
    try {
      if (markProcessedMessage(id)) continue;
      // Si en WhatsApp no ves exactamente este texto, el deploy no trae este archivo o hay otro servidor en el webhook.
      console.log(
        "Gladis envío: lista fija (sin IA). Commit:",
        process.env.VERCEL_GIT_COMMIT_SHA || "n/d"
      );
      await sendTextReply(from, GLADIS_CHECKLIST_REPLY);
    } catch (e) {
      console.error("processInbound error:", e);
      try {
        if (from) {
          await sendTextReply(
            from,
            "Disculpa, tuvimos un inconveniente momentáneo. Si gustas, intenta nuevamente en unos segundos"
          );
        }
      } catch (inner) {
        console.error("Fail-safe send error:", inner);
      }
    }
  }
}

module.exports = async function handler(req, res) {
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!verify) {
      console.error("Falta WHATSAPP_VERIFY_TOKEN en Vercel");
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server misconfigured");
      return;
    }

    if (mode === "subscribe" && verifyToken === verify) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(challenge));
      return;
    }

    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (req.method === "POST") {
    const snapshot = req.body && typeof req.body === "object" ? req.body : null;

    waitUntil(
      processInbound(snapshot).catch((e) => {
        console.error("Webhook async process error:", e);
      })
    );

    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
};
