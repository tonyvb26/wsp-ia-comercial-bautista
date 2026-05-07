/**
 * Webhook serverless para Vercel — WhatsApp Cloud API (Meta).
 *
 * Variables Vercel:
 *   WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   OPENAI_API_KEY, OPENAI_MODEL (opcional)
 *   OPENAI_ASSISTANT_DELAY_MS — retraso global por mensaje en ms (default 5000)
 *
 * Meta debe recibir respuesta HTTP 200 rápido. El trabajo pesado va en waitUntil().
 * Plan Hobby (~10 s límite): no uses retrasos largos (10 s + OpenAI suele hacer timeout).
 * Para 10000/5000 ms usa Vercel Pro + maxDuration alto y define las variables de entorno.
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = "v21.0";
const WHATSAPP_TEXT_MAX = 4000;
const MAX_HISTORY_TURNS = 12;

/** Memoria efímera por instancia serverless (reinicios = se trata de nuevo como “primer mensaje”). */
const seenWaId = new Map();
const conversationByWaId = new Map();
const processedMessageIds = new Map();
const confirmationStateByWaId = new Map();
const imageStateByWaId = new Map();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SYSTEM_PROMPT = `Identidad y empresa
Te llamas Gladis y eres la asistente comercial de COMERCIAL BAUTISTA, empresa peruana dedicada a carpintería metálica, herrería y fabricación industrial a medida (puertas, ventanas, estructuras, barandas, mobiliario metálico, trabajos en taller y en obra según el caso). Representas al negocio con profesionalismo y cercanía.

Estilo de conversación (obligatorio)
- Saluda siempre de forma cordial al inicio cuando el cliente entra o saluda; presentate como Gladis, asistente comercial de COMERCIAL BAUTISTA.
- Tono natural, simple, muy amigable y que genere confianza; que el cliente se sienta escuchado. Nada rígido ni de menú tipo "elige 1, 2 o 3".
- Usa emojis solo en 2 momentos: saludo inicial y cierre final de la conversación. En los demás mensajes no uses emojis.
- La primera palabra de cada mensaje debe tener solo la primera letra en mayúscula (ejemplo: Hola, Genial, Perfecto), no toda la palabra en mayúsculas.
- No uses comillas (") ni ('), ni guiones largos de diálogo; escribe directo.
- Signos de cierre: usa solo ? y ! al final de frases. No uses ¿ ni ¡ (ni otros signos de apertura en español).
- Mensajes cortos, pensados para WhatsApp: pocos párrafos, claros.
- No uses frases condescendientes o cumplidos al cliente (por ejemplo: excelente elección, suena bien, gran decisión).
- Para validar avance usa solo aperturas neutras: Genial, Muy bien, Perfecto o Claro.
- Nunca reinicies la conversación con saludo de inicio en mitad del flujo.
- Si el cliente se niega a compartir algún dato (por ejemplo dirección), responde con empatía y ofrece seguir con cotización referencial sin perder el contexto ya recolectado.

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
Antes de cerrar, muestra un resumen claro de especificaciones del trabajo y pide al cliente que confirme escribiendo exactamente CONFIRMO en mayúsculas.

Si el cliente solo saluda o da poca información, guiá con una o dos preguntas abiertas y cálidas para avanzar.`;

function getConversationHistory(waId) {
  const history = conversationByWaId.get(waId);
  return Array.isArray(history) ? history : [];
}

function appendConversationTurn(waId, role, content) {
  const history = getConversationHistory(waId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY_TURNS) {
    history.splice(0, history.length - MAX_HISTORY_TURNS);
  }
  conversationByWaId.set(waId, history);
}

function getFlattenedConversationText(waId) {
  const history = getConversationHistory(waId);
  return history.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function getFlattenedUserText(waId) {
  const history = getConversationHistory(waId);
  return history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

function normalizeAssistantReply(text) {
  if (!text) return text;
  let out = text.trim();
  out = out.replace(/[¿¡]/g, "");
  out = out.replace(/["']/g, "");
  out = out.replace(/\s+\n/g, "\n");
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  out = out.replace(/\s{2,}/g, " ").trim();

  // Fuerza primera palabra con formato "SoloInicialMayuscula" (no TODO EN MAYUSCULAS).
  out = out.replace(
    /^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\b/u,
    (word) => word.charAt(0).toLocaleUpperCase("es-PE") + word.slice(1).toLocaleLowerCase("es-PE")
  );
  return out.slice(0, WHATSAPP_TEXT_MAX);
}

function isHumanOrAiQuestion(text) {
  return /\b(eres|sos)\b.{0,20}\b(ia|ai|humano|robot|bot)\b|\b(ia|ai|humano|robot|bot)\b.{0,20}\b(eres|sos)\b/i.test(
    text || ""
  );
}

function isClosingCue(text) {
  return /\b(gracias|ok|oki|listo|perfecto|está bien|esta bien|de acuerdo|chau|adiós|adios)\b/i.test(
    text || ""
  );
}

function isPrivacyRefusal(text) {
  return /\b(privad[oa]|no (quiero|deseo|puedo)|primero (la )?cotizaci[oó]n|luego coordinamos|no compartir|no dar)\b/i.test(
    text || ""
  );
}

function isImageStubbornRequest(text) {
  return /\b(igual|similar|tal cual|exactamente igual|como la imagen|como en la imagen|solo eso|nada m[aá]s|sin detalles|no dar detalles)\b/i.test(
    text || ""
  );
}

function isConfirmMessage(text) {
  return /\bCONFIRMO\b/.test(text || "");
}

function getClientDataSignals(waId) {
  const blob = getFlattenedUserText(waId).toLowerCase();
  const hasProduct = /(techo|reja|baranda|port[oó]n|puerta|ventana|estructura|mueble|afiche|gr[úu]a|trabajo|producto|cerco)/i.test(
    blob
  );
  const hasTech = /(metro|medida|alto|ancho|material|acabado|pintura|imagen referencial|m2|m²)/i.test(blob);
  const hasScope = /(hogar|dom[eé]stic|industrial|empresa)/i.test(blob);
  const hasId = /(ruc|mi nombre es|nombre completo|soy [a-záéíóúñ])/i.test(blob);
  const hasAddress = /(direcci[oó]n|ubicaci[oó]n|avenida|av\.|jr\.|calle|sector|referencia|cerca de|lugar)/i.test(blob);
  return { blob, hasProduct, hasTech, hasScope, hasId, hasAddress };
}

function hasLogicalQuantity(waId) {
  const { blob } = getClientDataSignals(waId);
  const isAreaWork = /(techo|techado|techar|cerco|cercado|cercar)/i.test(blob);

  // Detecta cantidades numéricas explícitas desde el inicio:
  // ej: "100 sillas", "50 mesas", "2 portones", "3 paños", "x2", "2x".
  const hasNumericUnits =
    /\b\d+\s*(unidad(?:es)?|pieza(?:s)?|paño(?:s)?|hoja(?:s)?|juego(?:s)?|silla(?:s)?|mesa(?:s)?|port[oó]n(?:es)?|puerta(?:s)?|ventana(?:s)?|reja(?:s)?|baranda(?:s)?|mueble(?:s)?|afiche(?:s)?)\b/i.test(
      blob
    ) ||
    /\b(x\s*\d+|\d+\s*x)\b/i.test(blob);

  if (isAreaWork) {
    return (
      /(área|area|m2|m²|metros cuadrados|sector|sectores|tramo|tramos|frente|perímetro|perimetro)/i.test(
        blob
      ) || hasNumericUnits
    );
  }
  return /(unidad|unidades|cantidad|pieza|piezas|paño|paños|hoja|hojas|juego|juegos)/i.test(blob) || hasNumericUnits;
}

function getLogicalQuantityQuestion(waId) {
  const { blob, hasProduct, hasTech } = getClientDataSignals(waId);
  if (!hasProduct || !hasTech || hasLogicalQuantity(waId)) return null;
  if (/(techo|techado|techar)/i.test(blob)) {
    return "Muy bien, para completar la cotización, cuántas áreas techadas necesitas que fabriquemos o instalemos?";
  }
  if (/(cerco|cercado|cercar)/i.test(blob)) {
    return "Muy bien, para completar la cotización, cuántas áreas cercadas o tramos de cerco necesitas?";
  }
  return "Muy bien, para completar la cotización, qué cantidad necesitas exactamente (unidades, piezas o paños según el trabajo)?";
}

function hasEnoughInfoForSpecConfirmation(waId) {
  const { hasProduct, hasTech, hasScope, hasId, hasAddress } = getClientDataSignals(waId);
  const hasQty = hasLogicalQuantity(waId);
  return hasProduct && hasTech && hasScope && hasId && hasAddress && hasQty;
}

function decorateReply(reply, { isFirst, shouldClose }) {
  const clean = normalizeAssistantReply(reply);
  if (isFirst || shouldClose) return `${clean} 🙂`.slice(0, WHATSAPP_TEXT_MAX);
  return clean;
}

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

function extractTextMessages(body) {
  const out = [];
  if (!body?.entry) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.messages) continue;
      for (const msg of value.messages) {
        if (msg.type === "text" && msg.text?.body && msg.from) {
          out.push({ from: msg.from, body: msg.text.body, id: msg.id, type: "text", mediaId: null });
          continue;
        }
        if (msg.type === "image" && msg.from) {
          const caption = msg.image?.caption?.trim();
          const imageText = caption
            ? `Imagen referencial enviada. Mensaje del cliente: ${caption}`
            : "Imagen referencial enviada por el cliente";
          out.push({
            from: msg.from,
            body: imageText,
            id: msg.id,
            type: "image",
            mediaId: msg.image?.id || null,
          });
        }
      }
    }
  }
  return out;
}

async function getWhatsAppMediaDataUrl(mediaId) {
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!mediaId || !access) return null;

  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  const metaRaw = await metaRes.text();
  if (!metaRes.ok) {
    console.error("Media meta error", metaRes.status, metaRaw);
    return null;
  }

  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return null;
  }

  if (!meta?.url) return null;
  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${access}` },
  });
  if (!binRes.ok) {
    const raw = await binRes.text();
    console.error("Media download error", binRes.status, raw);
    return null;
  }
  const mime = meta.mime_type || "image/jpeg";
  const arr = await binRes.arrayBuffer();
  const b64 = Buffer.from(arr).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function generateImageDescriptionReply(waId, mediaId, userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !mediaId) return null;
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const imageDataUrl = await getWhatsAppMediaDataUrl(mediaId);
  if (!imageDataUrl) return null;

  const visionPrompt =
    "Describe solo detalles visibles de la imagen para cotización (tipo de estructura, material aparente, acabado/color, medidas estimadas visuales si aplica, complejidad). " +
    "No inventes medidas exactas ni datos no visibles. Escribe breve y pide confirmación del cliente.";

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 450,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: visionPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: `Contexto cliente: ${userText || "Sin detalle adicional"}` },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });

  const raw = await r.text();
  if (!r.ok) {
    console.error("OpenAI vision error", r.status, raw);
    return null;
  }
  try {
    const data = JSON.parse(raw);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return normalizeAssistantReply(
      `${text}\n\nSi esta descripción coincide con lo que necesitas, confirmame y seguimos con la cotización`
    );
  } catch {
    return null;
  }
}

async function generateAssistantReply(waId, userText, isFirst) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const history = getConversationHistory(waId);
  const behaviorPrompt = isFirst
    ? "Si y solo si el cliente envía un saludo inicial breve (hola/buenas), preséntate como Gladis en esta respuesta. Si el cliente ya viene con contexto o está respondiendo datos, NO te presentes."
    : "NO te vuelvas a presentar. Ya te presentaste antes. Continúa la conversación sin reiniciar.";

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
        {
          role: "system",
          content:
            `${behaviorPrompt} No repitas preguntas si el cliente ya dio ese dato. ` +
            "Antes de preguntar, revisa el historial y pide solo el siguiente dato faltante.",
        },
        ...history,
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
  return normalizeAssistantReply(text);
}

async function generateSpecsSummary(waId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const convo = getFlattenedUserText(waId);

  const prompt = [
    "Resume solo las especificaciones del trabajo brindadas por el cliente.",
    "Devuelve 4 a 7 líneas breves, sin inventar datos.",
    "Incluye: tipo de trabajo, medidas, material/acabado, cantidad, tipo hogar/industrial, nombre o RUC y ubicación/referencia.",
    "Si un campo no existe, escribe exactamente Pendiente en ese campo. Nunca inventes valores.",
    "No saludes ni cierres.",
  ].join(" ");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: convo },
      ],
    }),
  });

  const raw = await r.text();
  if (!r.ok) {
    console.error("OpenAI resumen error", r.status, raw);
    return null;
  }

  try {
    const data = JSON.parse(raw);
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? normalizeAssistantReply(text) : null;
  } catch {
    return null;
  }
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

function getAssistantDelayMs() {
  const fixedDelay = Number(process.env.OPENAI_ASSISTANT_DELAY_MS);
  return Number.isFinite(fixedDelay) && fixedDelay >= 0 ? fixedDelay : 5000;
}

async function processInbound(body) {
  if (!body || typeof body !== "object") return;

  console.log("WhatsApp webhook:", JSON.stringify(body));
  const texts = extractTextMessages(body);
  const waitMs = getAssistantDelayMs();

  for (const { from, body: msgBody, id, type, mediaId } of texts) {
    try {
      if (markProcessedMessage(id)) continue;

    const isFirst = !seenWaId.has(from);
    seenWaId.set(from, true);

    if (waitMs > 0) await delay(waitMs);

    const imageState = imageStateByWaId.get(from) || { count: 0, lastMediaId: null };
    if (type === "image") {
      if (mediaId && mediaId !== imageState.lastMediaId) {
        imageState.count += 1;
        imageState.lastMediaId = mediaId;
        imageStateByWaId.set(from, imageState);
      }
      if (imageState.count > 2) {
        const limitReply =
          "Perfecto, ya recibí 2 imágenes en este chat. Para continuar, trabajemos con esas referencias y el detalle técnico en texto";
        appendConversationTurn(from, "user", msgBody);
        appendConversationTurn(from, "assistant", limitReply);
        await sendTextReply(from, decorateReply(limitReply, { isFirst, shouldClose: false }));
        continue;
      }
      // Primera mano: pedir detalles antes de analizar imagen.
      const askDetail =
        "Muy bien, ya recibí tu imagen referencial. Contame por favor qué necesitas exactamente: medidas aproximadas, material y acabado. Si deseas algo igual a la imagen, también indícamelo";
      if (!msgBody || /imagen referencial enviada por el cliente/i.test(msgBody)) {
        appendConversationTurn(from, "user", msgBody);
        appendConversationTurn(from, "assistant", askDetail);
        await sendTextReply(from, decorateReply(askDetail, { isFirst, shouldClose: false }));
        continue;
      }
    }

    const confirmState = confirmationStateByWaId.get(from);
    if (confirmState?.awaiting) {
      let confirmReply;
      if (isConfirmMessage(msgBody)) {
        confirmReply =
          "Perfecto, recibimos tu CONFIRMO. Quedan validadas las especificaciones y procederemos con la cotización formal a la brevedad";
        confirmationStateByWaId.set(from, { awaiting: false });
      } else {
        confirmReply =
          "Para continuar, por favor responde exactamente CONFIRMO en mayúsculas si el resumen de especificaciones es correcto";
      }
      confirmReply = decorateReply(confirmReply, {
        isFirst: false,
        shouldClose: false,
      });
      appendConversationTurn(from, "user", msgBody);
      appendConversationTurn(from, "assistant", confirmReply);
      await sendTextReply(from, confirmReply);
      continue;
    }

    let reply;
    if (isHumanOrAiQuestion(msgBody)) {
      reply = "Soy asistente de COMERCIAL BAUTISTA";
    } else if (isPrivacyRefusal(msgBody)) {
      reply =
        "Entiendo, no hay problema. Podemos avanzar con una cotización referencial sin tu dirección exacta por ahora. Para afinar el estimado, solo confirmame el tipo de trabajo, medidas aproximadas y acabado, y luego coordinamos ubicación cuando te sea cómodo";
    } else if (isImageStubbornRequest(msgBody) && imageState.lastMediaId && imageState.count <= 2) {
      reply = await generateImageDescriptionReply(from, imageState.lastMediaId, msgBody);
    } else {
      reply = await generateAssistantReply(from, msgBody, isFirst);
    }
    if (!reply) {
      reply = "Gracias por escribirnos. Ya vimos tu mensaje y en breve te seguimos por aquí.";
    }

    appendConversationTurn(from, "user", msgBody);

    // Pregunta lógica de cantidad según el tipo de trabajo antes de cerrar/resumir.
    const qtyQuestion = getLogicalQuantityQuestion(from);
    if (qtyQuestion) {
      const decoratedQty = decorateReply(qtyQuestion, { isFirst, shouldClose: false });
      appendConversationTurn(from, "assistant", decoratedQty);
      await sendTextReply(from, decoratedQty);
      continue;
    }

    // Si ya hay información suficiente, primero pedimos confirmación formal del resumen.
    if (hasEnoughInfoForSpecConfirmation(from)) {
      const summary = await generateSpecsSummary(from);
      if (summary) {
        const askConfirm =
          `Muy bien, para validar tu solicitud te comparto el resumen de especificaciones:\n` +
          `${summary}\n\n` +
          `Si todo está correcto, responde exactamente CONFIRMO en mayúsculas`;
        const decoratedSummary = decorateReply(askConfirm, { isFirst, shouldClose: false });
        appendConversationTurn(from, "assistant", decoratedSummary);
        confirmationStateByWaId.set(from, { awaiting: true });
        await sendTextReply(from, decoratedSummary);
        continue;
      }
    }

    reply = decorateReply(reply, { isFirst, shouldClose: isClosingCue(msgBody) });
    appendConversationTurn(from, "assistant", reply);
      await sendTextReply(from, reply);
    } catch (e) {
      console.error("Loop message processing error:", e);
      // Fail-safe: evita dejar al cliente sin respuesta ante errores de visión/API.
      try {
        if (from) {
          await sendTextReply(
            from,
            "Disculpa, tuvimos un inconveniente momentáneo procesando tu mensaje. Si gustas, intenta nuevamente en unos segundos"
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
