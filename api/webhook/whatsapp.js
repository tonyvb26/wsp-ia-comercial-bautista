/**
 * Webhook serverless (Vercel) para Gladis — asistente comercial de
 * METALTEC - COMERCIAL BAUTISTA en WhatsApp Cloud API (Meta).
 *
 * Variables de entorno (Vercel):
 *   WHATSAPP_VERIFY_TOKEN       Mismo valor que en Meta → Webhook
 *   WHATSAPP_ACCESS_TOKEN       Token (preferible token permanente de Usuario del sistema)
 *   WHATSAPP_PHONE_NUMBER_ID    ID del número de WhatsApp Cloud API
 *   WHATSAPP_GRAPH_VERSION      Opcional, default v22.0
 *   OPENAI_API_KEY              API key de OpenAI
 *   OPENAI_MODEL                Opcional, default gpt-4o-mini
 *   OPENAI_VISION_MODEL         Opcional, default = OPENAI_MODEL
 *   LEAD_FORWARD_TO             Opcional, número (solo dígitos) para reenviar leads
 *
 * Nota: el estado vive en memoria del runtime serverless. En cold start
 * se pierde y la conversación se reinicia (no es problema para el flujo).
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const WHATSAPP_TEXT_MAX = 4000;

const COMPANY_BRAND = "METALTEC - COMERCIAL BAUTISTA";
const COMPANY_WEB_URL = "https://comercialbautista.net/";
const COMPANY_FB_URL = "https://www.facebook.com/people/Metaltec-Comercial-Bautista/61588330106602/";
const ASSISTANT_NAME = "Gladis";

const COOLDOWN_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL;

// ============================================================================
// Estado en memoria
// ============================================================================

const sessions = new Map();
const processedMessageIds = new Map();

function newSession() {
  return {
    step: "saludo",
    fields: {
      tipo_trabajo: null,
      material: null,
      medidas: null,
      ambito: null,
      ubicacion: null,
      ruc: null,
      nombre: null,
    },
    images: [],
    pendingUbicacion: null,
    pendingMaterialSuggestion: null,
    modifyingField: null,
    warnings: 0,
    blockedUntil: 0,
    closed: false,
    profileName: null,
    lastActivity: Date.now(),
  };
}

function getSession(waId) {
  let s = sessions.get(waId);
  if (s && Date.now() - s.lastActivity > SESSION_TTL_MS) {
    sessions.delete(waId);
    s = null;
  }
  if (!s) {
    s = newSession();
    sessions.set(waId, s);
  }
  s.lastActivity = Date.now();
  return s;
}

function isAlreadyProcessed(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  if (processedMessageIds.size > 5000) {
    for (const [k, t] of processedMessageIds) {
      if (now - t > 60 * 60 * 1000) processedMessageIds.delete(k);
    }
  }
  return false;
}

// ============================================================================
// Graph API helpers
// ============================================================================

async function graphGet(path, accessToken) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const err = new Error(`Graph GET ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function sendText(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !access) {
    console.error("Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN");
    return;
  }
  const body = (text || "").slice(0, WHATSAPP_TEXT_MAX);
  if (!body.trim()) return;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    console.error("WhatsApp text send error", r.status, raw);
  }
}

async function sendImage(to, mediaId) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !access || !mediaId) return;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { id: mediaId },
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    console.error("WhatsApp image send error", r.status, raw);
  }
}

async function downloadMedia(mediaId) {
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!access || !mediaId) return null;
  const meta = await graphGet(`${mediaId}?fields=url,mime_type`, access);
  if (!meta?.url) return null;
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${access}` } });
  if (!r.ok) return null;
  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || "image/jpeg" };
}

async function reuploadImageForOurNumber(mediaId) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !access || !mediaId) return null;
  try {
    const dl = await downloadMedia(mediaId);
    if (!dl) return null;
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", dl.mimeType);
    const ext = dl.mimeType === "image/png" ? "png" : dl.mimeType === "image/webp" ? "webp" : "jpg";
    const blob = new Blob([dl.buffer], { type: dl.mimeType });
    form.append("file", blob, `referencia.${ext}`);
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access}` },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Reupload error", r.status, data);
      return null;
    }
    return data.id || null;
  } catch (e) {
    console.error("Reupload exception", e);
    return null;
  }
}

// ============================================================================
// OpenAI helpers
// ============================================================================

async function openaiJSON(messages, { model = OPENAI_MODEL, temperature = 0.2 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    console.error("OpenAI JSON error", r.status, raw);
    return null;
  }
  const data = await r.json().catch(() => null);
  if (!data) return null;
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

async function analyzeImage(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Eres un asistente que describe imágenes referenciales para cotizaciones de carpintería metálica, herrería o fabricación industrial. Responde SOLO un JSON válido.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Analiza la imagen y devuelve JSON con las claves: tipo_trabajo (string), material (string), acabado (string), medidas_aproximadas (string), descripcion (string breve). Si un campo no puede deducirse, usa 'no claro'.",
            },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    }),
  });
  if (!r.ok) {
    const raw = await r.text();
    console.error("OpenAI vision error", r.status, raw);
    return null;
  }
  const data = await r.json().catch(() => null);
  if (!data) return null;
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

// ============================================================================
// Detección local (fallback) de groserías y confirmaciones
// ============================================================================

const PROFANITY = [
  "mierda",
  "puta",
  "puto",
  "cabron",
  "cabrón",
  "joder",
  "imbecil",
  "imbécil",
  "idiota",
  "estupido",
  "estúpido",
  "pendejo",
  "concha",
  "carajo",
  "marica",
  "maricón",
  "jodete",
  "verga",
  "huevon",
  "huevón",
  "hdp",
  "csm",
  "ctm",
];

function looksLikeProfanity(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return PROFANITY.some((w) => new RegExp(`(^|\\W)${w}(\\W|$)`).test(t));
}

function looksLikeConfirm(text) {
  if (!text) return false;
  return /\b(si|sí|claro|correcto|exacto|de acuerdo|dale|ok|okay|listo|perfecto|confirmo|confirmado|así es|asi es)\b/i.test(
    text
  );
}

function looksLikeDeny(text) {
  if (!text) return false;
  return /\b(no|incorrecto|cambiar|modificar|equivocado|no es|nop|nope)\b/i.test(text);
}

function looksLikeRefuseAddress(text) {
  if (!text) return false;
  return /\b(no (te|le) puedo dar|no (quiero|deseo|puedo) (dar|compartir|brindar)|prefiero no|privad[oa]|reserva|no compartir)\b.*\b(direcci|ubicac|domicilio)?/i.test(
    text
  );
}

// ============================================================================
// Clasificador OpenAI por turno
// ============================================================================

function describeStep(step) {
  switch (step) {
    case "saludo":
      return "todavía no se inicia, esperar primer mensaje del cliente";
    case "tipo_trabajo":
      return "preguntar qué desea construir o fabricar";
    case "material":
      return "preguntar material o acabado";
    case "medidas":
      return "preguntar cantidad y medidas (área o metros)";
    case "ambito":
      return "preguntar si es doméstico/hogar o industrial/empresa";
    case "ubicacion_pedir":
      return "pedir ubicación / referencia";
    case "ubicacion_confirmar":
      return "el cliente debe confirmar la ubicación entendida";
    case "identificacion_ruc":
      return "pedir RUC o nombre completo";
    case "identificacion_nombre":
      return "pedir nombre con el que dirigirnos al cliente";
    case "resumen_confirmar":
      return "el cliente debe confirmar el resumen de cotización";
    case "modificar_item":
      return "preguntar qué punto del resumen quiere modificar";
    case "modificar_valor":
      return "el cliente da el nuevo valor del punto a modificar";
    case "cerrado":
      return "conversación cerrada";
    default:
      return step;
  }
}

async function classify(session, userText) {
  const fieldsState = JSON.stringify(session.fields);
  const messages = [
    {
      role: "system",
      content: `Eres un clasificador para Gladis, asistente comercial de ${COMPANY_BRAND}.
Recibes: paso actual del flujo de cotización, datos ya recopilados y el mensaje del cliente.
Devuelves SOLO un JSON con esta forma:
{
  "intent": "answer" | "out_of_order" | "off_topic" | "abuse" | "modify" | "confirm" | "deny" | "refuse_address" | "no_idea_material" | "approximate_size",
  "value_for_current_step": string | null,
  "captured_for_other_steps": {
    "tipo_trabajo": string | null,
    "material": string | null,
    "medidas": string | null,
    "ambito": "domestico" | "industrial" | null,
    "ubicacion": string | null,
    "ruc": string | null,
    "nombre": string | null
  },
  "explanation": string
}

Definiciones:
- "answer": responde directamente lo pedido en el paso actual.
- "out_of_order": da datos que pertenecen a otro paso distinto al actual, sin contestar el actual.
- "off_topic": se desvía del tema (clima, política, vida personal, charla informal, etc.).
- "abuse": insultos, groserías, lenguaje sexual o amenazas.
- "modify": pide cambiar/corregir algo del resumen ya mostrado.
- "confirm": responde sí/correcto/ok/confirmo a una pregunta cerrada de confirmación.
- "deny": responde no/incorrecto a una pregunta cerrada de confirmación.
- "refuse_address": en el paso de ubicación dice que no quiere o no puede dar la dirección.
- "no_idea_material": en el paso de material dice no sé / no tengo idea / no conozco materiales.
- "approximate_size": en medidas indica que son aproximados / no exactos / cálculo grueso.

Reglas:
- "value_for_current_step" debe ser una versión limpia y breve de la respuesta para el paso actual, o null.
- En "captured_for_other_steps" incluye SOLO valores que estén claramente expresados en el mensaje del cliente; no inventes.
- ambito: "domestico" si dice casa, hogar, familia, personal, vivienda. "industrial" si dice empresa, negocio, industria, fábrica, RUC, comercial.
- ruc: 11 dígitos consecutivos.
- nombre: si dice "soy X", "me llamo X", "mi nombre es X", devuelve solo el nombre.
- Responde SOLO con el JSON, sin texto adicional.`,
    },
    {
      role: "user",
      content: `Paso actual: ${session.step} (${describeStep(session.step)})
Datos ya recopilados: ${fieldsState}
Mensaje del cliente: ${JSON.stringify(userText)}`,
    },
  ];
  const out = await openaiJSON(messages, { temperature: 0.1 });
  if (!out || typeof out !== "object") {
    return {
      intent: "answer",
      value_for_current_step: userText,
      captured_for_other_steps: {},
      explanation: "fallback",
    };
  }
  if (!out.captured_for_other_steps) out.captured_for_other_steps = {};
  return out;
}

// ============================================================================
// Plantillas de respuesta
// ============================================================================

function greetingMessage() {
  return `Hola 🙂 Soy ${ASSISTANT_NAME}, asistente comercial de ${COMPANY_BRAND}. Con gusto te ayudo con tu cotización.

Para comenzar, cuéntame qué tipo de trabajo deseas construir o fabricar?`;
}

function askForStep(session, step) {
  switch (step) {
    case "tipo_trabajo":
      return "Cuéntame por favor, qué tipo de trabajo deseas construir o fabricar?";
    case "material":
      return askMaterial(session.fields.tipo_trabajo);
    case "medidas":
      return askMedidas();
    case "ambito":
      return askAmbito();
    case "ubicacion_pedir":
      return askUbicacion();
    case "identificacion_ruc":
      return askIdentificacion();
    case "identificacion_nombre":
      return askNombreParaDirigirse();
    default:
      return "Continuemos con tu cotización.";
  }
}

function askMaterial(tipoTrabajo) {
  const base = tipoTrabajo
    ? `Anoté: ${tipoTrabajo}.\n\nAhora, qué material o acabado tienes en mente?`
    : "Qué material o acabado tienes en mente?";
  const refs = `Si quieres referencias visuales puedes revisar:
- Web: ${COMPANY_WEB_URL}
- Facebook: ${COMPANY_FB_URL}

Si no tienes idea, dímelo y te sugiero opciones. Si tienes una imagen referencial, envíamela y la analizo.`;
  return `${base}\n\n${refs}`;
}

function suggestMaterialFor(tipoTrabajo) {
  const t = (tipoTrabajo || "").toLowerCase();
  if (/(cerco|cercad|reja|baranda|port[oó]n)/.test(t))
    return "tubo cuadrado 1.5x1.5 o fierro corrugado 1/2 pulgada, con pintura anticorrosiva o electrostática";
  if (/puerta/.test(t))
    return "marco de tubo cuadrado 2x2 con plancha LAF 1.5 mm, acabado pintura electrostática";
  if (/ventana/.test(t))
    return "perfil de aluminio o fierro 1x1 con vidrio templado de 6 mm";
  if (/(techo|estructura|cobertur)/.test(t))
    return "estructura de tubo cuadrado 2x4 con cobertura de calamina o policarbonato, pintura anticorrosiva";
  if (/(escaler|pasamano|baranda)/.test(t))
    return "tubo redondo de 2 pulgadas en acero inoxidable o fierro pintado";
  if (/(mesa|mueble|silla|estanter)/.test(t))
    return "estructura de fierro cuadrado o redondo con acabado pintura electrostática y tablero de melamina o madera";
  if (/(porton|portón|garaje|cochera)/.test(t))
    return "plancha estriada o lisa sobre estructura de tubo cuadrado, con sistema corredizo o batiente";
  return "fierro estructural con pintura anticorrosiva, o acero inoxidable según el uso";
}

function askMedidas() {
  return "Perfecto. Ahora indícame por favor la cantidad y las medidas aproximadas (puede ser en metros lineales, ancho x alto o el área que necesitas).";
}

function askAmbito() {
  return "Anotado. Este trabajo será para uso doméstico/hogar o para empresa/industrial?";
}

function askUbicacion() {
  return "Para ajustar fletes y tiempos, indícame por favor la ubicación o referencia del lugar (distrito o zona y un punto cercano conocido).";
}

function confirmUbicacionText(text) {
  return `Para confirmar, entendí que la ubicación o referencia es: "${text}". Es correcto?`;
}

function askIdentificacion() {
  return "Por último, cuál es tu RUC? Si no tienes RUC, indícame tu nombre completo.";
}

function askNombreParaDirigirse() {
  return "Gracias. Con qué nombre podemos dirigirnos a ti?";
}

function gentleRedirect(step) {
  return `Me parece interesante lo que comentas, pero centremos la conversación en tu cotización para avanzar bien. ${askForStep(
    { fields: {} },
    step
  )}`;
}

function outOfOrderRedirect(step) {
  return `Anotado, en un momento llegamos a eso. Primero necesito: ${askForStep(
    { fields: {} },
    step
  )}`;
}

function warningEndingMessage(step) {
  return `Lamentablemente, si seguimos así tendré que finalizar la conversación. Volvamos al tema, por favor: ${askForStep(
    { fields: {} },
    step
  )}`;
}

function blockedFarewellMessage() {
  return "Lamento tener que finalizar la conversación por el momento. Si gustas, escríbenos más tarde y con gusto retomamos tu cotización.";
}

function farewellMessage() {
  return `Quedan validadas las especificaciones. Procederemos a preparar la cotización formal a la brevedad y nos pondremos en contacto contigo si necesitamos ajustar algún detalle. Muchas gracias por confiar en ${COMPANY_BRAND} 🙂`;
}

// ============================================================================
// Resumen y modificación
// ============================================================================

function firstName(full) {
  if (!full) return null;
  const parts = String(full).trim().split(/\s+/);
  return parts[0] || null;
}

function summaryText(session, contactNumber) {
  const f = session.fields;
  const nombreCorto = firstName(f.nombre) || firstName(session.profileName) || "No especificado";
  const rucONombre = f.ruc ? `RUC ${f.ruc}` : f.nombre || "No especificado";
  const lines = [
    "Resumen de tu cotización:",
    "",
    `- Número de contacto: ${contactNumber}`,
    `- Nombre del cliente: ${nombreCorto}`,
    "",
    `1) Tipo de trabajo: ${f.tipo_trabajo || "No especificado"}`,
    `2) Material o acabado: ${f.material || "No especificado"}`,
    `3) Cantidad y medidas: ${f.medidas || "No especificado"}`,
    `4) Trabajo doméstico/industrial: ${f.ambito || "No especificado"}`,
    `5) Ubicación/referencia: ${f.ubicacion || "No especificado"}`,
    `6) RUC/Nombre: ${rucONombre}`,
    "",
    "Si todo está correcto, escribe \"confirmo\" para que procedamos con la cotización formal. Si deseas modificar algún punto, indícame el número (1 a 6) y el nuevo dato.",
  ];
  return lines.join("\n");
}

function resolveFieldFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b1\b|tipo de trabajo|trabajo|fabricar|construir/.test(t)) return "tipo_trabajo";
  if (/\b2\b|material|acabado/.test(t)) return "material";
  if (/\b3\b|cantidad|medida|metro|área|area/.test(t)) return "medidas";
  if (/\b4\b|doméstico|domestico|hogar|industrial|empresa/.test(t)) return "ambito";
  if (/\b5\b|ubicaci[oó]n|direcci[oó]n|referencia|lugar/.test(t)) return "ubicacion";
  if (/\b6\b|ruc|nombre/.test(t)) return "identificacion";
  return null;
}

function fieldQuestion(field) {
  switch (field) {
    case "tipo_trabajo":
      return "Dime el nuevo tipo de trabajo.";
    case "material":
      return "Dime el nuevo material o acabado.";
    case "medidas":
      return "Dime las nuevas medidas o cantidad.";
    case "ambito":
      return "Dime si es para uso doméstico/hogar o industrial/empresa.";
    case "ubicacion":
      return "Dime la nueva ubicación o referencia.";
    case "identificacion":
      return "Dime tu RUC actualizado o, si no tienes, tu nombre completo.";
    default:
      return "Dime el nuevo valor.";
  }
}

// ============================================================================
// Avance del flujo: salta pasos cuyo dato ya está completo
// ============================================================================

const LINEAR_STEPS = [
  "tipo_trabajo",
  "material",
  "medidas",
  "ambito",
  "ubicacion_pedir",
  "identificacion_ruc",
];

function isStepSatisfied(session, step) {
  const f = session.fields;
  switch (step) {
    case "tipo_trabajo":
      return Boolean(f.tipo_trabajo);
    case "material":
      return Boolean(f.material);
    case "medidas":
      return Boolean(f.medidas);
    case "ambito":
      return Boolean(f.ambito);
    case "ubicacion_pedir":
      return Boolean(f.ubicacion);
    case "identificacion_ruc":
      return Boolean(f.ruc || f.nombre);
    default:
      return false;
  }
}

function nextLinearStep(session) {
  for (const s of LINEAR_STEPS) {
    if (!isStepSatisfied(session, s)) return s;
  }
  return "resumen_confirmar";
}

async function advanceAndAsk(session, from) {
  const next = nextLinearStep(session);
  session.step = next;
  if (next === "resumen_confirmar") {
    await proceedToSummary(session, from);
    return;
  }
  await sendText(from, askForStep(session, next));
}

async function proceedToSummary(session, from) {
  session.step = "resumen_confirmar";
  if (session.images.length) {
    const last = session.images[session.images.length - 1];
    try {
      const newId = await reuploadImageForOurNumber(last.mediaId);
      if (newId) await sendImage(from, newId);
    } catch (e) {
      console.error("No se pudo reenviar la imagen referencial:", e);
    }
  }
  await sendText(from, summaryText(session, from));
}

// ============================================================================
// Captura de datos hacia campos de la sesión
// ============================================================================

function applyCapturedOtherSteps(session, captured) {
  if (!captured || typeof captured !== "object") return;
  const f = session.fields;
  if (captured.tipo_trabajo && !f.tipo_trabajo) f.tipo_trabajo = String(captured.tipo_trabajo).trim();
  if (captured.material && !f.material) f.material = String(captured.material).trim();
  if (captured.medidas && !f.medidas) f.medidas = String(captured.medidas).trim();
  if (captured.ambito && !f.ambito) {
    const a = String(captured.ambito).toLowerCase();
    if (a === "domestico" || a === "doméstico") f.ambito = "doméstico/hogar";
    else if (a === "industrial") f.ambito = "industrial/empresa";
  }
  if (captured.ubicacion && !f.ubicacion) f.ubicacion = String(captured.ubicacion).trim();
  if (captured.ruc && !f.ruc) {
    const onlyDigits = String(captured.ruc).replace(/\D/g, "");
    if (/^\d{11}$/.test(onlyDigits)) f.ruc = onlyDigits;
  }
  if (captured.nombre && !f.nombre) f.nombre = String(captured.nombre).trim();
}

// ============================================================================
// Inbound: extracción y reenvío de leads
// ============================================================================

function extractInbound(body) {
  const out = [];
  if (!body?.entry) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const v = change.value;
      const messages = v?.messages || [];
      const contacts = v?.contacts || [];
      for (const m of messages) {
        const from = m.from;
        const id = m.id;
        const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name || null;
        if (m.type === "text") {
          out.push({ from, id, profileName, type: "text", text: m.text?.body || "" });
        } else if (m.type === "image") {
          out.push({
            from,
            id,
            profileName,
            type: "image",
            mediaId: m.image?.id,
            caption: m.image?.caption || "",
          });
        } else {
          out.push({
            from,
            id,
            profileName,
            type: m.type,
            text: m.text?.body || "",
          });
        }
      }
    }
  }
  return out;
}

async function forwardLead(text) {
  const dest = (process.env.LEAD_FORWARD_TO || "").replace(/\D/g, "");
  if (!dest) return;
  await sendText(dest, `[Nuevo lead Gladis]\n\n${text}`);
}

// ============================================================================
// Manejo de cada mensaje entrante
// ============================================================================

async function handleAbuse(session, from) {
  session.warnings += 1;
  if (session.warnings >= 3) {
    session.blockedUntil = Date.now() + COOLDOWN_MS;
    session.step = "cerrado";
    await sendText(from, blockedFarewellMessage());
    return;
  }
  if (session.warnings === 2) {
    await sendText(from, warningEndingMessage(currentAskableStep(session)));
    return;
  }
  await sendText(from, gentleRedirect(currentAskableStep(session)));
}

function currentAskableStep(session) {
  const s = session.step;
  if (s === "saludo") return "tipo_trabajo";
  if (s === "ubicacion_confirmar") return "ubicacion_pedir";
  if (s === "identificacion_nombre") return "identificacion_ruc";
  if (s === "resumen_confirmar" || s === "modificar_item" || s === "modificar_valor") return s;
  return s;
}

async function processImage(session, from, msg) {
  try {
    const dl = await downloadMedia(msg.mediaId);
    if (!dl) return null;
    const analysis = await analyzeImage(dl.buffer, dl.mimeType);
    session.images.push({ mediaId: msg.mediaId, analysis: analysis || null });
    return analysis || null;
  } catch (e) {
    console.error("Error procesando imagen:", e);
    return null;
  }
}

async function handleMessage(session, msg) {
  const from = msg.from;
  if (msg.profileName && !session.profileName) session.profileName = msg.profileName;

  const now = Date.now();
  if (session.blockedUntil && session.blockedUntil > now) return;

  if (session.step === "cerrado") {
    const fresh = newSession();
    fresh.profileName = session.profileName;
    Object.assign(session, fresh);
  }

  // Imagen: análisis y respuesta acorde al paso
  if (msg.type === "image" && msg.mediaId) {
    const analysis = await processImage(session, from, msg);
    if (session.step === "saludo") {
      session.step = "tipo_trabajo";
      await sendText(from, greetingMessage());
      if (analysis && analysis.tipo_trabajo && analysis.tipo_trabajo !== "no claro") {
        await sendText(
          from,
          `Recibí tu imagen referencial. En ella se aprecia: ${analysis.descripcion || analysis.tipo_trabajo}. Confírmame con tus palabras qué deseas construir o fabricar.`
        );
      } else {
        await sendText(from, "Recibí tu imagen y la usaré como referencia visual.");
      }
      return;
    }
    if (session.step === "material" && analysis) {
      const pieces = [analysis.material, analysis.acabado]
        .filter((x) => x && x !== "no claro")
        .join(" con acabado ");
      if (pieces) {
        session.pendingMaterialSuggestion = pieces;
        await sendText(
          from,
          `Por la imagen, el material posible sería: ${pieces}. Trabajamos con esa propuesta o prefieres otro material?`
        );
        return;
      }
    }
    if (
      session.step === "medidas" &&
      analysis &&
      analysis.medidas_aproximadas &&
      analysis.medidas_aproximadas !== "no claro"
    ) {
      await sendText(
        from,
        `En la imagen se aprecian medidas aproximadas: ${analysis.medidas_aproximadas}. Confirmas que esas son las medidas?`
      );
      return;
    }
    await sendText(
      from,
      `Recibí la imagen, la guardo como referencia. ${askForStep(session, currentAskableStep(session))}`
    );
    return;
  }

  const userText = (msg.text || "").trim();

  if (session.step === "saludo") {
    session.step = "tipo_trabajo";
    await sendText(from, greetingMessage());
    if (!userText) return;
  }

  if (looksLikeProfanity(userText)) {
    return await handleAbuse(session, from);
  }

  const cls = await classify(session, userText);

  if (cls.intent === "abuse") {
    return await handleAbuse(session, from);
  }

  applyCapturedOtherSteps(session, cls.captured_for_other_steps);

  switch (session.step) {
    case "tipo_trabajo":
      return await stepTipoTrabajo(session, from, userText, cls);
    case "material":
      return await stepMaterial(session, from, userText, cls);
    case "medidas":
      return await stepMedidas(session, from, userText, cls);
    case "ambito":
      return await stepAmbito(session, from, userText, cls);
    case "ubicacion_pedir":
      return await stepUbicacionPedir(session, from, userText, cls);
    case "ubicacion_confirmar":
      return await stepUbicacionConfirmar(session, from, userText, cls);
    case "identificacion_ruc":
      return await stepIdentificacionRuc(session, from, userText, cls);
    case "identificacion_nombre":
      return await stepIdentificacionNombre(session, from, userText, cls);
    case "resumen_confirmar":
      return await stepResumenConfirmar(session, from, userText, cls);
    case "modificar_item":
      return await stepModificarItem(session, from, userText, cls);
    case "modificar_valor":
      return await stepModificarValor(session, from, userText, cls);
    default:
      return;
  }
}

// ============================================================================
// Handlers por paso
// ============================================================================

async function stepTipoTrabajo(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("tipo_trabajo"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("tipo_trabajo"));
  const val = (cls.value_for_current_step || cls.captured_for_other_steps?.tipo_trabajo || userText || "").trim();
  if (val.length >= 2) {
    session.fields.tipo_trabajo = val;
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "tipo_trabajo"));
}

async function stepMaterial(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("material"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("material"));
  if (cls.intent === "no_idea_material") {
    const sugerencia = suggestMaterialFor(session.fields.tipo_trabajo);
    session.pendingMaterialSuggestion = sugerencia;
    await sendText(
      from,
      `Sin problema. Para un ${session.fields.tipo_trabajo || "trabajo así"} solemos usar ${sugerencia}. Trabajamos con esa propuesta?`
    );
    return;
  }
  if (cls.intent === "confirm" && session.pendingMaterialSuggestion) {
    session.fields.material = session.pendingMaterialSuggestion;
    session.pendingMaterialSuggestion = null;
    await advanceAndAsk(session, from);
    return;
  }
  if (cls.intent === "deny" && session.pendingMaterialSuggestion) {
    session.pendingMaterialSuggestion = null;
    await sendText(from, "Sin problema. Qué material o acabado prefieres entonces?");
    return;
  }
  const val = (cls.value_for_current_step || cls.captured_for_other_steps?.material || userText || "").trim();
  if (val.length >= 2) {
    session.fields.material = val;
    session.pendingMaterialSuggestion = null;
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "material"));
}

async function stepMedidas(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("medidas"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("medidas"));
  const val = (cls.value_for_current_step || cls.captured_for_other_steps?.medidas || userText || "").trim();
  if (val.length >= 1) {
    session.fields.medidas = val;
    if (cls.intent === "approximate_size") {
      await sendText(
        from,
        `Anotado, trabajaremos con esas medidas aproximadas para la cotización (${val}).`
      );
    }
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "medidas"));
}

async function stepAmbito(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("ambito"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("ambito"));
  // Si ya quedó capturado por applyCaptured, avanza
  if (session.fields.ambito) {
    await advanceAndAsk(session, from);
    return;
  }
  const t = userText.toLowerCase();
  if (/(casa|hogar|domést|domest|personal|familia|vivienda|departamento)/.test(t)) {
    session.fields.ambito = "doméstico/hogar";
    await advanceAndAsk(session, from);
    return;
  }
  if (/(empresa|negocio|industria|industrial|comercial|f[áa]brica|planta|obra|taller|local)/.test(t)) {
    session.fields.ambito = "industrial/empresa";
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "ambito"));
}

async function stepUbicacionPedir(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("ubicacion_pedir"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("ubicacion_pedir"));
  if (cls.intent === "refuse_address" || looksLikeRefuseAddress(userText)) {
    session.fields.ubicacion = "No especificado";
    await advanceAndAsk(session, from);
    return;
  }
  const val = (cls.value_for_current_step || cls.captured_for_other_steps?.ubicacion || userText || "").trim();
  if (val.length >= 2) {
    session.pendingUbicacion = val;
    session.step = "ubicacion_confirmar";
    await sendText(from, confirmUbicacionText(val));
    return;
  }
  await sendText(from, askForStep(session, "ubicacion_pedir"));
}

async function stepUbicacionConfirmar(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("ubicacion_pedir"));
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "refuse_address" || looksLikeRefuseAddress(userText)) {
    session.fields.ubicacion = "No especificado";
    session.pendingUbicacion = null;
    await advanceAndAsk(session, from);
    return;
  }
  if (cls.intent === "confirm" || looksLikeConfirm(userText)) {
    session.fields.ubicacion = session.pendingUbicacion || userText || "No especificado";
    session.pendingUbicacion = null;
    await advanceAndAsk(session, from);
    return;
  }
  if (cls.intent === "deny" || cls.intent === "modify" || looksLikeDeny(userText)) {
    session.pendingUbicacion = null;
    session.step = "ubicacion_pedir";
    await sendText(from, "Sin problema, por favor escríbeme nuevamente la ubicación o referencia.");
    return;
  }
  // Tratar como nueva propuesta de ubicación
  if (userText) {
    session.pendingUbicacion = userText;
    await sendText(from, confirmUbicacionText(userText));
    return;
  }
  await sendText(from, confirmUbicacionText(session.pendingUbicacion || ""));
}

async function stepIdentificacionRuc(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("identificacion_ruc"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("identificacion_ruc"));

  const rucMatch = userText.match(/\b\d{11}\b/);
  if (rucMatch) {
    session.fields.ruc = rucMatch[0];
    if (!session.fields.nombre) {
      session.step = "identificacion_nombre";
      await sendText(from, askNombreParaDirigirse());
      return;
    }
    await advanceAndAsk(session, from);
    return;
  }
  if (cls.captured_for_other_steps?.ruc) {
    const r = String(cls.captured_for_other_steps.ruc).replace(/\D/g, "");
    if (/^\d{11}$/.test(r)) {
      session.fields.ruc = r;
      if (!session.fields.nombre) {
        session.step = "identificacion_nombre";
        await sendText(from, askNombreParaDirigirse());
        return;
      }
      await advanceAndAsk(session, from);
      return;
    }
  }
  const nombreVal = (cls.captured_for_other_steps?.nombre || userText || "").trim();
  if (nombreVal.length >= 2) {
    session.fields.nombre = nombreVal;
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "identificacion_ruc"));
}

async function stepIdentificacionNombre(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("identificacion_nombre"));
  const nombreVal = (cls.captured_for_other_steps?.nombre || userText || "").trim();
  if (nombreVal.length >= 2) {
    session.fields.nombre = nombreVal;
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askNombreParaDirigirse());
}

async function stepResumenConfirmar(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("resumen_confirmar"));
  if (cls.intent === "confirm" || /\bconfirmo\b/i.test(userText) || (looksLikeConfirm(userText) && !looksLikeDeny(userText))) {
    await sendText(from, farewellMessage());
    try {
      await forwardLead(summaryText(session, from));
    } catch (e) {
      console.error("forwardLead error:", e);
    }
    session.step = "cerrado";
    session.closed = true;
    return;
  }
  if (cls.intent === "modify" || cls.intent === "deny" || looksLikeDeny(userText)) {
    session.step = "modificar_item";
    await sendText(
      from,
      "Sin problema. Qué punto deseas modificar? Indícame el número del 1 al 6 (o el nombre del campo) y si ya tienes el nuevo dato puedes adjuntarlo en el mismo mensaje."
    );
    return;
  }
  await sendText(
    from,
    "Si todo está correcto escribe \"confirmo\". Si deseas modificar, dime el número del 1 al 6 y el nuevo dato."
  );
}

async function stepModificarItem(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  const field = resolveFieldFromText(userText);
  if (!field) {
    await sendText(
      from,
      "No detecté el punto exacto. Indícame el número del 1 al 6 (o uno de: tipo de trabajo, material, medidas, doméstico/industrial, ubicación, RUC/nombre)."
    );
    return;
  }
  session.modifyingField = field;
  // Si el cliente ya envió el nuevo valor en el mismo mensaje, intentamos aprovecharlo
  const newVal = extractValueForField(field, userText);
  if (newVal) {
    applyFieldUpdate(session, field, newVal);
    session.modifyingField = null;
    session.step = "resumen_confirmar";
    await sendText(from, "Listo, actualicé ese punto. Te paso el resumen actualizado:");
    await sendText(from, summaryText(session, from));
    return;
  }
  session.step = "modificar_valor";
  await sendText(from, fieldQuestion(field));
}

async function stepModificarValor(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  const field = session.modifyingField;
  if (!field) {
    session.step = "modificar_item";
    await sendText(from, "Por favor indícame primero qué punto del resumen quieres cambiar.");
    return;
  }
  const newVal = userText.trim();
  if (!newVal) {
    await sendText(from, fieldQuestion(field));
    return;
  }
  applyFieldUpdate(session, field, newVal);
  session.modifyingField = null;
  session.step = "resumen_confirmar";
  await sendText(from, "Listo, actualicé ese punto. Te paso el resumen actualizado:");
  await sendText(from, summaryText(session, from));
}

function extractValueForField(field, text) {
  if (!text) return null;
  // Quitar la parte que solo indica el punto (1, 2, etc. o "el material:")
  let cleaned = text
    .replace(/^\s*\b[1-6]\b[\s.):\-]*/i, "")
    .replace(/^(el|la)?\s*(tipo de trabajo|material|acabado|medida[s]?|cantidad|ámbito|ambito|domést[ií]co|industrial|ubicaci[oó]n|direcci[oó]n|referencia|ruc|nombre)[\s:.\-]*/i, "")
    .trim();
  // Si tras limpiar no queda nada distinto, no es valor en línea
  if (!cleaned || cleaned.length < 2) return null;
  if (cleaned.toLowerCase() === text.toLowerCase()) {
    // No detectamos una etiqueta clara; mejor pedir aparte
    return null;
  }
  return cleaned;
}

function applyFieldUpdate(session, field, val) {
  if (field === "identificacion") {
    const rucMatch = val.match(/\b\d{11}\b/);
    if (rucMatch) {
      session.fields.ruc = rucMatch[0];
      const rest = val.replace(rucMatch[0], "").trim();
      if (rest && rest.length >= 2) session.fields.nombre = rest;
    } else {
      session.fields.nombre = val;
      session.fields.ruc = null;
    }
    return;
  }
  if (field === "ambito") {
    const t = val.toLowerCase();
    if (/(casa|hogar|domést|domest|personal|familia|vivienda)/.test(t)) {
      session.fields.ambito = "doméstico/hogar";
    } else if (/(empresa|negocio|industria|industrial|comercial|f[áa]brica|planta|obra|taller)/.test(t)) {
      session.fields.ambito = "industrial/empresa";
    } else {
      session.fields.ambito = val;
    }
    return;
  }
  session.fields[field] = val;
}

// ============================================================================
// Procesamiento del webhook
// ============================================================================

async function processInbound(body) {
  if (!body || typeof body !== "object") return;
  const items = extractInbound(body);
  for (const msg of items) {
    if (!msg.from) continue;
    if (isAlreadyProcessed(msg.id)) continue;
    const session = getSession(msg.from);
    try {
      await handleMessage(session, msg);
    } catch (e) {
      console.error("handleMessage error:", e);
      try {
        await sendText(
          msg.from,
          "Disculpa, tuve un inconveniente procesando tu mensaje. ¿Podrías intentar de nuevo en unos segundos?"
        );
      } catch {}
    }
  }
}

// ============================================================================
// Entrada del webhook
// ============================================================================

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const verify = String(process.env.WHATSAPP_VERIFY_TOKEN || "").trim();
    const mode = String(req.query["hub.mode"] ?? "").trim();
    const token = String(req.query["hub.verify_token"] ?? "").trim();
    const challenge = req.query["hub.challenge"];
    if (!verify) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server misconfigured");
      return;
    }
    if (mode === "subscribe" && token === verify) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(challenge !== undefined && challenge !== null ? String(challenge) : "");
      return;
    }
    if (mode === "subscribe") {
      console.error("WhatsApp GET verify: hub.verify_token no coincide con WHATSAPP_VERIFY_TOKEN");
    }
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  if (req.method === "POST") {
    const snapshot = req.body && typeof req.body === "object" ? req.body : null;
    waitUntil(
      processInbound(snapshot).catch((e) => {
        console.error("Webhook async error:", e);
      })
    );
    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(405, { Allow: "GET, POST" });
  res.end();
};
