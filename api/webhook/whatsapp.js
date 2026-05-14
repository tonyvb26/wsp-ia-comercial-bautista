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
 *   LEAD_FORWARD_TO             Opcional, números extra para reenviar leads (separados por coma)
 *
 *   UPSTASH_REDIS_REST_URL      Opcional, fuertemente recomendado (persistir sesión)
 *   UPSTASH_REDIS_REST_TOKEN    Opcional, fuertemente recomendado (persistir sesión)
 *
 * Sin Upstash el estado vive solo en memoria del runtime y se pierde
 * entre invocaciones serverless: Gladis vuelve a saludar y vuelve a empezar.
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v22.0";
const WHATSAPP_TEXT_MAX = 4000;

const COMPANY_BRAND = "METALTEC - COMERCIAL BAUTISTA";
const COMPANY_WEB_URL = "https://comercialbautista.net/";
const COMPANY_FB_URL = "https://www.facebook.com/people/Metaltec-Comercial-Bautista/61588330106602/";
const ASSISTANT_NAME = "Gladis";

const ABUSE_COOLDOWN_MS = 60 * 60 * 1000; // 1h bloqueo silencioso por abuso
const CLOSED_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h tras cierre: acuse breve si insiste
const CLOSED_AUTO_REOPEN_MS = 15 * 60 * 1000; // pasados 15 min desde el cierre, cualquier mensaje reabre
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLOSED_ACK_COOLDOWN_MS = 30 * 60 * 1000; // acuse "ya en proceso" cada 30min

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL;

const LINEAR_STEPS = [
  "tipo_trabajo",
  "material",
  "medidas",
  "ambito",
  "ubicacion_pedir",
  "identificacion_ruc",
];

// ============================================================================
// Upstash Redis (REST) — persistencia opcional
// ============================================================================

function kvEnabled() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function kvPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!r.ok) {
      console.error("Upstash pipeline error", r.status, await r.text());
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error("Upstash exception", e);
    return null;
  }
}

async function kvGetJSON(key) {
  const out = await kvPipeline([["GET", key]]);
  const val = out?.[0]?.result;
  if (val == null) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

async function kvSetJSON(key, value, ttlSeconds) {
  await kvPipeline([["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]]);
}

async function kvSetIfNew(key, ttlSeconds) {
  const out = await kvPipeline([["SET", key, "1", "NX", "EX", String(ttlSeconds)]]);
  return out?.[0]?.result === "OK";
}

// ============================================================================
// Estado de sesión (memoria + Upstash si está disponible)
// ============================================================================

const sessionsMem = new Map();
const processedIdsMem = new Map();

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
    pendingMaterialBaseFrom: null,
    pendingMaterialDescription: null,
    pendingMaterialProposal: null,
    leadForwardedAt: 0,
    modifyingField: null,
    warnings: 0,
    blockedUntil: 0,
    closedUntil: 0,
    closedAckAt: 0,
    profileName: null,
    lastActivity: Date.now(),
  };
}

async function loadSession(waId) {
  if (kvEnabled()) {
    const stored = await kvGetJSON(`gladis:session:${waId}`);
    if (stored && typeof stored === "object") {
      // Asegurar campos nuevos (compat hacia atrás)
      const merged = Object.assign(newSession(), stored);
      merged.fields = Object.assign(newSession().fields, stored.fields || {});
      merged.lastActivity = Date.now();
      return merged;
    }
    return newSession();
  }
  let s = sessionsMem.get(waId);
  if (s && Date.now() - s.lastActivity > SESSION_TTL_MS) {
    sessionsMem.delete(waId);
    s = null;
  }
  if (!s) {
    s = newSession();
    sessionsMem.set(waId, s);
  }
  s.lastActivity = Date.now();
  return s;
}

async function saveSession(waId, session) {
  session.lastActivity = Date.now();
  if (kvEnabled()) {
    try {
      await kvSetJSON(`gladis:session:${waId}`, session, Math.floor(SESSION_TTL_MS / 1000));
    } catch (e) {
      console.error("saveSession error:", e);
    }
    return;
  }
  sessionsMem.set(waId, session);
}

async function markSeen(messageId) {
  if (!messageId) return false;
  if (kvEnabled()) {
    const isNew = await kvSetIfNew(`gladis:seen:${messageId}`, 3600);
    return !isNew;
  }
  const now = Date.now();
  if (processedIdsMem.has(messageId)) return true;
  processedIdsMem.set(messageId, now);
  if (processedIdsMem.size > 5000) {
    for (const [k, t] of processedIdsMem) {
      if (now - t > 60 * 60 * 1000) processedIdsMem.delete(k);
    }
  }
  return false;
}

// ============================================================================
// Graph API
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
    console.error("WhatsApp text send error", r.status, await r.text());
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
    console.error("WhatsApp image send error", r.status, await r.text());
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
// OpenAI
// ============================================================================

async function openaiJSON(messages, { model = OPENAI_MODEL, temperature = 0.2 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
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
      console.error("OpenAI JSON error", r.status, await r.text());
      return null;
    }
    const data = await r.json();
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch (e) {
    console.error("OpenAI JSON exception", e);
    return null;
  }
}

async function unifyMaterialDescription(userText, analysis) {
  const fallbackParts = [analysis?.material, analysis?.acabado, analysis?.descripcion]
    .filter((x) => x && x !== "no claro");
  const fallback = fallbackParts.length
    ? `${userText} (de la imagen referencial: ${fallbackParts.join(", ")})`
    : userText;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente para cotizaciones de carpintería metálica y fabricación. Recibes la descripción que dio un cliente y los datos extraídos de una imagen referencial. Devuelve UNA sola oración natural en español que combine ambas fuentes describiendo material, acabado y detalles visuales del trabajo. Máximo 280 caracteres. Sin etiquetas, sin viñetas, sin explicaciones, solo la oración final.",
          },
          {
            role: "user",
            content: `Descripción del cliente: "${userText}".\n\nDe la imagen se aprecia:\n- material: ${
              analysis?.material || "no claro"
            }\n- acabado: ${analysis?.acabado || "no claro"}\n- descripción: ${
              analysis?.descripcion || "no claro"
            }\n\nGenera una sola oración combinada que describa con detalle material, acabado y detalles visuales.`,
          },
        ],
      }),
    });
    if (!r.ok) {
      console.error("unifyMaterialDescription error", r.status, await r.text());
      return fallback;
    }
    const data = await r.json();
    const txt = data.choices?.[0]?.message?.content?.trim();
    return txt || fallback;
  } catch (e) {
    console.error("unifyMaterialDescription exception", e);
    return fallback;
  }
}

async function analyzeImage(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;
  try {
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
                  "Analiza la imagen y devuelve JSON con las claves: tipo_trabajo (string), material (string), acabado (string), medidas_aproximadas (string), descripcion (string breve). Si un campo no se puede deducir, usa 'no claro'.",
              },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      console.error("OpenAI vision error", r.status, await r.text());
      return null;
    }
    const data = await r.json();
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch (e) {
    console.error("OpenAI vision exception", e);
    return null;
  }
}

// ============================================================================
// Detectores locales
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
  return /\b(s[ií]|claro|correcto|exacto|de acuerdo|dale|ok|okay|listo|perfecto|confirmo|confirmado|as[íi] es)\b/i.test(
    text
  );
}

function looksLikeDeny(text) {
  if (!text) return false;
  return /\b(no|incorrecto|cambiar|modificar|equivocado|no es|nop|nope)\b/i.test(text);
}

function looksLikeRefuseAddress(text) {
  if (!text) return false;
  return /\b(no (te|le) (puedo|quiero) dar|no (quiero|deseo|puedo) (dar|compartir|brindar)|prefiero no|privad[oa]|no compartir)\b/i.test(
    text
  );
}

function isPushback(text) {
  if (!text) return false;
  return /\b(ya (te |le |se )?(lo |la |los |las )?(?:di|dije|mencion[ée]|indiqu[ée]|inform[ée]|envi[ée]|mand[ée])|te lo (acabo de |ya )?(?:di|dije|mencion[ée])|ya lo (?:di|dije|mencion[ée])|repet[ií]s|me preguntas lo mismo|no me (?:entiendes|escuchas))\b/i.test(
    text
  );
}

function isInitialGreetingOnly(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return true;
  return /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|holi|saludos|alo|alguien|est[áa]n? atendiendo|atienden)\b[\s,.!?¿¡]*$/i.test(
    t.replace(/\s+/g, " ")
  );
}

// El cliente pide explícitamente otra cotización tras haber cerrado una.
function looksLikeNewQuoteRequest(text) {
  if (!text) return false;
  return /\b(otra|nueva|otro|nuevo|m[áa]s|adicional|adicionalmente|tambi[ée]n)\s+(cotizaci[oó]n(?:es)?|consulta|trabajo|cotizar|pedido|proyecto|servicio|requerimiento)\b/i.test(
    text
  )
    || /\b(necesito|quiero|quer[ií]a|tengo|deseo|requiero)\s+(otra|otro|m[áa]s|cotizar|una?\s+cotizaci[oó]n|un\s+presupuesto|otra\s+consulta)\b/i.test(
      text
    )
    || /\b(pedir|hacer|solicitar|consultar)\s+(otra|otro|m[áa]s|una?\s+nueva?)\b/i.test(text)
    || /\b(cotizar|cotizame|cot[ií]zame)\s+otro\b/i.test(text);
}

// ============================================================================
// Validadores
// ============================================================================

const FILLER_WORDS = [
  "si",
  "sí",
  "no",
  "ok",
  "okay",
  "listo",
  "perfecto",
  "correcto",
  "claro",
  "dale",
  "ya",
  "confirmo",
  "gracias",
  "exacto",
  "asi",
  "así",
  "bien",
];

function normalizeWord(s) {
  return String(s || "").trim().toLowerCase();
}

function isValidTipoTrabajo(val) {
  if (!val) return false;
  const t = normalizeWord(val);
  if (t.length < 4) return false;
  if (FILLER_WORDS.includes(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

function isValidMaterial(val, tipoTrabajo) {
  if (!val) return false;
  const v = normalizeWord(val);
  if (v.length < 4) return false;
  if (FILLER_WORDS.includes(v)) return false;
  if (tipoTrabajo) {
    const t = normalizeWord(tipoTrabajo);
    if (v.split(/\s+/).length === 1 && t.includes(v)) return false;
    if (v === "metal" || v === "metálico" || v === "metalico") return false;
  }
  return true;
}

function isValidName(val) {
  if (!val) return false;
  const v = String(val).trim();
  if (v.length < 3) return false;
  const low = v.toLowerCase();
  if (FILLER_WORDS.includes(low)) return false;
  if (isPushback(v)) return false;
  if (/^\d+$/.test(v)) return false;
  if (low.startsWith("ya te") || low.startsWith("ya lo")) return false;
  return true;
}

// ===== Cantidad y material base =====

const MATERIAL_SPECIFICS_RE =
  /\b(acero(?:\s+inoxidable)?|inox(?:idable)?|fierro|hierro|aluminio|galvanizad\w*|laf|lac|laminad\w*|cobre|bronce|madera|melamina|vidrio|policarbonat\w*|calamina|drywall|pvc)\b/i;

const MATERIAL_GENERIC_LEADING_RE =
  /^\s*(metal|met[áa]lic[oa]s?)\b[\s.,;:-]*/i;

function materialNeedsBaseClarification(text) {
  if (!text) return false;
  if (MATERIAL_SPECIFICS_RE.test(text)) return false;
  return MATERIAL_GENERIC_LEADING_RE.test(text);
}

function stripGenericMetalPrefix(text) {
  if (!text) return "";
  let s = String(text).replace(MATERIAL_GENERIC_LEADING_RE, "");
  s = s.replace(/^\s*(con|de|en|y)\s+/i, "");
  return s.trim();
}

const QUANTITY_NOUNS_RE =
  /(port[oó]n(?:es)?|puerta[s]?|ventana[s]?|escalera[s]?|baranda[s]?|reja[s]?|estructura[s]?|techo[s]?|coberturas?|mesa[s]?|silla[s]?|mueble[s]?|garaje[s]?|cochera[s]?|cerco[s]?|cercad[oa]s?|pasamanos?|estanter[íi]as?)/i;

function extractQuantityHint(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const single = t.match(
    new RegExp(`\\b(?:un(?:o|a)?\\s+sol[oa]|sol[oa]\\s+un[oa]?|[úu]nic[oa])\\s+${QUANTITY_NOUNS_RE.source}`, "i")
  );
  if (single) return { count: 1, noun: single[1] };
  const num = t.match(new RegExp(`\\b(\\d+)\\s+${QUANTITY_NOUNS_RE.source}`, "i"));
  if (num) return { count: parseInt(num[1], 10), noun: num[2] };
  const article = t.match(new RegExp(`\\b(?:un|una)\\s+${QUANTITY_NOUNS_RE.source}`, "i"));
  if (article) return { count: 1, noun: article[1] };
  return null;
}

function ensureQuantityInMedidas(userText, candidate) {
  if (!candidate) return candidate;
  const qty = extractQuantityHint(userText);
  if (!qty) return candidate;
  const candLow = candidate.toLowerCase();
  const nounStem = qty.noun.toLowerCase().replace(/(es|s)$/i, "");
  const hasQtyAtStart = /^\s*(\d+|un[oa]?|sol[oa])\b/.test(candLow);
  const mentionsNoun = candLow.includes(nounStem);
  if (hasQtyAtStart && mentionsNoun) return candidate;
  const label =
    qty.count === 1
      ? `1 ${qty.noun}`
      : `${qty.count} ${qty.noun.endsWith("s") ? qty.noun : qty.noun + "s"}`;
  if (mentionsNoun) {
    return candidate.replace(new RegExp(qty.noun, "i"), label);
  }
  return `${label}, ${candidate}`;
}

// ============================================================================
// Clasificador OpenAI por turno
// ============================================================================

function describeStep(step) {
  switch (step) {
    case "saludo":
      return "todavía no se inicia, esperar primer mensaje";
    case "tipo_trabajo":
      return "preguntar qué desea construir o fabricar";
    case "material":
      return "preguntar material o acabado";
    case "material_base":
      return "el cliente debe especificar el material base (acero, fierro o aluminio)";
    case "material_await_image":
      return "esperar si el cliente enviará una imagen referencial para complementar la descripción";
    case "material_confirm_proposal":
      return "el cliente debe confirmar la propuesta combinada (descripción + imagen)";
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
Devuelves SOLO un JSON con esta forma exacta:
{
  "intent": "answer" | "out_of_order" | "off_topic" | "abuse" | "modify" | "confirm" | "deny" | "refuse_address" | "no_idea_material" | "approximate_size" | "pushback",
  "value_for_current_step": string | null,
  "captured_for_other_steps": {
    "tipo_trabajo": string | null,
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
- "off_topic": se desvía del tema (clima, política, vida personal, charla informal).
- "abuse": insultos, groserías, lenguaje sexual o amenazas.
- "modify": pide cambiar/corregir algo del resumen ya mostrado.
- "confirm": responde sí/correcto/ok/confirmo a una pregunta cerrada de confirmación.
- "deny": responde no/incorrecto a una pregunta cerrada de confirmación.
- "refuse_address": en el paso de ubicación dice que no quiere o no puede dar la dirección.
- "no_idea_material": en el paso de material dice no sé / no tengo idea / no conozco materiales.
- "approximate_size": en medidas indica que son aproximados / no exactos / cálculo grueso.
- "pushback": dice que ya entregó la información (ej. "ya te lo di", "te lo acabo de decir", "ya lo mencioné").

Reglas estrictas:
- "value_for_current_step" debe ser una versión limpia y breve de la respuesta para el paso actual, o null si no aplica.
- En "captured_for_other_steps" incluye SOLO valores claramente expresados en este mensaje. NO inventes.
- NUNCA captures "material" en captured_for_other_steps (la clave 'material' no existe arriba): el material se preguntará en su propio paso.
- En el paso tipo_trabajo, "value_for_current_step" DEBE preservar la descripción completa que dio el usuario (ej. "portón en metal", "puerta corrediza de fierro", "escalera tipo caracol"). Solo elimina saludos o muletillas iniciales. NO acortes a una sola palabra ni quites adjetivos como "en metal", "metálico", "corrediza", etc.
- En el paso material, si el usuario dice solo "metal" o "metálico" sin precisar acero/fierro/aluminio, deja "value_for_current_step" con esa frase tal cual; el servidor se encargará de repreguntar el material base.
- En el paso medidas, "value_for_current_step" DEBE incluir la cantidad de unidades cuando el usuario la mencione, junto con las dimensiones. Ejemplos:
   * "un solo portón, 5 metros de ancho por 1 metro de largo" → "1 portón de 5 m de ancho x 1 m de largo"
   * "necesito 3 ventanas de 1.2 x 1.5" → "3 ventanas de 1.2 m x 1.5 m"
   * Si el usuario solo da dimensiones sin cantidad explícita, devuelve solo las dimensiones.
- ambito: "domestico" si dice casa, hogar, familia, personal, vivienda. "industrial" si dice empresa, negocio, industria, fábrica, comercial.
- ruc: 11 dígitos consecutivos.
- nombre: si dice "soy X", "me llamo X", "mi nombre es X", devuelve solo el nombre.
- Si el cliente solo escribió un saludo corto (hola, buenas, buenos días, están atendiendo), trata el intent como "answer" con value_for_current_step null (no es out_of_order ni off_topic).
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
// Plantillas
// ============================================================================

function greetingMessage() {
  return `Hola 🙂 Soy ${ASSISTANT_NAME}, asistente comercial de ${COMPANY_BRAND}. Con gusto te ayudo con tu cotización.

Para comenzar, cuéntame por favor qué tipo de trabajo deseas construir o fabricar (por ejemplo: portón metálico, escalera, baranda, ventana, estructura).`;
}

function askForStep(session, step) {
  switch (step) {
    case "tipo_trabajo":
      return "Cuéntame por favor, qué tipo de trabajo deseas construir o fabricar?";
    case "material":
      return askMaterial(session?.fields?.tipo_trabajo);
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
    ? `Anoté: ${tipoTrabajo}.\n\nAhora cuéntame por favor sobre el material, acabado y detalles visuales del proyecto. Descríbelo lo mejor posible (material base, color, textura, estilo, acabado, terminaciones, etc.).`
    : "Cuéntame por favor sobre el material, acabado y detalles visuales del proyecto. Descríbelo lo mejor posible (material base, color, textura, estilo, acabado, terminaciones, etc.).";
  const refs = `Si quieres referencias visuales puedes revisar:
- Web: ${COMPANY_WEB_URL}
- Facebook: ${COMPANY_FB_URL}

Si tienes una imagen referencial, envíamela y la uniré con tu descripción para proponerte una propuesta clara. Si no tienes idea, dímelo y te sugiero opciones.`;
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
  if (/(escaler|pasamano)/.test(t))
    return "tubo redondo de 2 pulgadas en acero inoxidable o fierro pintado";
  if (/(mesa|mueble|silla|estanter)/.test(t))
    return "estructura de fierro cuadrado o redondo con acabado pintura electrostática y tablero de melamina o madera";
  if (/(garaje|cochera)/.test(t))
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
    null,
    step
  )}`;
}

function outOfOrderRedirect(step) {
  return `Anotado, en un momento llegamos a eso. Primero necesito: ${askForStep(null, step)}`;
}

function warningEndingMessage(step) {
  return `Lamentablemente, si seguimos así tendré que finalizar la conversación. Volvamos al tema, por favor: ${askForStep(
    null,
    step
  )}`;
}

function blockedFarewellMessage() {
  return "Lamento tener que finalizar la conversación por el momento. Si gustas, escríbenos más tarde y con gusto retomamos tu cotización.";
}

function farewellMessage() {
  return `Quedan validadas las especificaciones. Procederemos a preparar la cotización formal a la brevedad y nos pondremos en contacto contigo si necesitamos ajustar algún detalle. Muchas gracias por confiar en ${COMPANY_BRAND} 🙂`;
}

function closedAckMessage() {
  return "Tu cotización ya está en proceso. Nuestro equipo se contactará contigo en breve. Gracias!";
}

function pushbackResponse(step) {
  return `Disculpa la insistencia, lo confirmo para asegurar tu cotización. ${askForStep(null, step)}`;
}

// ============================================================================
// Resumen y modificación
// ============================================================================

function normalizePeruPhone(num) {
  const d = String(num || "").replace(/\D/g, "");
  if (!d) return "";
  if (/^9\d{8}$/.test(d)) return "51" + d;
  return d;
}

function formatPhone(num) {
  const d = normalizePeruPhone(num);
  if (/^51\d{9}$/.test(d)) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.length > 0) return `+${d}`;
  return num || "";
}

function firstName(full) {
  if (!full) return null;
  const parts = String(full).trim().split(/\s+/);
  return parts[0] || null;
}

function buildSummaryLines(session, contactNumber, { includeConfirmationLine }) {
  const f = session.fields;
  const nombreCorto = firstName(f.nombre) || firstName(session.profileName) || "No especificado";
  const rucONombre = f.ruc ? `RUC ${f.ruc}` : f.nombre || "No especificado";
  const lines = [
    "Resumen de tu cotización:",
    "",
    `- Número de contacto: ${formatPhone(contactNumber)}`,
    `- Nombre del cliente: ${nombreCorto}`,
    "",
    `1) Tipo de trabajo: ${f.tipo_trabajo || "No especificado"}`,
    `2) Material o acabado: ${f.material || "No especificado"}`,
    `3) Cantidad y medidas: ${f.medidas || "No especificado"}`,
    `4) Trabajo doméstico/industrial: ${f.ambito || "No especificado"}`,
    `5) Ubicación/referencia: ${f.ubicacion || "No especificado"}`,
    `6) RUC/Nombre: ${rucONombre}`,
  ];
  if (includeConfirmationLine) {
    lines.push(
      "",
      'Si todo está correcto, escribe "confirmo" para que procedamos con la cotización formal. Si deseas modificar algún punto, indícame el número (1 a 6) y el nuevo dato.'
    );
  }
  return lines.join("\n");
}

function summaryText(session, contactNumber) {
  return buildSummaryLines(session, contactNumber, { includeConfirmationLine: true });
}

function summaryForForwardText(session, contactNumber) {
  return buildSummaryLines(session, contactNumber, { includeConfirmationLine: false });
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
// Avance del flujo (orden estricto, sin auto-skip)
// ============================================================================

function nextLinearStep(currentStep) {
  let key = currentStep;
  if (key === "material_base") key = "material";
  if (key === "material_await_image") key = "material";
  if (key === "material_confirm_proposal") key = "material";
  if (key === "ubicacion_confirmar") key = "ubicacion_pedir";
  if (key === "identificacion_nombre") key = "identificacion_ruc";
  const idx = LINEAR_STEPS.indexOf(key);
  if (idx === -1) return "tipo_trabajo";
  if (idx === LINEAR_STEPS.length - 1) return "resumen_confirmar";
  return LINEAR_STEPS[idx + 1];
}

async function advanceAndAsk(session, from) {
  const next = nextLinearStep(session.step);
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

  if (captured.tipo_trabajo && !f.tipo_trabajo && session.step !== "tipo_trabajo") {
    const v = String(captured.tipo_trabajo).trim();
    if (isValidTipoTrabajo(v)) f.tipo_trabajo = v;
  }
  // material NUNCA desde captured: se preguntará en su paso.

  if (captured.medidas && !f.medidas) {
    const v = String(captured.medidas).trim();
    if (/\d/.test(v) && v.length >= 3) f.medidas = v;
  }
  if (captured.ambito && !f.ambito) {
    const a = String(captured.ambito).toLowerCase();
    if (a === "domestico" || a === "doméstico") f.ambito = "doméstico/hogar";
    else if (a === "industrial") f.ambito = "industrial/empresa";
  }
  if (captured.ubicacion && !f.ubicacion) {
    const v = String(captured.ubicacion).trim();
    if (v.length >= 4 && !isPushback(v)) f.ubicacion = v;
  }
  if (captured.ruc && !f.ruc) {
    const d = String(captured.ruc).replace(/\D/g, "");
    if (/^\d{11}$/.test(d)) f.ruc = d;
  }
  if (captured.nombre && !f.nombre && isValidName(captured.nombre)) {
    f.nombre = String(captured.nombre).trim();
  }
}

// ============================================================================
// Extracción del webhook
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

function getLeadRecipients() {
  const defaults = ["972324798", "971193243"];
  const extra = String(process.env.LEAD_FORWARD_TO || "")
    .split(/[,;\s]+/)
    .filter(Boolean);
  const all = [...defaults, ...extra].map(normalizePeruPhone).filter(Boolean);
  return [...new Set(all)];
}

async function forwardLead(session, customerFrom) {
  // Dedup: si ya se reenvió este lead en las últimas 24h, no repetir
  // (cubre reintentos de Meta y carreras en serverless).
  const now = Date.now();
  if (session.leadForwardedAt && now - session.leadForwardedAt < 24 * 60 * 60 * 1000) {
    console.warn("forwardLead: lead ya reenviado recientemente, se omite");
    return;
  }
  // Marcar antes de enviar para evitar duplicados si una segunda invocación entra en paralelo.
  session.leadForwardedAt = now;

  const recipients = getLeadRecipients();
  if (!recipients.length) return;

  const intro =
    "Hola Yojan 🙋🏻‍♀️ Un nuevo Cliente se ha comunicado con nosotros y estos son las especificaciones del proyecto 📝, comunícate con él enviándole la cotización a la brevedad posible o para hacer alguna consulta adicional, que tengas un buen día 🙂";
  const summary = summaryForForwardText(session, customerFrom);

  let forwardImageId = null;
  if (session.images.length) {
    const last = session.images[session.images.length - 1];
    forwardImageId = await reuploadImageForOurNumber(last.mediaId);
  }

  for (const to of recipients) {
    await sendText(to, intro);
    if (forwardImageId) {
      await sendImage(to, forwardImageId);
    }
    await sendText(to, summary);
  }
}

// ============================================================================
// Anti-abuso
// ============================================================================

function currentAskableStep(session) {
  const s = session.step;
  if (s === "saludo") return "tipo_trabajo";
  if (s === "material_base") return "material";
  if (s === "material_await_image") return "material";
  if (s === "material_confirm_proposal") return "material";
  if (s === "ubicacion_confirmar") return "ubicacion_pedir";
  if (s === "identificacion_nombre") return "identificacion_ruc";
  return s;
}

async function handleAbuse(session, from) {
  session.warnings += 1;
  if (session.warnings >= 3) {
    session.blockedUntil = Date.now() + ABUSE_COOLDOWN_MS;
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

// ============================================================================
// Procesar mensaje
// ============================================================================

async function processImage(session, msg) {
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

  // Bloqueo silencioso por abuso (no respondemos nada).
  if (session.blockedUntil && session.blockedUntil > now) return;

  // Conversación cerrada formalmente: acuse breve o reapertura si pide nueva cotización.
  if (session.step === "cerrado") {
    const incomingText = (msg.text || msg.caption || "").trim();
    const closedSince = session.closedUntil
      ? now - (session.closedUntil - CLOSED_COOLDOWN_MS)
      : Number.POSITIVE_INFINITY;

    const explicitNew = msg.type === "image" || looksLikeNewQuoteRequest(incomingText);
    const looksLikeNewSession = isInitialGreetingOnly(incomingText);
    const enoughTimePassed = closedSince >= CLOSED_AUTO_REOPEN_MS;
    const cooldownExpired = !session.closedUntil || session.closedUntil <= now;

    const wantsReopen = explicitNew || looksLikeNewSession || enoughTimePassed || cooldownExpired;

    if (!wantsReopen) {
      if (!session.closedAckAt || now - session.closedAckAt > CLOSED_ACK_COOLDOWN_MS) {
        await sendText(from, closedAckMessage());
        session.closedAckAt = now;
      }
      return;
    }

    // Reiniciar la sesión como una nueva conversación.
    const fresh = newSession();
    fresh.profileName = session.profileName;
    Object.assign(session, fresh);

    if (explicitNew && msg.type !== "image") {
      // Reapertura breve: ya conocemos al cliente, no repetimos el saludo completo.
      session.step = "tipo_trabajo";
      await sendText(
        from,
        "Con gusto te ayudo con una nueva cotización. Cuéntame por favor qué tipo de trabajo deseas construir o fabricar (por ejemplo: portón metálico, escalera, baranda, ventana, estructura)."
      );
      return;
    }
    // En el resto de casos (saludo, imagen, tiempo extenso) caemos al flujo normal:
    // - Imagen: el bloque de imágenes de abajo se encarga.
    // - Saludo/silencio prolongado: el bloque de saludo inicial enviará el greeting completo.
  }

  // === Imagen entrante ===
  if (msg.type === "image" && msg.mediaId) {
    const analysis = await processImage(session, msg);
    if (session.step === "saludo") {
      session.step = "tipo_trabajo";
      await sendText(from, greetingMessage());
      if (analysis && analysis.tipo_trabajo && analysis.tipo_trabajo !== "no claro") {
        await sendText(
          from,
          `Recibí tu imagen referencial. En ella se aprecia: ${
            analysis.descripcion || analysis.tipo_trabajo
          }. Confírmame con tus palabras qué deseas construir o fabricar.`
        );
      } else {
        await sendText(from, "Recibí tu imagen y la usaré como referencia visual.");
      }
      return;
    }
    if (
      (session.step === "material" ||
        session.step === "material_await_image" ||
        session.step === "material_confirm_proposal") &&
      analysis
    ) {
      // Si el cliente ya describió antes con texto, unir descripción + imagen y proponer.
      if (session.pendingMaterialDescription) {
        const propuesta = await unifyMaterialDescription(
          session.pendingMaterialDescription,
          analysis
        );
        session.pendingMaterialProposal = propuesta;
        session.step = "material_confirm_proposal";
        await sendText(
          from,
          `Uniendo lo que me describiste con la imagen, propongo lo siguiente:\n\n"${propuesta}"\n\n¿Estás de acuerdo con esta propuesta? Responde "sí" para continuar, o descríbeme con más detalle si prefieres ajustar.`
        );
        return;
      }
      // Solo imagen sin descripción previa: propuesta directa del análisis.
      const pieces = [analysis.material, analysis.acabado]
        .filter((x) => x && x !== "no claro")
        .join(" con acabado ");
      if (pieces) {
        session.pendingMaterialSuggestion = pieces;
        await sendText(
          from,
          `Por la imagen, el material posible sería: ${pieces}.\n\n¿Trabajamos con esa propuesta o prefieres complementar con tu propia descripción del material, acabado y detalles visuales?`
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

  // === Saludo inicial: enviar greeting y salir (no clasificar el mismo texto) ===
  if (session.step === "saludo") {
    session.step = "tipo_trabajo";
    await sendText(from, greetingMessage());
    return;
  }

  if (!userText) return;

  // === Profanidad local (rápido, sin OpenAI) ===
  if (looksLikeProfanity(userText)) {
    return await handleAbuse(session, from);
  }

  // === Pushback: el cliente dice que ya entregó la info ===
  if (isPushback(userText)) {
    await sendText(from, pushbackResponse(currentAskableStep(session)));
    return;
  }

  // === Clasificador ===
  const cls = await classify(session, userText);

  if (cls.intent === "abuse") {
    return await handleAbuse(session, from);
  }
  if (cls.intent === "pushback") {
    await sendText(from, pushbackResponse(currentAskableStep(session)));
    return;
  }

  applyCapturedOtherSteps(session, cls.captured_for_other_steps);

  switch (session.step) {
    case "tipo_trabajo":
      return await stepTipoTrabajo(session, from, userText, cls);
    case "material":
      return await stepMaterial(session, from, userText, cls);
    case "material_base":
      return await stepMaterialBase(session, from, userText, cls);
    case "material_await_image":
      return await stepMaterialAwaitImage(session, from, userText, cls);
    case "material_confirm_proposal":
      return await stepMaterialConfirmProposal(session, from, userText, cls);
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
  const candidate = (cls.value_for_current_step || cls.captured_for_other_steps?.tipo_trabajo || userText || "").trim();
  if (!isValidTipoTrabajo(candidate)) {
    await sendText(
      from,
      "Necesito un poco más de detalle, por favor. Qué tipo de trabajo deseas construir o fabricar? (por ejemplo: portón metálico, escalera, baranda, ventana, estructura)"
    );
    return;
  }
  session.fields.tipo_trabajo = candidate;
  await advanceAndAsk(session, from);
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
    session.pendingMaterialDescription = null;
    await advanceAndAsk(session, from);
    return;
  }
  if (cls.intent === "deny" && session.pendingMaterialSuggestion) {
    session.pendingMaterialSuggestion = null;
    await sendText(from, "Sin problema. Qué material o acabado prefieres entonces?");
    return;
  }
  const candidate = (cls.value_for_current_step || userText || "").trim();
  if (!isValidMaterial(candidate, session.fields.tipo_trabajo)) {
    await sendText(
      from,
      "Necesito un poco más de precisión en el material, acabado y detalles visuales. Por ejemplo: acero inoxidable, fierro pintado, aluminio, con pintura electrostática o anticorrosiva, color X, etc."
    );
    return;
  }
  // Si ya hay imagen analizada previa, unir texto + imagen y proponer al cliente.
  const lastImage = session.images.length ? session.images[session.images.length - 1] : null;
  if (lastImage?.analysis) {
    session.pendingMaterialDescription = candidate;
    const propuesta = await unifyMaterialDescription(candidate, lastImage.analysis);
    session.pendingMaterialProposal = propuesta;
    session.step = "material_confirm_proposal";
    await sendText(
      from,
      `Uniendo tu descripción con la imagen referencial, propongo lo siguiente:\n\n"${propuesta}"\n\n¿Estás de acuerdo con esta propuesta? Responde "sí" para continuar, o descríbeme con más detalle si prefieres ajustar.`
    );
    return;
  }
  // Si el usuario dijo "metal/metálico" sin precisar el material base, repreguntar.
  if (materialNeedsBaseClarification(candidate)) {
    session.pendingMaterialBaseFrom = candidate;
    session.step = "material_base";
    await sendText(
      from,
      'Cuando dices "metal", ¿a qué te refieres específicamente: acero, fierro o aluminio? (puedes indicar el que prefieras)'
    );
    return;
  }
  // Sin imagen aún: guardar descripción y preguntar si va a enviar una imagen referencial.
  session.pendingMaterialDescription = candidate;
  session.step = "material_await_image";
  await sendText(
    from,
    'Anotado. ¿Tienes una imagen referencial que quieras adjuntar para complementar tu descripción? Si la tienes, envíamela; si no tienes imagen, responde "continuar" o "sin imagen" y avanzamos.'
  );
}

async function stepMaterialAwaitImage(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("material"));

  const t = (userText || "").toLowerCase().trim();
  const wantsContinue =
    /(sin\s+imagen|no\s+tengo\s+imagen|no\s+ten[ée]\s+imagen|no\s+hay\s+imagen|continuar|continuemos|sigamos|avanzar|adelante|ninguna|nada\s+m[áa]s)/i.test(
      t
    ) ||
    cls.intent === "confirm" ||
    /^(no|nope|nop)\b\s*$/i.test(t);

  if (wantsContinue) {
    const finalMat = (session.pendingMaterialDescription || "").trim();
    session.pendingMaterialDescription = null;
    if (!isValidMaterial(finalMat, session.fields.tipo_trabajo)) {
      session.step = "material";
      await sendText(
        from,
        "Necesito un poco más de precisión en el material, acabado y detalles visuales. Por ejemplo: acero inoxidable, fierro pintado, aluminio, con pintura electrostática o anticorrosiva, color X."
      );
      return;
    }
    if (materialNeedsBaseClarification(finalMat)) {
      session.pendingMaterialBaseFrom = finalMat;
      session.step = "material_base";
      await sendText(
        from,
        'Cuando dices "metal", ¿a qué te refieres específicamente: acero, fierro o aluminio?'
      );
      return;
    }
    session.fields.material = finalMat;
    session.pendingMaterialSuggestion = null;
    session.step = "material";
    await advanceAndAsk(session, from);
    return;
  }

  // El cliente reformuló su descripción en lugar de responder sobre la imagen.
  if (userText && userText.trim().length > 5) {
    session.pendingMaterialDescription = userText.trim();
    await sendText(
      from,
      'Anotado, actualicé tu descripción. ¿Tienes una imagen referencial para complementarla? Envíamela ahora, o responde "continuar" para avanzar sin imagen.'
    );
    return;
  }

  // Respuesta corta y ambigua: repetir la pregunta.
  await sendText(
    from,
    'Si tienes una imagen referencial, envíamela ahora y la uniré con tu descripción. Si no tienes imagen, responde "continuar" para avanzar.'
  );
}

async function stepMaterialConfirmProposal(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("material"));

  if (cls.intent === "confirm" || looksLikeConfirm(userText)) {
    const finalMat = session.pendingMaterialProposal;
    session.fields.material = finalMat;
    session.pendingMaterialProposal = null;
    session.pendingMaterialDescription = null;
    session.pendingMaterialSuggestion = null;
    session.step = "material";
    await advanceAndAsk(session, from);
    return;
  }

  if (cls.intent === "deny" || looksLikeDeny(userText)) {
    session.pendingMaterialProposal = null;
    session.pendingMaterialDescription = null;
    session.step = "material";
    await sendText(
      from,
      "Sin problema. Por favor descríbeme con el mayor detalle posible el material, acabado y detalles visuales del trabajo que tienes en mente."
    );
    return;
  }

  // Si el cliente envió una nueva descripción en vez de confirmar, re-unir con la imagen.
  if (userText && userText.trim().length > 5) {
    const lastImage = session.images.length ? session.images[session.images.length - 1] : null;
    if (lastImage?.analysis) {
      session.pendingMaterialDescription = userText.trim();
      const propuesta = await unifyMaterialDescription(userText.trim(), lastImage.analysis);
      session.pendingMaterialProposal = propuesta;
      await sendText(
        from,
        `Actualicé la propuesta:\n\n"${propuesta}"\n\n¿Estás de acuerdo? Responde "sí" para continuar, o ajusta con otra descripción si prefieres.`
      );
      return;
    }
    // Sin imagen disponible: tratar texto como nuevo intento de descripción del material.
    session.pendingMaterialProposal = null;
    session.pendingMaterialDescription = userText.trim();
    session.step = "material";
    await stepMaterial(session, from, userText, cls);
    return;
  }

  await sendText(
    from,
    `¿Trabajamos con esta propuesta?:\n\n"${session.pendingMaterialProposal}"\n\nResponde "sí" para continuar, o descríbeme con más detalle si prefieres ajustar.`
  );
}

async function stepMaterialBase(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("material"));
  const text = (userText || "").trim();
  const baseMatch = text.match(MATERIAL_SPECIFICS_RE);
  if (!baseMatch) {
    await sendText(
      from,
      "Por favor indícame el material base: acero, fierro o aluminio (puedes agregar 'inoxidable' o 'galvanizado' si aplica)."
    );
    return;
  }
  const base = baseMatch[1] || baseMatch[0];
  const original = session.pendingMaterialBaseFrom || "";
  const rest = stripGenericMetalPrefix(original);
  const combined = rest ? `${base} con ${rest}` : base;
  session.fields.material = combined;
  session.pendingMaterialBaseFrom = null;
  session.pendingMaterialSuggestion = null;
  session.step = "material";
  await advanceAndAsk(session, from);
}

async function stepMedidas(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("medidas"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("medidas"));
  let candidate = (cls.value_for_current_step || cls.captured_for_other_steps?.medidas || userText || "").trim();
  if (!candidate || candidate.length < 2 || isPushback(candidate)) {
    await sendText(from, askForStep(session, "medidas"));
    return;
  }
  candidate = ensureQuantityInMedidas(userText, candidate);
  session.fields.medidas = candidate;
  if (cls.intent === "approximate_size") {
    await sendText(from, `Anotado, trabajaremos con esas medidas aproximadas para la cotización (${candidate}).`);
  }
  await advanceAndAsk(session, from);
}

async function stepAmbito(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("ambito"));
  if (cls.intent === "out_of_order") return await sendText(from, outOfOrderRedirect("ambito"));
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
  const candidate = (cls.value_for_current_step || cls.captured_for_other_steps?.ubicacion || userText || "").trim();
  if (!candidate || candidate.length < 2) {
    await sendText(from, askForStep(session, "ubicacion_pedir"));
    return;
  }
  session.pendingUbicacion = candidate;
  session.step = "ubicacion_confirmar";
  await sendText(from, confirmUbicacionText(candidate));
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
    if (!session.fields.nombre || !isValidName(session.fields.nombre)) {
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
      if (!session.fields.nombre || !isValidName(session.fields.nombre)) {
        session.step = "identificacion_nombre";
        await sendText(from, askNombreParaDirigirse());
        return;
      }
      await advanceAndAsk(session, from);
      return;
    }
  }
  const nombreCandidate = (cls.captured_for_other_steps?.nombre || userText || "").trim();
  if (isValidName(nombreCandidate)) {
    session.fields.nombre = nombreCandidate;
    await advanceAndAsk(session, from);
    return;
  }
  await sendText(from, askForStep(session, "identificacion_ruc"));
}

async function stepIdentificacionNombre(session, from, userText, cls) {
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("identificacion_nombre"));
  const nombreCandidate = (cls.captured_for_other_steps?.nombre || userText || "").trim();
  if (!isValidName(nombreCandidate)) {
    await sendText(from, askNombreParaDirigirse());
    return;
  }
  session.fields.nombre = nombreCandidate;
  await advanceAndAsk(session, from);
}

async function stepResumenConfirmar(session, from, userText, cls) {
  if (cls.intent === "abuse") return await handleAbuse(session, from);
  if (cls.intent === "off_topic") return await sendText(from, gentleRedirect("resumen_confirmar"));
  if (
    cls.intent === "confirm" ||
    /\bconfirmo\b/i.test(userText) ||
    (looksLikeConfirm(userText) && !looksLikeDeny(userText))
  ) {
    await sendText(from, farewellMessage());
    try {
      await forwardLead(session, from);
    } catch (e) {
      console.error("forwardLead error:", e);
    }
    session.step = "cerrado";
    session.closedUntil = Date.now() + CLOSED_COOLDOWN_MS;
    session.closedAckAt = 0;
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
    'Si todo está correcto escribe "confirmo". Si deseas modificar, dime el número del 1 al 6 y el nuevo dato.'
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
  const cleaned = text
    .replace(/^\s*\b[1-6]\b[\s.):\-]*/i, "")
    .replace(
      /^(el|la)?\s*(tipo de trabajo|material|acabado|medida[s]?|cantidad|ámbito|ambito|domést[ií]co|industrial|ubicaci[oó]n|direcci[oó]n|referencia|ruc|nombre)[\s:.\-]*/i,
      ""
    )
    .trim();
  if (!cleaned || cleaned.length < 2) return null;
  if (cleaned.toLowerCase() === text.toLowerCase()) return null;
  return cleaned;
}

function applyFieldUpdate(session, field, val) {
  if (field === "identificacion") {
    const rucMatch = val.match(/\b\d{11}\b/);
    if (rucMatch) {
      session.fields.ruc = rucMatch[0];
      const rest = val.replace(rucMatch[0], "").trim();
      if (isValidName(rest)) session.fields.nombre = rest;
    } else if (isValidName(val)) {
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
// Loop principal
// ============================================================================

async function processInbound(body) {
  if (!body || typeof body !== "object") return;
  const items = extractInbound(body);
  for (const msg of items) {
    if (!msg.from) continue;
    const already = await markSeen(msg.id);
    if (already) continue;
    const session = await loadSession(msg.from);
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
    } finally {
      try {
        await saveSession(msg.from, session);
      } catch (e) {
        console.error("saveSession outer error:", e);
      }
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
