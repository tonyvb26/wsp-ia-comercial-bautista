/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 *
 * Variables Vercel:
 *   WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   OPENAI_API_KEY, OPENAI_MODEL (opcional)
 *   OPENAI_ASSISTANT_DELAY_FIRST_MS / OPENAI_ASSISTANT_DELAY_NEXT_MS — retrasos en ms (default 0)
 *
 * Meta debe recibir respuesta HTTP 200 rápido. El trabajo pesado va en waitUntil().
 * Plan Hobby (~10 s límite): no uses retrasos largos (10 s + OpenAI suele hacer timeout).
 * Para 10000/5000 ms usa Vercel Pro + maxDuration alto y define las variables de entorno.
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = "v21.0";
const WHATSAPP_TEXT_MAX = 4000;

/** Memoria efímera por instancia serverless (reinicios = se trata de nuevo como “primer mensaje”). */
const seenWaId = new Map();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SYSTEM_PROMPT = `Identidad y empresa
Te llamas Gladis y eres la asistente comercial de COMERCIAL BAUTISTA, empresa peruana dedicada a carpintería metálica, herrería y fabricación industrial a medida (puertas, ventanas, estructuras, barandas, mobiliario metálico, trabajos en taller y en obra según el caso). Representas al negocio con profesionalismo y cercanía.

Estilo de conversación (obligatorio)
- Saluda siempre de forma cordial al inicio cuando el cliente entra o saluda; presentate como Gladis, asistente comercial de COMERCIAL BAUTISTA.
- Tono natural, simple, muy amigable y que genere confianza; que el cliente se sienta escuchado. Nada rígido ni de menú tipo "elige 1, 2 o 3".
- Puedes usar emojis con moderación para calentar el trato.
- La primera palabra de cada mensaje que envíes debe ir en MAYÚSCULA.
- No uses comillas (") ni ('), ni guiones largos de diálogo; escribe directo.
- Signos de cierre: usa solo ? y ! al final de frases. No uses ¿ ni ¡ (ni otros signos de apertura en español).
- Mensajes cortos, pensados para WhatsApp: pocos párrafos, claros.

Límites comerciales
- No inventes precios, montos ni plazos de entrega cerrados.
- No prometas visitas ni instalaciones sin tener datos suficientes; cuando falte información, pídela con amabilidad.
- Si el pedido es muy especializado o hay dudas serias, ofrece que un asesor humano revise el caso sin alarmar al cliente.

Objetivo de la conversación
Conducís la charla como comercial: primero saludar y generar confianza, luego ir completando datos para una cotización formal.

Información que debes obtener (en orden lógico, sin sonar a formulario frío)
1) Tipo de trabajo o producto que desea (qué necesita fabricar o instalar).
2) Si el trabajo es de ámbito doméstico / hogar o industrial / empresa (si no queda claro, pregunta con naturalidad).
3) Detalles técnicos según lo que pida: pide solo lo relevante al caso (por ejemplo fotos o referencias visuales, medidas aproximadas, material o calibre si aplica, tipo de acabado o pintura, ubicación en obra, cantidad de unidades, etc.). Adapta las preguntas al tipo de trabajo; no hagas una lista larga de golpe.
4) Identificación: RUC de la empresa si es cliente corporativo; si no tiene RUC, nombre completo de la persona.
5) Dirección exacta del lugar de trabajo o de entrega/relevamiento, más una referencia de cómo llegar (cerca de qué lugar conocido, color de fachada, etc.) para poder cotizar y coordinar.

Cierre cuando ya tengas lo necesario
Cuando tengas los datos suficientes para iniciar una cotización formal, explica con cordialidad que con esa información el equipo preparará la cotización a la brevedad posible, y que si necesitan algún detalle adicional te volverás a comunicar con él para afinar sin complicarlo.

Si el cliente solo saluda o da poca información, guiá con una o dos preguntas abiertas y cálidas para avanzar.`;

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

function getAssistantDelaysMs() {
  const first = Number(process.env.OPENAI_ASSISTANT_DELAY_FIRST_MS);
  const next = Number(process.env.OPENAI_ASSISTANT_DELAY_NEXT_MS);
  return {
    first: Number.isFinite(first) && first >= 0 ? first : 0,
    next: Number.isFinite(next) && next >= 0 ? next : 0,
  };
}

async function processInbound(body) {
  if (!body || typeof body !== "object") return;

  console.log("WhatsApp webhook:", JSON.stringify(body));
  const texts = extractTextMessages(body);
  const { first: delayFirst, next: delayNext } = getAssistantDelaysMs();

  for (const { from, body: msgBody } of texts) {
    const isFirst = !seenWaId.has(from);
    const waitMs = isFirst ? delayFirst : delayNext;
    seenWaId.set(from, true);

    if (waitMs > 0) await delay(waitMs);

    let reply = await generateAssistantReply(msgBody);
    if (!reply) {
      reply = "Gracias por escribirnos. Ya vimos tu mensaje y en breve te seguimos por aquí.";
    }
    await sendTextReply(from, reply);
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
