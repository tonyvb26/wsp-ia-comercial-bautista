/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 * URL pública (con rewrite): /webhook/whatsapp
 *
 * Variables Vercel:
 *   WHATSAPP_VERIFY_TOKEN      — verificación del webhook (Meta)
 *   WHATSAPP_ACCESS_TOKEN      — token de la API (enviar mensajes)
 *   WHATSAPP_PHONE_NUMBER_ID   — ID del número que envía
 *   OPENAI_API_KEY             — (opcional) si existe, la respuesta la genera la IA
 *   OPENAI_MODEL               — (opcional) default gpt-4o-mini
 */

const GRAPH_VERSION = "v21.0";
const WHATSAPP_TEXT_MAX = 4000;

const SYSTEM_PROMPT = `Eres el asistente virtual de COMERCIAL BAUTISTA (Perú): carpintería metálica y fabricación industrial.
Habla en español, tono cercano y profesional, sin sonar robótico ni usar menús tipo "elige 1, 2 o 3".
Responde en mensajes breves, adecuados para WhatsApp (pocos párrafos).
No inventes precios ni plazos cerrados; si hace falta, ofrece pasar el caso a un asesor humano.
Si el cliente saluda sin más, preséntate brevemente y pregunta en qué puedes ayudarle hoy.`;

function extractTextMessages(body) {
  const out = [];
  if (!body?.entry) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.messages) continue;
      for (const msg of value.messages) {
        if (msg.type === "text" && msg.text?.body && msg.from) {
          out.push({ from: msg.from, body: msg.text.body, id: msg.id });
        }
      }
    }
  }
  return out;
}

async function generateAssistantReply(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.65,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });

  const raw = await r.text();
  if (!r.ok) {
    console.error("OpenAI error", r.status, raw);
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("OpenAI respuesta no JSON");
    return null;
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  return text.slice(0, WHATSAPP_TEXT_MAX);
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
    try {
      if (req.body && typeof req.body === "object") {
        console.log("WhatsApp webhook:", JSON.stringify(req.body));
        const texts = extractTextMessages(req.body);
        for (const { from, body } of texts) {
          let reply = await generateAssistantReply(body);
          if (!reply) {
            reply = `Gracias por escribirnos. Hemos recibido: «${body}». En breve un asesor puede continuar por aquí.`;
          }
          await sendTextReply(from, reply);
        }
      }
    } catch (e) {
      console.error("Webhook POST error:", e);
    }

    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
};
