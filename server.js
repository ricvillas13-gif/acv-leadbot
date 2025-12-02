import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import he from "he"; // escapador HTML seguro

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// 👉 vuelve a activar la carpeta /public:
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";
const LEADS_SHEET_NAME = "Leads";

// ⚠️ Ajusta esta URL AL LOGO QUE YA PROBASTE EN NAVEGADOR
const LOGO_ACV_URL =
  "https://acv-leadbot-1.onrender.com/logo-acv.png";

// === TWILIO AUTH PARA PROXY DE FOTOS Y MENSAJES SALIENTES ===
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ""; // ej. "whatsapp:+14155238886"

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn(
    "⚠️ TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN no están definidos. /media y recordatorios pueden fallar."
  );
}

if (!TWILIO_WHATSAPP_FROM) {
  console.warn(
    "⚠️ TWILIO_WHATSAPP_FROM no está definido. No se podrán enviar recordatorios automáticos."
  );
}

// BASE del proxy de media (ajusta si cambias el dominio en Render)
const BASE_MEDIA_URL = "https://acv-leadbot-1.onrender.com/media?url=";

// === PARÁMETROS DE RECORDATORIOS ===
// Delays en horas desde el último punto de referencia
const REMINDER_DELAYS_HOURS = [6, 48]; // 1er y 2o recordatorio
// Cada cuánto se revisa la hoja para ver a quién recordar (en minutos)
const REMINDER_INTERVAL_MINUTES = 30;

// === GOOGLE AUTH ===
let creds;
try {
  console.log("🔍 Verificando variable GOOGLE_SERVICE_ACCOUNT...");
  creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  console.log("✅ JSON parseado correctamente. Cliente de servicio listo.");
} catch (err) {
  console.error("❌ ERROR al parsear GOOGLE_SERVICE_ACCOUNT:", err);
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// === SESIONES EN MEMORIA ===
const sessionState = {};

// === REGLAS DE NEGOCIO POR TIPO DE GARANTÍA ===
const LEAD_RULES = {
  Auto: {
    minYear: 2015,
    minAmount: 50000,
    maxAmount: 2000000,
  },
  Maquinaria: {
    minYear: 2010,
    minAmount: 100000,
    maxAmount: 5000000,
  },
  Reloj: {
    minYear: 2018,
    minAmount: 50000,
    maxAmount: 1000000,
  },
};

// === UTILS ===
function xmlEscape(str) {
  // Usamos referencias numéricas para evitar problemas con entidades como &oacute;
  return he.encode(str || "", {
    useNamedReferences: false,
    allowUnsafeSymbols: true,
  });
}

function replyXml(res, message, mediaUrl = null) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>';
  xml += `<Body>${xmlEscape(message)}</Body>`;
  if (mediaUrl) {
    xml += `<Media>${xmlEscape(mediaUrl)}</Media>`;
  }
  xml += "</Message></Response>";

  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  res.end(xml);
}

// Horario del CHATBOT (NO humano):
// - Lunes a viernes: de 18:00 a 09:00
// - Sábado y domingo: todo el día
function isWithinBotHours() {
  // 🧪 MODO PRUEBA:
  // Mientras esté en true, el chatbot estará SIEMPRE activo,
  // sin importar el día ni la hora.
  const FORCE_BOT_ON_FOR_TESTING = true; // ← ponlo en false cuando termines de probar

  if (FORCE_BOT_ON_FOR_TESTING) {
    return true;
  }

  // ⬇️ Lógica real de horario del bot

  const now = new Date();

  const options = {
    timeZone: "America/Mexico_City",
    hour12: false,
    weekday: "short", // lun, mar, mié, jue, vie, sáb, dom
    hour: "numeric",
  };

  const parts = new Intl.DateTimeFormat("es-MX", options).formatToParts(now);

  const weekdayPart = parts.find((p) => p.type === "weekday");
  const hourPart = parts.find((p) => p.type === "hour");

  const dayShort = (weekdayPart?.value || "").toLowerCase(); // ej. "lun"
  const hour = parseInt(hourPart?.value || "0", 10); // 0–23

  const isWeekend = ["sáb", "sab", "dom"].includes(dayShort);
  if (isWeekend) {
    // Bot activo todo el sábado y domingo
    return true;
  }

  // Días lunes a viernes: bot activo de 18:00 a 09:00
  // Es decir:
  // - Desde las 18:00 (18–23)
  // - Y desde las 00:00 hasta antes de las 09:00 (0–8)
  const isNightOrEarly = hour >= 18 || hour < 9;

  return isNightOrEarly;
}

async function appendLeadRow(rowValues) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${LEADS_SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED", // permite fórmulas HYPERLINK
      requestBody: { values: [rowValues] },
    });
    console.log("✅ Lead guardado en Sheets:", rowValues[1]);
  } catch (err) {
    console.error("❌ Error guardando Lead en Sheets:", err);
  }
}

function parseMontoToNumber(txt) {
  if (!txt) return NaN;
  const limpio = String(txt)
    .replace(/[^0-9.,]/g, "") // quita $, letras, etc.
    .replace(/,/g, ""); // quita comas de miles
  return Number(limpio);
}

function evaluarLeadViabilidad(garantia, anioStr, montoStr) {
  const reglas = LEAD_RULES[garantia] || null;
  if (!reglas) {
    console.log(
      "ℹ️ Sin reglas específicas para garantía, se marca Viable:",
      garantia
    );
    return {
      resultado: "Viable",
      motivo: "Sin reglas específicas para esta garantía",
    };
  }

  const anio = parseInt(anioStr, 10);
  const monto = parseMontoToNumber(montoStr);

  if (isNaN(anio)) {
    return {
      resultado: "No viable",
      motivo: "Año del bien no válido",
    };
  }

  if (anio < reglas.minYear) {
    return {
      resultado: "No viable",
      motivo: `Año del bien demasiado antiguo (mínimo ${reglas.minYear})`,
    };
  }

  if (isNaN(monto)) {
    return {
      resultado: "No viable",
      motivo: "Monto solicitado no válido",
    };
  }

  if (monto < reglas.minAmount) {
    return {
      resultado: "No viable",
      motivo: `Monto demasiado bajo (mínimo ${reglas.minAmount.toLocaleString(
        "es-MX"
      )})`,
    };
  }

  if (monto > reglas.maxAmount) {
    return {
      resultado: "No viable",
      motivo: `Monto fuera de rango (máximo ${reglas.maxAmount.toLocaleString(
        "es-MX"
      )})`,
    };
  }

  return {
    resultado: "Viable",
    motivo: "Cumple parámetros de año y monto",
  };
}

function buildFotoHyperlink(url, index) {
  if (!url) return "";
  const encoded = encodeURIComponent(url);
  return `=HYPERLINK("${BASE_MEDIA_URL}${encoded}";"Foto ${index}")`;
}

// === ENVÍO DE MENSAJE WHATSAPP (PARA RECORDATORIOS) ===
async function sendWhatsAppMessage(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.warn(
      "⚠️ No se puede enviar WhatsApp: faltan TWILIO_ACCOUNT_SID / AUTH_TOKEN o WHATSAPP_FROM."
    );
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const params = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: to, // ej: "whatsapp:+5217..."
    Body: body,
  });

  const authHeader =
    "Basic " +
    Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("❌ Error al enviar WhatsApp desde Twilio:", resp.status, txt);
  } else {
    console.log("📣 WhatsApp enviado correctamente a", to);
  }
}

// === TAREA PERIÓDICA: RECORDATORIOS A PENDIENTES DE FOTOS ===
async function revisarLeadsPendientesYEnviarRecordatorios() {
  try {
    console.log("⏰ Iniciando revisión de leads pendientes para recordatorio...");

    // Solo enviar recordatorios cuando el bot está activo
    if (!isWithinBotHours()) {
      console.log("⏰ Fuera de horario del chatbot, no se envían recordatorios ahora.");
      return;
    }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
      console.warn(
        "⚠️ Recordatorios deshabilitados: faltan credenciales Twilio o TWILIO_WHATSAPP_FROM."
      );
      return;
    }

    const range = `${LEADS_SHEET_NAME}!A2:S`; // A..S (19 columnas)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = resp.data.values || [];
    if (!rows.length) {
      console.log("ℹ️ No hay filas en Leads para revisar recordatorios.");
      return;
    }

    const now = new Date();
    const nowMs = now.getTime();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const celular = row[0] || "";
      const etapa = row[6] || "";
      const fotosCrudas = row[9] || "";
      const resultado = row[14] || "";
      const recordatoriosStr = row[17] || "0";
      const ultimoRecIso = row[18] || "";

      // Solo leads: Viable, Precalificado – pendiente de fotos, sin fotos
      if (
        etapa !== "Precalificado – pendiente de fotos" ||
        !resultado.toLowerCase().includes("viable")
      ) {
        continue;
      }

      if (fotosCrudas && fotosCrudas.trim() !== "") {
        // Ya tiene fotos, no deberíamos recordar
        continue;
      }

      const recordatoriosEnviados = parseInt(recordatoriosStr, 10) || 0;
      if (recordatoriosEnviados >= REMINDER_DELAYS_HOURS.length) {
        continue; // ya alcanzó el máximo de recordatorios
      }

      if (!ultimoRecIso) {
        console.log(
          `ℹ️ Lead sin 'Último recordatorio ISO' (fila ${
            i + 2
          }), se inicializa ahora.`
        );
        const rowNumber = i + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${LEADS_SHEET_NAME}!S${rowNumber}:S${rowNumber}`, // Columna S = 19
          valueInputOption: "RAW",
          requestBody: { values: [[now.toISOString()]] },
        });
        continue;
      }

      const last = new Date(ultimoRecIso);
      if (isNaN(last.getTime())) {
        console.warn(
          `⚠️ 'Último recordatorio ISO' inválido en fila ${
            i + 2
          }: ${ultimoRecIso}`
        );
        continue;
      }

      const diffHours = (nowMs - last.getTime()) / (1000 * 60 * 60);
      const delayNeeded = REMINDER_DELAYS_HOURS[recordatoriosEnviados];

      if (diffHours < delayNeeded) {
        continue; // aún no toca recordatorio
      }

      // Toca enviar siguiente recordatorio
      const numeroRec = recordatoriosEnviados + 1;
      const mensajeRec =
        numeroRec === 1
          ? "Hola de nuevo, soy el asistente virtual de ACV. Tu solicitud está preaprobada, pero aún no recibimos las fotos de tu garantía. Cuando puedas, envía al menos 4 fotos para que un asesor pueda revisar tu crédito. 🙌"
          : "Solo para confirmar si aún te interesa tu crédito con ACV. Seguimos pendientes de las fotos de tu garantía. Si ya no te interesa, puedes responder 'No' y cerramos tu solicitud sin problema.";

      console.log(
        `📌 Enviando recordatorio #${numeroRec} a ${celular} (fila ${
          i + 2
        }). diffHours=${diffHours.toFixed(2)}h`
      );

      await sendWhatsAppMessage(celular, mensajeRec);

      // Actualizar contador y timestamp
      const rowNumber = i + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${LEADS_SHEET_NAME}!R${rowNumber}:S${rowNumber}`, // R=18, S=19
        valueInputOption: "RAW",
        requestBody: {
          values: [[String(numeroRec), now.toISOString()]],
        },
      });

      console.log(
        `✅ Recordatorio #${numeroRec} registrado en fila ${rowNumber}.`
      );
    }

    console.log("✅ Revisión de recordatorios finalizada.");
  } catch (err) {
    console.error("❌ Error en revisarLeadsPendientesYEnviarRecordatorios:", err);
  }
}

// === FLUJO PRINCIPAL TWILIO WEBHOOK ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";
  const rawMsg = body.Body || "";
  const msg = rawMsg.trim().toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0", 10);

  console.log("📩 Mensaje recibido:", from, rawMsg);

  if (!sessionState[from]) sessionState[from] = { step: 0, data: {} };
  const state = sessionState[from];

  // 🔒 Control de horario del chatbot
  if (!isWithinBotHours()) {
    return replyXml(
      res,
      "Gracias por escribir a ACV. Nuestro horario de atención humana es de lunes a viernes de 9:00 a 18:00 hrs (CDMX).\n\nEn este momento el asistente automático no está disponible. Intenta de nuevo fuera de ese horario o deja tu mensaje y un asesor te contactará."
    );
  }

  // === COMANDOS GLOBALES BÁSICOS ===
  if (["menu", "inicio", "start"].includes(msg)) {
    state.step = 0;
  }

  // === MANEJO DE MEDIOS (FOTOS) ===
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      const url = body[`MediaUrl${i}`];
      urls.push(url);
    }
    state.data.fotos = (state.data.fotos || []).concat(urls);
    const totalFotos = state.data.fotos.length;

    console.log(
      `📷 Recibidas ${urls.length} nuevas foto(s) de ${from}. Total acumuladas: ${totalFotos}.`
    );

    // Si ya tenemos al menos 4 fotos, registramos fila "Completado"
    if (totalFotos >= 4) {
      if (totalFotos >= 4) {
      const fotosUrls = state.data.fotos.slice(0, 4); // sólo primeras 4
      const fotosCell = fotosUrls.join("\n");

      const foto1 = buildFotoHyperlink(fotosUrls[0], 1);
      const foto2 = buildFotoHyperlink(fotosUrls[1], 2);
      const foto3 = buildFotoHyperlink(fotosUrls[2], 3);
      const foto4 = buildFotoHyperlink(fotosUrls[3], 4);

      const fechaTexto =
        state.data["Fecha contacto"] ||
        new Date().toLocaleString("es-MX", {
          timeZone: "America/Mexico_City",
        });

      const rowCompletado = [
        from, // Celular
        state.data["Cliente"] || "",
        state.data["Garantía"] || "",
        state.data["Año"] || "",
        state.data["Monto solicitado"] || "",
        state.data["Ubicación"] || "",
        "Completado", // Etapa del cliente
        fechaTexto,
        "Bot ACV", // Responsable
        fotosCell, // Fotos (crudo)
        foto1,
        foto2,
        foto3,
        foto4,
        "Viable – completado", // Resultado
        "Solicitud completa con fotos", // Motivo
        "", // Notas (para asesores)
        "", // Recordatorios enviados
        "", // Último recordatorio ISO
      ];

      await appendLeadRow(rowCompletado);
      delete sessionState[from];

      // 🔎 RESUMEN PARA EL PROSPECTO
      const celularLimpio = from.replace("whatsapp:", "");
      const resumen =
        "✅ Gracias, tu solicitud ha sido registrada con tus fotos.\n\n" +
        "📄 *Resumen de tu solicitud:*\n" +
        `• Nombre: ${state.data["Cliente"] || "Sin dato"}\n` +
        `• Celular: ${celularLimpio}\n` +
        `• Garantía: ${state.data["Garantía"] || "Sin dato"}\n` +
        `• Año: ${state.data["Año"] || "Sin dato"}\n` +
        `• Monto: ${state.data["Monto solicitado"] || "Sin dato"}\n` +
        `• Ubicación: ${state.data["Ubicación"] || "Sin dato"}\n\n` +
        "En breve un asesor de ACV se pondrá en contacto contigo. 🙌";

      return replyXml(res, resumen);
    }


    
        res,
        "✅ Gracias, tu solicitud ha sido registrada con tus fotos. En breve un asesor de ACV se pondrá en contacto contigo."
      );
    }

    return replyXml(
      res,
      `📸 Recibidas ${urls.length} foto(s). Llevo registradas ${totalFotos}. Envía al menos 4 fotos en total.`
    );
  }

  // === PASO 0: MENÚ INICIAL / SALUDO ===
  if (state.step === 0 || msg.includes("hola")) {
    state.step = 1;
    const reply =
      "Hola, soy el asistente virtual de ACV.\n" +
      "Gracias por contactarnos.\n\n" +
      "Selecciona una opción:\n" +
      "1️⃣ Iniciar solicitud de crédito\n" +
      "2️⃣ Conocer requisitos e información general\n" +
      "3️⃣ Hablar con un asesor";
    return replyXml(res, reply, LOGO_ACV_URL);
  }

  // === PASO 1: ELECCIÓN DEL FLUJO ===
  if (state.step === 1) {
    if (msg === "1" || msg.includes("solicitud")) {
      state.step = 2;
      return replyXml(res, "Perfecto 🙌\n¿Cuál es tu nombre completo?");
    } else if (msg === "2" || msg.includes("requisito") || msg.includes("información")) {
      const info =
        "📋 Requisitos generales ACV:\n" +
        "• Identificación oficial vigente.\n" +
        "• Comprobante de domicilio.\n" +
        "• Documentos de propiedad de la garantía (tarjeta de circulación, factura, etc.).\n" +
        "• Avalúo físico del bien.\n\n" +
        "💰 Tasa desde 3.99% mensual sin comisión de apertura.\n" +
        "📅 Plazos flexibles desde 3 meses.\n\n" +
        "¿Deseas iniciar tu solicitud? (responde Sí o No)";
      state.step = 1.5;
      return replyXml(res, info);
    } else if (msg === "3" || msg.includes("asesor")) {
      const fechaTexto = new Date().toLocaleString("es-MX", {
        timeZone: "America/Mexico_City",
      });

      const rowAsesor = [
        from, // Celular
        state.data["Cliente"] || "", // si ya teníamos nombre
        state.data["Garantía"] || "",
        state.data["Año"] || "",
        state.data["Monto solicitado"] || "",
        state.data["Ubicación"] || "",
        "Esperando contacto humano", // Etapa del cliente
        fechaTexto,
        "Asesor ACV", // Responsable
        "", // Fotos
        "", // Foto 1
        "", // Foto 2
        "", // Foto 3
        "", // Foto 4
        "Pendiente", // Resultado
        "Cliente pidió hablar con asesor", // Motivo
        "", // Notas
        "", // Recordatorios enviados
        "", // Último recordatorio ISO
      ];
      await appendLeadRow(rowAsesor);
      delete sessionState[from];
      return replyXml(
        res,
        "👌 Te pondremos en contacto con un asesor de ACV. Gracias por escribirnos."
      );
    } else {
      return replyXml(
        res,
        "No entendí tu opción. Por favor responde:\n1 para solicitud de crédito,\n2 para requisitos,\n3 para hablar con un asesor."
      );
    }
  }

  // === PASO 1.5: CONFIRMACIÓN DESPUÉS DE REQUISITOS ===
  if (state.step === 1.5) {
    if (msg.startsWith("s")) {
      state.step = 2;
      return replyXml(res, "Perfecto 🙌\n¿Cuál es tu nombre completo?");
    } else if (msg.startsWith("n")) {
      delete sessionState[from];
      return replyXml(
        res,
        "Gracias por tu interés en ACV. Si más adelante deseas iniciar una solicitud, solo envía 'Hola' o 'Menu'."
      );
    } else {
      return replyXml(
        res,
        "Por favor responde 'Sí' si deseas iniciar tu solicitud o 'No' para finalizar."
      );
    }
  }

  // === PASO 2: NOMBRE ===
  if (state.step === 2) {
    state.data["Cliente"] = rawMsg.trim();
    state.step = 3;
    return replyXml(res, "¿Cuál es el monto que deseas solicitar? (por ejemplo: 200000)");
  }

  // === PASO 3: MONTO ===
  if (state.step === 3) {
    state.data["Monto solicitado"] = rawMsg.trim();
    state.step = 4;
    return replyXml(
      res,
      "¿Qué tienes para dejar en garantía?\n1️⃣ Auto\n2️⃣ Maquinaria pesada\n3️⃣ Reloj de alta gama\n\nO descríbelo brevemente."
    );
  }

  // === PASO 4: GARANTÍA ===
  if (state.step === 4) {
    if (msg.startsWith("1")) state.data["Garantía"] = "Auto";
    else if (msg.startsWith("2")) state.data["Garantía"] = "Maquinaria";
    else if (msg.startsWith("3")) state.data["Garantía"] = "Reloj";
    else state.data["Garantía"] = rawMsg.trim();

    state.step = 5;
    return replyXml(res, "¿De qué año es tu garantía? (por ejemplo: 2020)");
  }

  // === PASO 5: AÑO DEL BIEN ===
  if (state.step === 5) {
    state.data["Año"] = rawMsg.trim();
    state.step = 6;
    return replyXml(
      res,
      "¿En qué estado o ciudad de la República te encuentras? (por ejemplo: Estado de México)"
    );
  }

  // === PASO 6: UBICACIÓN + EVALUAR VIABILIDAD ===
  if (state.step === 6) {
    state.data["Ubicación"] = rawMsg.trim();

    const now = new Date();
    const fechaTexto = now.toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
    });
    const nowIso = now.toISOString();

    state.data["Fecha contacto"] = fechaTexto;

    const evalResult = evaluarLeadViabilidad(
      state.data["Garantía"],
      state.data["Año"],
      state.data["Monto solicitado"]
    );

    console.log(
      `🧮 Evaluación de viabilidad para ${from}:`,
      evalResult.resultado,
      evalResult.motivo
    );

    if (evalResult.resultado === "No viable") {
      const rowNoViable = [
        from, // Celular
        state.data["Cliente"] || "",
        state.data["Garantía"] || "",
        state.data["Año"] || "",
        state.data["Monto solicitado"] || "",
        state.data["Ubicación"] || "",
        "No viable", // Etapa del cliente
        fechaTexto,
        "Bot ACV",
        "", // Fotos
        "", // Foto 1
        "", // Foto 2
        "", // Foto 3
        "", // Foto 4
        "No viable", // Resultado
        evalResult.motivo, // Motivo
        "", // Notas
        "", // Recordatorios enviados
        "", // Último recordatorio ISO
      ];
      await appendLeadRow(rowNoViable);
      delete sessionState[from];
      return replyXml(
        res,
        "Gracias por tu interés en ACV. Por el año o el monto de tu garantía, en este momento no podemos ofrecerte un crédito bajo nuestras políticas actuales."
      );
    }

    // Si es viable → registramos fila pre-calificada y pedimos fotos
    const rowViable = [
      from, // Celular
      state.data["Cliente"] || "",
      state.data["Garantía"] || "",
      state.data["Año"] || "",
      state.data["Monto solicitado"] || "",
      state.data["Ubicación"] || "",
      "Precalificado – pendiente de fotos", // Etapa del cliente
      fechaTexto,
      "Bot ACV", // Responsable
      "", // Fotos
      "", // Foto 1
      "", // Foto 2
      "", // Foto 3
      "", // Foto 4
      "Viable", // Resultado
      evalResult.motivo, // Motivo
      "", // Notas
      "0", // Recordatorios enviados
      nowIso, // Último recordatorio ISO (punto de referencia)
    ];
    await appendLeadRow(rowViable);

    state.step = 8;
    state.data.fotos = [];

    let fotosMsg = "";
    switch (state.data["Garantía"]) {
      case "Auto":
        fotosMsg =
          "Tu solicitud es viable ✅\n\nPor favor envía 4 fotos de tu vehículo, pueden ir en uno o varios mensajes:\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Tablero (km)\n4️⃣ Placa";
        break;
      case "Maquinaria":
        fotosMsg =
          "Tu solicitud es viable ✅\n\nEnvía 4 fotos de tu maquinaria:\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Horas de uso\n4️⃣ VIN o serie";
        break;
      case "Reloj":
        fotosMsg =
          "Tu solicitud es viable ✅\n\nEnvía 4 fotos de tu reloj:\n1️⃣ Carátula\n2️⃣ Pulso\n3️⃣ Corona\n4️⃣ Broche";
        break;
      default:
        fotosMsg =
          "Tu solicitud es viable ✅\n\nEnvía al menos 4 fotos claras de tu garantía. Pueden ir en uno o varios mensajes.";
    }

    return replyXml(res, fotosMsg);
  }

  // === PASO 8: ESPERANDO FOTOS (SIN MEDIA) ===
  if (state.step === 8) {
    const actuales = state.data.fotos || [];
    return replyXml(
      res,
      `Aún no hemos recibido las 4 fotos completas.\nLlevamos registradas ${actuales.length}.\nPor favor continúa enviando fotos, pueden ser una o varias por mensaje.`
    );
  }

  // === FALLBACK ===
  return replyXml(
    res,
    "No entendí tu respuesta. Si deseas iniciar de nuevo, escribe 'menu' o 'hola'."
  );
});

// ===================== PROXY SEGURO DE FOTOS TWILIO =====================
app.get("/media", async (req, res) => {
  try {
    const originalUrl = req.query.url;
    if (!originalUrl) {
      return res.status(400).send("Falta parámetro 'url'.");
    }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res
        .status(500)
        .send("Proxy de media no configurado (faltan credenciales Twilio).");
    }

    const authHeader =
      "Basic " +
      Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const twilioResponse = await fetch(originalUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
    });

    if (!twilioResponse.ok) {
      console.error(
        "❌ Error al pedir media a Twilio:",
        twilioResponse.status,
        await twilioResponse.text()
      );
      return res
        .status(twilioResponse.status)
        .send("Error al obtener media desde Twilio.");
    }

    const contentType =
      twilioResponse.headers.get("content-type") || "application/octet-stream";

    const arrayBuffer = await twilioResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buffer);
  } catch (err) {
    console.error("❌ Error inesperado en /media:", err);
    res.status(500).send("Error en el proxy de media.");
  }
});

// ===================== RUTA DE PRUEBA =====================
app.get("/", (req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send(
      "✅ LeadBot ACV operativo – Flujo Lead Calificado (filtros + fotos automáticas + recordatorios + horario nocturno/fines de semana)."
    );
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
  console.log(
    `⏰ Recordatorios programados cada ${REMINDER_INTERVAL_MINUTES} minutos (delays: ${REMINDER_DELAYS_HOURS.join(
      ", "
    )} horas).`
  );
});

// ===================== PROGRAMAR TAREA PERIÓDICA DE RECORDATORIOS =====================
setInterval(() => {
  revisarLeadsPendientesYEnviarRecordatorios().catch((err) =>
    console.error("❌ Error en ejecución periódica de recordatorios:", err)
  );
}, REMINDER_INTERVAL_MINUTES * 60 * 1000);
