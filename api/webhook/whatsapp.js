/**
 * Webhook serverless para Vercel ÔÇö WhatsApp Cloud API (Meta).
 *
 * Variables Vercel:
 *   WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   OPENAI_API_KEY, OPENAI_MODEL (opcional)
 *   OPENAI_ASSISTANT_DELAY_MS ÔÇö retraso global por mensaje en ms (default 5000)
 *
 * Meta debe recibir respuesta HTTP 200 r├ípido. El trabajo pesado va en waitUntil().
 * Plan Hobby (~10 s l├¡mite): no uses retrasos largos (10 s + OpenAI suele hacer timeout).
 * Para 10000/5000 ms usa Vercel Pro + maxDuration alto y define las variables de entorno.
 */

const { waitUntil } = require("@vercel/functions");

const GRAPH_VERSION = "v21.0";
const WHATSAPP_TEXT_MAX = 4000;
const MAX_HISTORY_TURNS = 12;

const COMPANY_WEB_URL = "https://comercialbautista.net/";
const COMPANY_FB_URL = "https://www.facebook.com/profile.php?id=61588330106602";

/** Memoria ef├¡mera por instancia serverless (reinicios = se trata de nuevo como ÔÇ£primer mensajeÔÇØ). */
const seenWaId = new Map();
const conversationByWaId = new Map();
const processedMessageIds = new Map();
const confirmationStateByWaId = new Map();
const imageStateByWaId = new Map();
const mediaByWaId = new Map();
/** IDs de imagen ya analizados con visi├│n (m├íx. 2 im├ígenes por chat en flujo normal). */
const visionAnalyzedMediaByWaId = new Map();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SYSTEM_PROMPT = `Identidad y empresa
Te llamas Gladis y eres la asistente comercial de METALTEC - COMERCIAL BAUTISTA, empresa peruana dedicada a carpinter├¡a met├ílica, herrer├¡a y fabricaci├│n industrial a medida (puertas, ventanas, estructuras, barandas, mobiliario met├ílico, trabajos en taller y en obra seg├║n el caso). Representas al negocio con profesionalismo y cercan├¡a.

Estilo de conversaci├│n (obligatorio)
- Cuando el cliente entra con un saludo breve, respond├® con un solo bloque de saludo cordial y natural. Vari├í la forma de saludar entre mensajes y conversaciones (por ejemplo Hola, Buenas, Buenos d├¡as, Buenas tardes o Buenas noches seg├║n el tono; no uses siempre la misma f├│rmula mec├ínica). En esa primera respuesta presentate una sola vez como Gladis, asistente comercial de METALTEC - COMERCIAL BAUTISTA, y pas├í enseguida a avanzar la cotizaci├│n.
- En un mismo mensaje no repitas dos veces el saludo ni dos aperturas equivalentes (mal ejemplo: decir Hola, buenos d├¡as y luego otra vez Hola, buenos d├¡as, o duplicar frases como con gusto te ayudo). Le├® tu propio texto antes de cerrar: si suena redundante, dej├í una sola apertura y el resto directo al punto.
- Tono natural, simple, muy amigable y que genere confianza; que el cliente se sienta escuchado. Nada r├¡gido ni de men├║ tipo "elige 1, 2 o 3".
- Usa emojis solo en 2 momentos: saludo inicial y cierre final de la conversaci├│n. En los dem├ís mensajes no uses emojis.
- La primera palabra de cada mensaje debe tener solo la primera letra en may├║scula (ejemplo: Hola, Genial, Perfecto), no toda la palabra en may├║sculas.
- No uses comillas (") ni ('), ni guiones largos de di├ílogo; escribe directo.
- Signos de cierre: usa solo ? y ! al final de frases. No uses ┬┐ ni ┬í (ni otros signos de apertura en espa├▒ol).
- Mensajes cortos, pensados para WhatsApp: pocos p├írrafos, claros.
- Haz m├íximo una pregunta concreta por mensaje. Si falta m├ís de un dato, pide solo el siguiente dato l├│gico.
- Antes de enviar una pregunta, revisa mentalmente si el cliente ya respondi├│ ese dato con otras palabras, errores de tipeo o antes de que se lo pidieras.
- No uses frases condescendientes o cumplidos al cliente (por ejemplo: excelente elecci├│n, suena bien, gran decisi├│n).
- Para validar avance usa solo aperturas neutras: Genial, Muy bien, Perfecto o Claro.
- Nunca reinicies la conversaci├│n con saludo de inicio en mitad del flujo.
- Si el cliente se niega a compartir alg├║n dato (por ejemplo direcci├│n), responde con empat├¡a y ofrece seguir con cotizaci├│n referencial sin perder el contexto ya recolectado.
- Si el cliente pide informaci├│n general sobre trabajos que realizamos, cat├ílogo, modelos, dise├▒os, fotos o referencias visuales, comparte siempre estos enlaces en texto plano: ${COMPANY_WEB_URL} y ${COMPANY_FB_URL}. No digas que no puedes compartir im├ígenes sin ofrecer antes esos enlaces.

L├¡mites comerciales
- No inventes precios, montos ni plazos de entrega cerrados.
- No prometas visitas ni instalaciones sin tener datos suficientes; cuando falte informaci├│n, p├¡dela con amabilidad.
- Si el pedido es muy especializado o hay dudas serias, ofrece que un asesor humano revise el caso sin alarmar al cliente.

Objetivo de la conversaci├│n
Conduc├¡s la charla como comercial: primero saludar y generar confianza, luego ir completando datos para una cotizaci├│n formal.

Informaci├│n que debes obtener (en orden l├│gico, sin sonar a formulario fr├¡o)
1) Tipo de trabajo o producto que desea (qu├® necesita fabricar o instalar).
2) Si el trabajo es de ├ímbito dom├®stico / hogar o industrial / empresa (si no queda claro, pregunta con naturalidad).
3) Caracter├¡sticas del trabajo (prioridad): medidas aproximadas, material y acabado, y si env├¡a foto o plano describ├¡ lo que se ve y ped├¡ confirmaci├│n. Cantidad de unidades cuando corresponda. No avances a RUC, nombre ni direcci├│n hasta tener claro producto, ├ímbito y detalle t├®cnico o referencia visual analizada.
4) Identificaci├│n: RUC de la empresa si es cliente corporativo; si no tiene RUC, nombre completo de la persona.
5) Direcci├│n exacta del lugar de trabajo o de entrega/relevamiento, m├ís una referencia de c├│mo llegar (cerca de qu├® lugar conocido, color de fachada, etc.) para poder cotizar y coordinar.

Cierre cuando ya tengas lo necesario
Cuando tengas los datos suficientes para iniciar una cotizaci├│n formal, explica con cordialidad que con esa informaci├│n el equipo preparar├í la cotizaci├│n a la brevedad posible, y que si necesitan alg├║n detalle adicional te volver├ís a comunicar con ├®l para afinar sin complicarlo.
Antes de cerrar, muestra un resumen claro de especificaciones del trabajo y pide al cliente que confirme escribiendo exactamente CONFIRMO en may├║sculas.

Si el cliente solo saluda o da poca informaci├│n, gui├í con una o dos preguntas abiertas y c├ílidas para avanzar.
Regla anti-repetici├│n: si el cliente ya dio un dato en cualquier mensaje anterior (aunque sea antes de que lo pidieras), no vuelvas a preguntarlo; segu├¡ con el siguiente dato faltante.`;

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

function getInboundMedia(waId) {
  const list = mediaByWaId.get(waId);
  return Array.isArray(list) ? list : [];
}

function appendInboundMedia(waId, media) {
  if (!media?.id || !media?.type) return;
  const list = getInboundMedia(waId);
  const duplicated = list.some((m) => m.id === media.id);
  if (duplicated) return;
  list.push(media);
  if (list.length > 12) {
    list.splice(0, list.length - 12);
  }
  mediaByWaId.set(waId, list);
}

function normalizeAssistantReply(text) {
  if (!text) return text;
  let out = text.trim();
  out = out.replace(/[┬┐┬í]/g, "");
  out = out.replace(/["']/g, "");
  out = out.replace(/\s+\n/g, "\n");
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
  out = out.replace(/\s{2,}/g, " ").trim();

  // Fuerza primera palabra con formato "SoloInicialMayuscula" (no TODO EN MAYUSCULAS).
  out = out.replace(
    /^\s*([A-Za-z├ü├ë├ì├ô├Ü├æ├í├®├¡├│├║├▒]+)\b/u,
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
  return /\b(gracias|ok|oki|listo|perfecto|est├í bien|esta bien|de acuerdo|chau|adi├│s|adios)\b/i.test(
    text || ""
  );
}

function isInitialGreeting(text) {
  const clean = (text || "").trim().toLowerCase();
  if (!clean) return false;
  return /^(hola|buenas|buenos d[i├¡]as|buenas tardes|buenas noches)(\b|[,.!\s])/.test(clean);
}

function isPrivacyRefusal(text) {
  return /\b(privad[oa]|no (quiero|deseo|puedo)|primero (la )?cotizaci[o├│]n|luego coordinamos|no compartir|no dar)\b/i.test(
    text || ""
  );
}

function isImageStubbornRequest(text) {
  return /\b(igual|similar|tal cual|exactamente igual|como la imagen|como en la imagen|solo eso|nada m[a├í]s|sin detalles|no dar detalles)\b/i.test(
    text || ""
  );
}

function isRequestingServicesCatalogOrVisualRefs(text) {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return false;
  const asksVisual =
    /\b(qu[e├®] (?:hacen|trabajos|servicios)|tipos? de trabajos?|informaci[o├│]n (?:sobre )?(?:los )?trabajos?|cat[a├í]logo|galer[i├¡]a|fotos?|im[a├í]genes?|referencias? visuales?|dise├▒os?|modelos?|ejemplos?|muestras?|ver (?:trabajos|modelos|fotos|dise├▒os))\b/i.test(
      t
    );
  const asksLinks =
    /\b(p[a├í]gina|web|sitio|facebook|fb|redes?)\b/i.test(t) &&
    /\b(ver|mostrar|pasar|compart|enlace|link|url)\b/i.test(t);
  return asksVisual || asksLinks;
}

function companyInfoAndVisualRefsReply() {
  return (
    `Claro. Para ver trabajos y referencias visuales pod├®s revisar nuestra web ${COMPANY_WEB_URL} y el perfil de Facebook ${COMPANY_FB_URL}. ` +
    `Ah├¡ encontrar├ís referencias de nuestros trabajos para que puedas comparar modelos`
  );
}

function isAlreadyProvidedPushback(text) {
  return /\b(ya (?:te )?lo (?:mencion\w*|dije|indiqu\w*|ense├▒\w*)|te lo (?:acabo de |ya )?mencion\w*|repet[i├¡]s|me preguntas lo mismo|no me (?:entiendes|escuchas))\b/i.test(
    text || ""
  );
}

function isConfirmMessage(text) {
  return /\bCONFIRMO\b/.test(text || "");
}

function getLastUserText(waId) {
  const history = getConversationHistory(waId);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "user") return history[i].content || "";
  }
  return "";
}

function getPreviousAssistantTextForLatestUser(waId) {
  const history = getConversationHistory(waId);
  const latestUserIndex = history.map((m) => m.role).lastIndexOf("user");
  if (latestUserIndex <= 0) return "";
  for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") return history[i].content || "";
  }
  return "";
}

function getPendingFieldsForLatestUser(waId) {
  return getAskedFieldsFromReply(getPreviousAssistantTextForLatestUser(waId));
}

function isQuestionLike(text) {
  return /[?]|^(por qu[e├®]|cu[a├í]nto|cu[a├í]ndo|d[o├│]nde|c[o├│]mo|qu[e├®]\b)/i.test((text || "").trim());
}

function looksLikeDirectNameOrIdAnswer(text) {
  const clean = (text || "").trim();
  if (!clean || isQuestionLike(clean)) return false;
  if (/\b\d{8,11}\b/.test(clean)) return true;
  if (!/^[a-z├í├®├¡├│├║├▒├╝\s.]+$/i.test(clean)) return false;
  const words = clean
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  return !/\b(hogar|dom[e├®]stico|empresa|industrial|pieza|unidad|puerta|mesa|modelo|medida|metro)\b/i.test(clean);
}

function looksLikeDirectAddressAnswer(text) {
  const clean = (text || "").trim();
  if (!clean || isQuestionLike(clean)) return false;
  return (
    /\b(avenida|av\.|jr\.|jir[o├│]n|calle|pasaje|mz\.?|manzana|lote|sector|urbanizaci[o├│]n|referencia|cerca de|frente a|costado|altura)\b/i.test(
      clean
    ) ||
    (/\d/.test(clean) && clean.length >= 8)
  );
}

function looksLikeDirectTechAnswer(text) {
  const clean = (text || "").trim();
  if (!clean || isQuestionLike(clean)) return false;
  return (
    /(imagen referencial|modelo|medida|metro|metros|madera|metal|met[a├í]lic|acero|fierro|acabado|pintura|color|panel|marco|alto|ancho|largo|foto|plano)/i.test(
      clean
    ) ||
    /\b\d+(?:[.,]\d+)?\s*(?:m|mt|mts|metro|metros|cm|cent[i├¡]metros?)\b/i.test(clean)
  );
}

function looksLikeDirectScopeAnswer(text) {
  const clean = (text || "").trim();
  if (!clean || isQuestionLike(clean)) return false;
  return /\b(hogar|casa|dom[e├®]stic|empresa|industrial|colegio|escuela|instituci[o├│]n|negocio|local|oficina|planta|f[a├í]brica|obra|taller)\b/i.test(
    clean
  );
}

function markVisionAnalyzed(waId, mediaId) {
  if (!waId || !mediaId) return;
  let set = visionAnalyzedMediaByWaId.get(waId);
  if (!set) {
    set = new Set();
    visionAnalyzedMediaByWaId.set(waId, set);
  }
  set.add(mediaId);
}

function allInboundImagesAnalyzed(waId) {
  const imgs = getInboundMedia(waId).filter((m) => m.type === "image");
  if (!imgs.length) return true;
  const set = visionAnalyzedMediaByWaId.get(waId);
  if (!set || !set.size) return false;
  return imgs.every((m) => set.has(m.id));
}

/** Detalle t├®cnico real en texto (no basta con decir modelo sin medidas ni material). */
function hasExplicitTechnicalDetail(blobLower) {
  const b = blobLower || "";
  return (
    /(metro|metros|medida|alto|altura|ancho|largo|profundidad|material|acabado|pintura|color|m2|m┬▓|panel|paneles|marco|madera|melamina|calibre|espesor|foto|plano|vidrio|cristal|vidriado|bisagra|chapa|cerradura)/i.test(
      b
    ) ||
    /\b\d+(?:[.,]\d+)?\s*(?:m|mt|mts|metro|metros|cm|cent[i├¡]metros?)\b/i.test(b)
  );
}

/** Medidas aproximadas en texto del cliente (obligatorias adem├ís de la referencia visual analizada). */
function hasApproximateMeasuresInBlob(blobLower) {
  const b = blobLower || "";
  return (
    /\b\d+(?:[.,]\d+)?\s*(?:m|mt|mts|metro|metros|cm|cent[i├¡]metros?)\b/i.test(b) ||
    /\b(alto|ancho|largo|altura|frente)\b.{0,22}\d/i.test(b) ||
    /\d+(?:[.,]\d+)?\s*(?:m|mt|metros?)\b.{0,35}\b(alto|ancho|largo)/i.test(b)
  );
}

function hasTechSatisfied(waId) {
  const blob = getFlattenedUserText(waId).toLowerCase();
  const pendingFields = getPendingFieldsForLatestUser(waId);
  const lastUserText = getLastUserText(waId);
  const directTech =
    pendingFields.includes("detalle t├®cnico (medidas, material, acabado o referencia)") &&
    looksLikeDirectTechAnswer(lastUserText);
  const explicit = hasExplicitTechnicalDetail(blob) || directTech;
  const measuresOk = hasApproximateMeasuresInBlob(blob);
  const imgs = getInboundMedia(waId).filter((m) => m.type === "image");
  if (!imgs.length) return explicit;
  const allDone = allInboundImagesAnalyzed(waId);
  if (!allDone) {
    // Si la visi├│n fall├│ o a├║n no corri├│, permitir avanzar si el cliente ya dej├│ medidas/material en texto.
    return explicit;
  }
  // Referencia ya analizada: el acabado/modelo queda en la descripci├│n de Gladis; igual necesitamos medidas del cliente en texto.
  return measuresOk;
}

function getClientDataSignals(waId) {
  const blob = getFlattenedUserText(waId).toLowerCase();
  const lastUserText = getLastUserText(waId);
  const pendingFields = getPendingFieldsForLatestUser(waId);
  const directlyAnsweredProduct =
    pendingFields.includes("tipo de trabajo/producto") &&
    !isQuestionLike(lastUserText) &&
    /\b(quiero|necesito|cotizar|fabricar|instalar|hacer|elaborar|puert|purt|mesa|silla|reja|baranda|techo|cerco|mueble)\b/i.test(
      lastUserText
    );

  const hasProduct =
    /(techo|reja|baranda|port[o├│]n|puert|purt|ventana|estructura|mueble|muebler[i├¡]a|mesa|silla|afiche|gr[├║u]a|trabajo|producto|cerco|cercado|escalera|pasamanos|protector|mampara)/i.test(
      blob
    ) ||
    /\b(fabricar|instalar|elaborar|hacer|cotizar|cotizaci[o├│]n)\b.{0,45}\b(met[a├í]lic|metal|madera|acero|fierro)\b/i.test(
      blob
    ) ||
    directlyAnsweredProduct;
  const hasTech = hasTechSatisfied(waId);
  const hasScope =
    /(hogar|casa|dom[e├®]stic|industrial|empresa|corporativo|institucional)/i.test(blob) ||
    /\b(colegio|escuela|instituci[o├│]n|negocio|local|oficina|planta|f[a├í]brica|obra|taller)\b/i.test(blob) ||
    (pendingFields.includes("├ímbito (hogar/dom├®stico o empresa/industrial)") &&
      looksLikeDirectScopeAnswer(lastUserText));
  const hasId =
    /(ruc|mi nombre es|me llamo|nombre completo|soy [a-z├í├®├¡├│├║├▒]|a nombre de|raz[o├│]n social|dni)/i.test(blob) ||
    (pendingFields.includes("identificaci├│n (RUC o nombre completo)") && looksLikeDirectNameOrIdAnswer(lastUserText));
  const hasAddress =
    /(direcci[o├│]n|ubicaci[o├│]n|avenida|av\.|jr\.|calle|sector|referencia|cerca de|lugar)/i.test(blob) ||
    (pendingFields.includes("direcci├│n y referencia") && looksLikeDirectAddressAnswer(lastUserText));
  return { blob, hasProduct, hasTech, hasScope, hasId, hasAddress };
}

function getRequiredFollowupQuestion(waId) {
  const { hasProduct, hasTech, hasScope, hasId, hasAddress } = getClientDataSignals(waId);
  const hasQty = hasLogicalQuantity(waId);

  // Si ya tenemos base t├®cnica/comercial, fuerza pedir identificaci├│n antes del cierre.
  if (hasProduct && hasScope && hasTech && hasQty && !hasId) {
    return "Muy bien, para continuar con la cotizaci├│n formal, compartime por favor tu RUC. Si no tienes RUC, ind├¡came tu nombre completo";
  }

  // Luego fuerza ubicaci├│n para completar datos de cotizaci├│n.
  if (hasProduct && hasScope && hasTech && hasQty && hasId && !hasAddress) {
    return "Perfecto, ahora ind├¡came por favor la direcci├│n exacta del trabajo y una referencia para ubicar el lugar";
  }

  return null;
}

function getPromptForMissingField(field) {
  if (field === "tipo de trabajo/producto") {
    return "Muy bien, para continuar, qu├® tipo de trabajo o producto necesitas fabricar o instalar?";
  }
  if (field === "├ímbito (hogar/dom├®stico o empresa/industrial)") {
    return "Perfecto, para avanzar, confirmame por favor si es para hogar/dom├®stico o para empresa/industrial";
  }
  if (field === "detalle t├®cnico (medidas, material, acabado o referencia)") {
    return "Muy bien, ahora compartime por favor medidas aproximadas, material y acabado. Si tienes imagen referencial, tambi├®n puedes enviarla";
  }
  if (field === "cantidad") {
    return "Perfecto, para completar la cotizaci├│n, ind├¡came la cantidad exacta que necesitas";
  }
  if (field === "identificaci├│n (RUC o nombre completo)") {
    return "Muy bien, para continuar con la cotizaci├│n formal, compartime por favor tu RUC. Si no tienes RUC, ind├¡came tu nombre completo";
  }
  if (field === "direcci├│n y referencia") {
    return "Perfecto, ahora ind├¡came por favor la direcci├│n exacta del trabajo y una referencia para ubicar el lugar";
  }
  return null;
}

function getAskedFieldsFromReply(reply) {
  const text = (reply || "").toLowerCase();
  if (!text) return [];
  const fields = [];
  if (/(hogar|dom[e├®]stic|empresa|industrial|[├ía]mbito)/i.test(text)) {
    fields.push("├ímbito (hogar/dom├®stico o empresa/industrial)");
  }
  if (/(tipo de trabajo|producto necesitas|fabricar o instalar)/i.test(text)) {
    fields.push("tipo de trabajo/producto");
  }
  if (/(medidas|material|acabado|pintura|referencia visual|imagen referencial)/i.test(text)) {
    fields.push("detalle t├®cnico (medidas, material, acabado o referencia)");
  }
  if (/(cu[a├í]nt|cantidad|unidades|piezas|pa├▒os|tramos|[├ía]reas)/i.test(text)) {
    fields.push("cantidad");
  }
  if (/(ruc|nombre completo|identificaci[o├│]n)/i.test(text)) {
    fields.push("identificaci├│n (RUC o nombre completo)");
  }
  if (/(direcci[o├│]n|ubicaci[o├│]n|referencia|cerca de)/i.test(text)) {
    fields.push("direcci├│n y referencia");
  }
  return fields;
}

function enforceNoRepeatedQuestion(waId, reply) {
  const askedFields = getAskedFieldsFromReply(reply);
  if (!askedFields.length) return reply;

  const missingGuide = getNextMissingDataPrompt(waId);
  if (missingGuide.next === "ninguno") return reply;

  const asksOnlyNextField = askedFields.length === 1 && askedFields[0] === missingGuide.next;
  if (asksOnlyNextField) return reply;

  const replacement = getPromptForMissingField(missingGuide.next);
  if (replacement) return replacement;
  return "Perfecto, continuemos con el siguiente detalle para tu cotizaci├│n";
}

function addNaturalNextStepIfUseful(waId, reply) {
  const guide = getNextMissingDataPrompt(waId);
  if (guide.next === "ninguno") return reply;

  const nextQ = getPromptForMissingField(guide.next);
  if (!nextQ) return reply;

  const asked = getAskedFieldsFromReply(reply);
  const alreadyAsksNext = asked.includes(guide.next);
  if (alreadyAsksNext) return reply;

  // Evita pegar dos veces la misma pregunta (ej. RUC) si el modelo ya la incluy├│ con otras palabras.
  const nextSlug = nextQ.slice(0, 48).toLowerCase();
  if (nextSlug && (reply || "").toLowerCase().includes(nextSlug)) return reply;

  return `${reply}\n\nPara continuar con tu cotizaci├│n: ${nextQ}`;
}

/** Quita preguntas de ├ímbito si el cliente ya respondi├│ hogar/empresa. */
function stripRedundantScopeQuestion(waId, reply) {
  const { hasScope } = getClientDataSignals(waId);
  if (!hasScope || !reply) return reply;
  let out = reply;
  out = out.replace(/\s*Para avanzar,?\s+[^.?!]*\b(hogar|empresa|dom[e├®]stic[oa]?|industrial)\b[^.?!]*\?/gi, "");
  out = out.replace(/\s*[^.?!]*confirm(ar|ame)?\s+si\s+[^.?!]*\b(hogar|empresa)\b[^.?!]*\?/gi, "");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

function getAssistantImageDescriptionExcerpts(waId) {
  const history = getConversationHistory(waId);
  const parts = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    const c = m.content || "";
    if (!/coincide con lo que necesitas/i.test(c)) continue;
    const core = c.replace(/\n+Si esta descripci├│n coincide con lo que necesitas[\s\S]*$/i, "").trim();
    if (core) parts.push(core);
  }
  return parts.join("\n---\n");
}

function getSpecsSummaryContext(waId) {
  const userPart = getFlattenedUserText(waId);
  const visionPart = getAssistantImageDescriptionExcerpts(waId);
  if (!visionPart) return userPart;
  return (
    `${userPart}\n\n` +
    `Descripci├│n t├®cnica que Gladis registr├│ a partir de fotos del cliente (usala en tipo visual, material y acabado si el cliente no lo repiti├│ en texto):\n` +
    `${visionPart}`
  );
}

function getLeadForwardTo(from) {
  const envTarget = (process.env.LEAD_FORWARD_TO || "").replace(/\D/g, "");
  if (envTarget) return envTarget;
  return (from || "").replace(/\D/g, "");
}

function inferWorkTitle(waId) {
  const blob = getFlattenedUserText(waId).toLowerCase();
  if (/(techo|techado|techar)/i.test(blob)) return "COTIZACION DE TECHADO";
  if (/(cerco|cercado|cercar)/i.test(blob)) return "COTIZACION DE CERCO";
  if (/(reja|baranda|port[o├│]n|puerta|ventana)/i.test(blob)) return "COTIZACION DE HERRERIA";
  if (/(mueble|muebler[i├¡]a|silla|mesa)/i.test(blob)) return "COTIZACION DE MOBILIARIO METALICO";
  return "NUEVA SOLICITUD DE COTIZACION";
}

function normalizePhoneForDisplay(raw) {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "No disponible";
  return `+${digits}`;
}

async function generateLeadForwardText(waId, clientWaId) {
  const summary = (await generateSpecsSummary(waId)) || "Resumen no disponible";
  const title = inferWorkTitle(waId);
  return [
    title,
    "",
    `Cliente: ${normalizePhoneForDisplay(clientWaId)}`,
    "",
    "DATOS RECOPILADOS:",
    summary,
  ].join("\n");
}

async function sendMediaById(to, mediaType, mediaId, caption) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const access = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !access || !to || !mediaType || !mediaId) return;

  const normalizedType = mediaType === "document" ? "document" : "image";
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: normalizedType,
    [normalizedType]: {
      id: mediaId,
    },
  };
  if (caption && normalizedType === "image") {
    payload.image.caption = caption.slice(0, 900);
  }
  if (caption && normalizedType === "document") {
    payload.document.caption = caption.slice(0, 900);
  }

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
    console.error("Graph API media error", r.status, raw);
  }
}

async function forwardLeadPackage(waId, clientWaId) {
  const to = getLeadForwardTo(clientWaId);
  if (!to) return;

  const leadText = await generateLeadForwardText(waId, clientWaId);
  await sendTextReply(to, leadText);

  const attachments = getInboundMedia(waId);
  for (const media of attachments) {
    if (!media?.id || !media?.type) continue;
    await sendMediaById(to, media.type, media.id, media.caption || "Adjunto enviado por el cliente");
  }
}

function getNextMissingDataPrompt(waId) {
  const { hasProduct, hasTech, hasScope, hasId, hasAddress } = getClientDataSignals(waId);
  const hasQty = hasLogicalQuantity(waId);
  const missing = [];
  if (!hasProduct) missing.push("tipo de trabajo/producto");
  if (!hasScope) missing.push("├ímbito (hogar/dom├®stico o empresa/industrial)");
  if (!hasTech) missing.push("detalle t├®cnico (medidas, material, acabado o referencia)");
  if (!hasQty) missing.push("cantidad");
  if (!hasId) missing.push("identificaci├│n (RUC o nombre completo)");
  if (!hasAddress) missing.push("direcci├│n y referencia");

  const next = missing[0] || "ninguno";
  return { missing, next };
}

function hasLogicalQuantity(waId) {
  const { blob } = getClientDataSignals(waId);
  const lastUserText = getLastUserText(waId);
  const pendingFields = getPendingFieldsForLatestUser(waId);
  const isAreaWork = /(techo|techado|techar|cerco|cercado|cercar)/i.test(blob);
  const numberWord = "(?:un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|cien|ciento|doscientos|trescientos)";

  // Detecta cantidades num├®ricas expl├¡citas desde el inicio:
  // ej: "100 sillas", "50 mesas", "2 portones", "3 pa├▒os", "215 purtas" (typo), "x2", "2x".
  const hasNumericUnits =
    /\b\d+\s*(unidad(?:es)?|pieza(?:s)?|pa├▒o(?:s)?|hoja(?:s)?|juego(?:s)?|silla(?:s)?|mesa(?:s)?|port[o├│]n(?:es)?|puerta(?:s)?|purtas?|ventana(?:s)?|reja(?:s)?|baranda(?:s)?|mueble(?:s)?|afiche(?:s)?)\b/i.test(
      blob
    ) ||
    /\b(x\s*\d+|\d+\s*x)\b/i.test(blob);

  // N├║mero + producto cercano (errores de tipeo, orden libre): "215 purtas de 1.9 m", "cotizar 215 puertas".
  const hasNumericNearProduct =
    /\b\d{1,5}\b\s*\D{0,45}\b(?:puert|purt|port[o├│]|ventan|mesas?|sillas?|rejas?|barandas?|unidades?|piezas?|muebles?|paneles?|hojas?|juegos?)\w*\b/i.test(
      blob
    ) ||
    /\bcotiz\w*\s+\d{1,5}\b/i.test(blob) ||
    new RegExp(`\\b${numberWord}\\s+(?:puert|purt|port[o├│]|ventan|mesas?|sillas?|rejas?|barandas?|unidades?|piezas?|muebles?)\\w*\\b`, "i").test(
      blob
    );

  const hasNumericUnitsOrNear = hasNumericUnits || hasNumericNearProduct;
  const directQtyAnswer =
    pendingFields.includes("cantidad") &&
    !isQuestionLike(lastUserText) &&
    (/\b\d{1,5}\b/.test(lastUserText) ||
      new RegExp(`\\b${numberWord}\\b`, "i").test(lastUserText) ||
      /\b(una?|dos|tres|pieza|piezas|unidad|unidades|pa├▒o|pa├▒os|hoja|hojas|juego|juegos)\b/i.test(lastUserText));

  if (isAreaWork) {
    return (
      /(├írea|area|m2|m┬▓|metros cuadrados|sector|sectores|tramo|tramos|frente|per├¡metro|perimetro)/i.test(
        blob
      ) ||
      hasNumericUnitsOrNear ||
      directQtyAnswer
    );
  }
  return (
    /(unidad|unidades|cantidad|pieza|piezas|pa├▒o|pa├▒os|hoja|hojas|juego|juegos)/i.test(blob) ||
    hasNumericUnitsOrNear ||
    directQtyAnswer
  );
}

function getLogicalQuantityQuestion(waId) {
  const { blob, hasProduct, hasTech } = getClientDataSignals(waId);
  if (!hasProduct || !hasTech || hasLogicalQuantity(waId)) return null;
  if (/(techo|techado|techar)/i.test(blob)) {
    return "Muy bien, para completar la cotizaci├│n, cu├íntas ├íreas techadas necesitas que fabriquemos o instalemos?";
  }
  if (/(cerco|cercado|cercar)/i.test(blob)) {
    return "Muy bien, para completar la cotizaci├│n, cu├íntas ├íreas cercadas o tramos de cerco necesitas?";
  }
  return "Muy bien, para completar la cotizaci├│n, qu├® cantidad necesitas exactamente (unidades, piezas o pa├▒os seg├║n el trabajo)?";
}

function hasEnoughInfoForSpecConfirmation(waId) {
  const { hasProduct, hasTech, hasScope, hasId, hasAddress } = getClientDataSignals(waId);
  const hasQty = hasLogicalQuantity(waId);
  return hasProduct && hasTech && hasScope && hasId && hasAddress && hasQty;
}

function decorateReply(reply, { isFirst, shouldClose }) {
  const clean = normalizeAssistantReply(reply);
  if (isFirst || shouldClose) return `${clean} ­ƒÖé`.slice(0, WHATSAPP_TEXT_MAX);
  return clean;
}

function collapseRedundantGreetings(text) {
  if (!text) return text;
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/\b(Hola,?\s+buenos d[i├¡]as\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Hola,?\s+buenas tardes\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Hola,?\s+buenas noches\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Buenas,?\s+buenos d[i├¡]as\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Buenas tardes\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Buenas noches\.?)\s+\1\s+/gi, "$1 ");
  t = t.replace(/\b(Hola\.?)\s+(Hola\.?)\s+/gi, "$1 ");
  t = t.replace(/\b(Buenas\.?)\s+(Buenas\.?)\s+/gi, "$1 ");
  t = t.replace(
    /^(.{0,55}(?:hola|buenas|buenos d[i├¡]as|buenas tardes|buenas noches)[^.?!]*[.?!])\s+\1\b/iu,
    "$1 "
  );
  return t.trim();
}

function stripPresentation(text) {
  if (!text) return text;
  return text
    .replace(
      /(^|[\n.\s])(?:hola|buenas|buenos d[i├¡]as|buenas tardes|buenas noches)[^.\n]{0,140}?(?:soy|me llamo)\s+gladis[^.\n]*[.\n]*/gi,
      "$1"
    )
    .replace(/(^|[\n.\s])(?:soy|me llamo)\s+gladis[^.\n]*[.\n]*/gi, "$1")
    .replace(
      /(^|[\n.\s])asistente comercial de (?:metaltec\s*-\s*)?comercial bautista[^.\n]*[.\n]*/gi,
      "$1"
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function enforceSingleIntroPolicy(waId, reply, { allowIntro = false } = {}) {
  const history = getConversationHistory(waId);
  const assistantTurns = history.filter((m) => m.role === "assistant").length;

  if (assistantTurns === 0 && allowIntro) {
    let out = (reply || "").trim();
    out = collapseRedundantGreetings(out);
    if (!out) {
      return "Buenas, soy Gladis de METALTEC - COMERCIAL BAUTISTA. Qu├® tipo de trabajo o producto necesit├ís fabricar o instalar?";
    }
    const hasGladis = /\bgladis\b/i.test(out);
    const hasBrand = /\bmetaltec\b/i.test(out);
    if (!hasGladis || !hasBrand) {
      out = `Soy Gladis, asistente comercial de METALTEC - COMERCIAL BAUTISTA. ${out}`;
      out = collapseRedundantGreetings(out);
    }
    return out;
  }

  const sanitized = collapseRedundantGreetings(stripPresentation(reply));
  return sanitized || "Muy bien, continuemos con tu solicitud";
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
          out.push({
            from: msg.from,
            body: msg.text.body,
            id: msg.id,
            type: "text",
            mediaId: null,
            mediaType: null,
            mediaCaption: null,
          });
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
            mediaType: "image",
            mediaCaption: caption || "Imagen referencial del cliente",
          });
          continue;
        }
        if (msg.type === "document" && msg.from) {
          const caption = msg.document?.caption?.trim();
          const filename = msg.document?.filename?.trim() || "archivo";
          const docText = caption
            ? `Documento enviado por el cliente (${filename}). Mensaje del cliente: ${caption}`
            : `Documento enviado por el cliente: ${filename}`;
          out.push({
            from: msg.from,
            body: docText,
            id: msg.id,
            type: "document",
            mediaId: msg.document?.id || null,
            mediaType: "document",
            mediaCaption: caption || `Documento del cliente: ${filename}`,
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
    "Describe solo detalles visibles de la imagen para cotizaci├│n (tipo de producto, material aparente, acabado/color, forma de paneles o vidrios si aplica, complejidad). " +
    "No inventes medidas exactas ni datos no visibles. Si no se ven medidas, dilo y ped├¡ solo medidas aproximadas en texto. " +
    "Si en el contexto del cliente ya dijo si es para hogar o empresa, no vuelvas a preguntar eso; no repitas datos que ya figuren en el contexto. " +
    "Escribe breve, en un solo bloque, y ped├¡ confirmaci├│n del cliente. " +
    `Si el cliente pide m├ís referencias visuales, menciona la web ${COMPANY_WEB_URL} y Facebook ${COMPANY_FB_URL} en texto plano.`;

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
      `${text}\n\nSi esta descripci├│n coincide con lo que necesitas, confirmame y seguimos con la cotizaci├│n`
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
  const missingGuide = getNextMissingDataPrompt(waId);
  const imgCount = getInboundMedia(waId).filter((m) => m.type === "image").length;
  const visionOk = imgCount === 0 || allInboundImagesAnalyzed(waId);
  const behaviorPrompt = isFirst
    ? "Si y solo si el cliente env├¡a un saludo inicial breve (hola/buenas), respond├® con un solo saludo natural (vari├í la f├│rmula), presentate una sola vez como Gladis de METALTEC - COMERCIAL BAUTISTA, sin repetir saludos ni aperturas en el mismo mensaje, y segu├¡ con la cotizaci├│n. Si el cliente ya viene con contexto o est├í respondiendo datos, NO te presentes."
    : "NO te vuelvas a presentar. Ya te presentaste antes. Contin├║a la conversaci├│n sin reiniciar.";

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
        {
          role: "system",
          content:
            "Estado de datos detectado en el historial del cliente. " +
            `Faltantes actuales: ${missingGuide.missing.length ? missingGuide.missing.join(", ") : "ninguno"}. ` +
            `Siguiente ├║nico dato a solicitar (si corresponde): ${missingGuide.next}. ` +
            `Im├ígenes en el chat: ${imgCount}. An├ílisis visual completado para todas: ${visionOk ? "s├¡" : "pendiente"}. ` +
            "Regla estricta: si un dato NO est├í en faltantes, no lo vuelvas a preguntar.",
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
  const convo = getSpecsSummaryContext(waId);

  const prompt = [
    "Resume las especificaciones del trabajo usando el texto del cliente y, si aparece, la descripci├│n t├®cnica que Gladis hizo a partir de fotos.",
    "En material/acabado y referencia visual deb├®s incluir lo descrito en las fotos aunque el cliente no lo haya repetido en sus mensajes, sin inventar nada que no est├® en esas fuentes.",
    "Devuelve 4 a 7 l├¡neas breves, sin inventar datos.",
    "Incluye: tipo de trabajo, medidas, material/acabado, cantidad, tipo hogar/industrial, nombre o RUC y ubicaci├│n/referencia.",
    "Si un campo no existe en ninguna fuente, escribe exactamente Pendiente en ese campo.",
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

  for (const { from, body: msgBody, id, type, mediaId, mediaType, mediaCaption } of texts) {
    try {
      if (markProcessedMessage(id)) continue;

    const isFirst = !seenWaId.has(from);
    seenWaId.set(from, true);
    const allowIntro = isFirst && type === "text" && isInitialGreeting(msgBody);
    if (mediaId && mediaType) {
      appendInboundMedia(from, { id: mediaId, type: mediaType, caption: mediaCaption || "" });
    }

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
          "Perfecto, ya recib├¡ 2 im├ígenes en este chat. Para continuar, trabajemos con esas referencias y el detalle t├®cnico en texto";
        appendConversationTurn(from, "user", msgBody);
        appendConversationTurn(from, "assistant", limitReply);
        await sendTextReply(from, decorateReply(limitReply, { isFirst, shouldClose: false }));
        continue;
      }
      appendConversationTurn(from, "user", msgBody);
      let visionReply = mediaId ? await generateImageDescriptionReply(from, mediaId, msgBody) : null;
      if (visionReply && mediaId) {
        markVisionAnalyzed(from, mediaId);
      } else {
        visionReply =
          "Recib├¡ tu imagen pero no pude analizarla en este momento. Por favor reenviala o describime medidas aproximadas, material y acabado en texto";
      }
      visionReply = stripRedundantScopeQuestion(from, visionReply);
      visionReply = addNaturalNextStepIfUseful(from, visionReply);
      visionReply = enforceSingleIntroPolicy(from, visionReply, { allowIntro });
      visionReply = decorateReply(visionReply, { isFirst, shouldClose: false });
      appendConversationTurn(from, "assistant", visionReply);
      await sendTextReply(from, visionReply);
      continue;
    }

    const confirmState = confirmationStateByWaId.get(from);
    if (confirmState?.awaiting) {
      let confirmReply;
      if (isConfirmMessage(msgBody)) {
        confirmReply =
          "Perfecto, recibimos tu CONFIRMO. Quedan validadas las especificaciones y procederemos con la cotizaci├│n formal a la brevedad";
        confirmationStateByWaId.set(from, { awaiting: false });
        await forwardLeadPackage(from, from);
      } else {
        confirmReply =
          "Para continuar, por favor responde exactamente CONFIRMO en may├║sculas si el resumen de especificaciones es correcto";
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
    let bypassForcedFollowups = false;
    if (isHumanOrAiQuestion(msgBody)) {
      reply = "Soy asistente de METALTEC - COMERCIAL BAUTISTA";
      bypassForcedFollowups = true;
    } else if (isRequestingServicesCatalogOrVisualRefs(msgBody)) {
      reply = companyInfoAndVisualRefsReply();
      bypassForcedFollowups = true;
    } else if (isPrivacyRefusal(msgBody)) {
      reply =
        "Entiendo, no hay problema. Podemos avanzar con una cotizaci├│n referencial sin tu direcci├│n exacta por ahora. Para afinar el estimado, solo confirmame el tipo de trabajo, medidas aproximadas y acabado, y luego coordinamos ubicaci├│n cuando te sea c├│modo";
      bypassForcedFollowups = true;
    } else if (isImageStubbornRequest(msgBody) && imageState.lastMediaId && imageState.count <= 2) {
      const vSeen = visionAnalyzedMediaByWaId.get(from);
      if (vSeen && vSeen.has(imageState.lastMediaId)) {
        reply =
          "Perfecto, seguimos con esa imagen como referencia. Si las medidas o el acabado no est├ín claros, confirmamelo en texto para cerrar el detalle t├®cnico";
        bypassForcedFollowups = true;
      } else {
        reply = await generateImageDescriptionReply(from, imageState.lastMediaId, msgBody);
        if (reply) markVisionAnalyzed(from, imageState.lastMediaId);
        bypassForcedFollowups = true;
      }
    } else {
      reply = await generateAssistantReply(from, msgBody, isFirst);
    }
    if (!reply) {
      reply = "Gracias por escribirnos. Ya vimos tu mensaje y en breve te seguimos por aqu├¡.";
    }

    appendConversationTurn(from, "user", msgBody);

    if (bypassForcedFollowups) {
      reply = stripRedundantScopeQuestion(from, reply);
      reply = addNaturalNextStepIfUseful(from, reply);
      reply = enforceSingleIntroPolicy(from, reply, { allowIntro });
      reply = decorateReply(reply, { isFirst, shouldClose: isClosingCue(msgBody) });
      appendConversationTurn(from, "assistant", reply);
      await sendTextReply(from, reply);
      continue;
    }

    if (isAlreadyProvidedPushback(msgBody)) {
      const guide = getNextMissingDataPrompt(from);
      let recovery = "Disculpa la confusi├│n, tom├® nota de lo que ya enviaste. ";
      const nextQ = guide.next !== "ninguno" ? getPromptForMissingField(guide.next) : null;
      recovery += nextQ || "Seguimos con tu cotizaci├│n con lo que ya registramos";
      recovery = enforceNoRepeatedQuestion(from, recovery);
      recovery = enforceSingleIntroPolicy(from, recovery, { allowIntro: false });
      recovery = decorateReply(recovery, { isFirst, shouldClose: false });
      appendConversationTurn(from, "assistant", recovery);
      await sendTextReply(from, recovery);
      continue;
    }

    // Pregunta l├│gica de cantidad seg├║n el tipo de trabajo antes de cerrar/resumir.
    const qtyQuestion = getLogicalQuantityQuestion(from);
    if (qtyQuestion) {
      const decoratedQty = decorateReply(qtyQuestion, { isFirst, shouldClose: false });
      appendConversationTurn(from, "assistant", decoratedQty);
      await sendTextReply(from, decoratedQty);
      continue;
    }

    // Fuerza preguntas cr├¡ticas faltantes para no omitir nombre/RUC o direcci├│n.
    const requiredFollowup = getRequiredFollowupQuestion(from);
    if (requiredFollowup) {
      const decoratedRequired = decorateReply(requiredFollowup, { isFirst, shouldClose: false });
      appendConversationTurn(from, "assistant", decoratedRequired);
      await sendTextReply(from, decoratedRequired);
      continue;
    }

    // Si ya hay informaci├│n suficiente, primero pedimos confirmaci├│n formal del resumen.
    if (hasEnoughInfoForSpecConfirmation(from)) {
      const summary = await generateSpecsSummary(from);
      if (summary) {
        const askConfirm =
          `Muy bien, para validar tu solicitud te comparto el resumen de especificaciones:\n` +
          `${summary}\n\n` +
          `Si todo est├í correcto, responde exactamente CONFIRMO en may├║sculas`;
        const decoratedSummary = decorateReply(askConfirm, { isFirst, shouldClose: false });
        appendConversationTurn(from, "assistant", decoratedSummary);
        confirmationStateByWaId.set(from, { awaiting: true });
        await sendTextReply(from, decoratedSummary);
        continue;
      }
    }

    reply = enforceNoRepeatedQuestion(from, reply);
    reply = enforceSingleIntroPolicy(from, reply, { allowIntro });
    reply = decorateReply(reply, { isFirst, shouldClose: isClosingCue(msgBody) });
    appendConversationTurn(from, "assistant", reply);
      await sendTextReply(from, reply);
    } catch (e) {
      console.error("Loop message processing error:", e);
      // Fail-safe: evita dejar al cliente sin respuesta ante errores de visi├│n/API.
      try {
        if (from) {
          await sendTextReply(
            from,
            "Disculpa, tuvimos un inconveniente moment├íneo procesando tu mensaje. Si gustas, intenta nuevamente en unos segundos"
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
    const mode = String(req.query["hub.mode"] ?? "").trim();
    const verifyToken = String(req.query["hub.verify_token"] ?? "").trim();
    const challenge = req.query["hub.challenge"];
    const expected = String(verify || "").trim();

    if (!expected) {
      console.error("Falta WHATSAPP_VERIFY_TOKEN en Vercel");
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server misconfigured");
      return;
    }

    if (mode === "subscribe" && verifyToken === expected) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(challenge !== undefined && challenge !== null ? String(challenge) : "");
      return;
    }

    if (mode === "subscribe") {
      console.error(
        "WhatsApp GET verify: hub.verify_token no coincide con WHATSAPP_VERIFY_TOKEN (revisa espacios o que Meta y Vercel usen el mismo valor)"
      );
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
