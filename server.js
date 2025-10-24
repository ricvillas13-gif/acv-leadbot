import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import he from "he";
import * as chrono from "chrono-node";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";

// === GOOGLE AUTH ===
let creds;
try {
  console.log("🔍 Verificando GOOGLE_SERVICE_ACCOUNT...");
  creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  console.log("✅ Credenciales parseadas correctamente.");
} catch (err) {
  console.error("❌ ERROR al parsear GOOGLE_SERVICE_ACCOUNT:", err);
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// === SESIONES ===
const sessionState = {};

// === UTILS ===
function xmlEscape(str) {
  return he.encode(str || "", { useNamedReferences: true });
}

// ✅ FUNCIÓN XML CORREGIDA (evita error 12200)
function replyXml(res, message, mediaUrl = null) {
  const safeMessage = he.encode(message || "", { useNamedReferences: true });
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n<Message>\n<Body>${safeMessage}</Body>`;
  if (mediaUrl) xml += `\n<Media>${he.encode(mediaUrl)}</Media>`;
  xml += "\n</Message>\n</Response>";

  res.set("Content-Type", "application/xml; charset=utf-8");
  res.status(200).send(xml.trim());
}

// === FUNCIONES GOOGLE SHEETS ===
async function getExistingLeads() {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Leads!A2:A", // A: Celular
    });
    return result.data.values ? result.data.values.flat() : [];
  } catch (err) {
    console.error("❌ Error obteniendo leads:", err);
    return [];
  }
}

async function appendLeadRow(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Leads!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [data] },
    });
    console.log("✅ Lead guardado:", data[1]);
  } catch (err) {
    console.error("❌ Error guardando Lead:", err);
  }
}

// === FUNCIONES AUXILIARES ===
function formatCurrency(value) {
  const num = parseFloat(value.replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return value;
  return num.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });
}

function parseDateTime(text) {
  const result = chrono.parseDate(text, new Date(), { forwardDate: true });
  return result ? result.toLocaleString("es-MX") : null;
}

// === FLUJO PRINCIPAL ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";
  const msg = (body.Body || "").trim();
  const msgLower = msg.toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0");

  console.log("📩 Mensaje recibido:", from, msg);

  if (!sessionState[from]) sessionState[from] = { step: 0, data: {} };
  const state = sessionState[from];

  // === COMANDOS GLOBALES ===
  if (["menu", "inicio", "hola"].includes(msgLower)) {
    state.step = 1;
    const reply =
      "👋 Hola, soy el asistente virtual de *ACV*.\n\n" +
      "Selecciona una opción:\n" +
      "1️⃣ Iniciar solicitud de crédito\n" +
      "2️⃣ Conocer información general";
    return replyXml(res, reply);
  }

  // === CONTROL DE FOTOS ===
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      const url = body[`MediaUrl${i}`];
      urls.push(url);
    }
    state.data["Fotos"] = (state.data["Fotos"] || []).concat(urls);
    return replyXml(res, `📸 Recibidas ${urls.length} foto(s).`);
  }

  // === PASO 0 ===
  if (state.step === 0) {
    state.step = 1;
    const reply =
      "👋 Hola, soy el asistente virtual de *ACV*.\n\n" +
      "Selecciona una opción:\n" +
      "1️⃣ Iniciar solicitud de crédito\n" +
      "2️⃣ Conocer información general";
    return replyXml(res, reply);
  }

  // === PASO 1 ===
  if (state.step === 1) {
    if (msgLower === "1" || msgLower.includes("solicitud")) {
      // Evita duplicados
      const existingLeads = await getExistingLeads();
      if (existingLeads.includes(from)) {
        return replyXml(
          res,
          "⚠️ Ya tienes una solicitud registrada con este número.\nEspera que un asesor te contacte o escribe *menu* para comenzar de nuevo."
        );
      }
      state.step = 2;
      return replyXml(res, "¿Cuál es tu nombre completo?");
    } else if (msgLower === "2" || msgLower.includes("información")) {
      const info =
        "💰 *Tasa:* 3.99% mensual sin comisión.\n" +
        "📅 *Plazo:* Desde 3 meses, sin penalización.\n" +
        "📋 *Requisitos:* Documentación básica y avalúo físico.\n\n" +
        "¿Deseas iniciar tu solicitud? (responde *Sí* o *No*)";
      return replyXml(res, info);
    }
  }

  // === PASO 2 ===
  if (state.step === 2) {
    state.data["Cliente"] = msg;
    state.step = 3;
    return replyXml(res, "¿Cuál es el monto solicitado?");
  }

  // === PASO 3 ===
  if (state.step === 3) {
    state.data["Monto solicitado"] = formatCurrency(msg);
    state.step = 4;
    return replyXml(
      res,
      "¿Qué tienes para dejar en garantía?\n1️⃣ Auto / Camión\n2️⃣ Maquinaria pesada\n3️⃣ Reloj de alta gama"
    );
  }

  // === PASO 4 ===
  if (state.step === 4) {
    if (msg.startsWith("1")) state.data["Garantía"] = "Auto";
    else if (msg.startsWith("2")) state.data["Garantía"] = "Maquinaria";
    else if (msg.startsWith("3")) state.data["Garantía"] = "Reloj";
    else state.data["Garantía"] = msg;
    state.step = 5;
    return replyXml(
      res,
      "¿Cómo te enteraste de nosotros?\n1️⃣ Facebook\n2️⃣ Instagram\n3️⃣ Referido\n4️⃣ Búsqueda orgánica\n5️⃣ Otro"
    );
  }

  // === PASO 5 ===
  if (state.step === 5) {
    const opciones = {
      1: "Facebook",
      2: "Instagram",
      3: "Referido",
      4: "Búsqueda orgánica",
      5: "Otro",
    };
    state.data["Procedencia del lead"] = opciones[msg] || msg;
    state.step = 6;
    return replyXml(res, "¿En qué estado de la República te encuentras?");
  }

  // === PASO 6 ===
  if (state.step === 6) {
    state.data["Ubicación"] = msg;
    state.step = 7;
    return replyXml(res, "¿Qué día y hora te gustaría agendar tu cita?");
  }

  // === PASO 7 ===
  if (state.step === 7) {
    const fecha = parseDateTime(msg);
    if (!fecha)
      return replyXml(
        res,
        "⚠️ No pude entender la fecha. Por favor indica día y hora en un formato como:\n👉 *Martes 29 a las 3pm* o *28 de octubre 11:00am*"
      );

    state.data["Cita"] = fecha;
    state.data["Fecha contacto"] = new Date().toLocaleString("es-MX");
    state.data["Etapa del cliente"] = "Esperando fotos";
    state.data["Responsable"] = "Bot ACV";
    state.data["Celular"] = from;

    const row = [
      state.data["Celular"],
      state.data["Cliente"],
      state.data["Garantía"],
      state.data["Monto solicitado"],
      state.data["Procedencia del lead"],
      state.data["Ubicación"],
      state.data["Etapa del cliente"],
      state.data["Cita"],
      state.data["Fecha contacto"],
      state.data["Responsable"],
      "",
      "",
      "",
    ];
    await appendLeadRow(row);

    state.step = 8;
    return replyXml(
      res,
      "Perfecto. Por último, envía 4 fotos de tu garantía (una por mensaje):\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Detalle identificativo (placa o serie)\n4️⃣ Vista general"
    );
  }

  // === PASO 8 ===
  if (state.step === 8 && (state.data["Fotos"]?.length || 0) >= 4) {
    state.data["Etapa del cliente"] = "Completado";
    await appendLeadRow([
      state.data["Celular"],
      state.data["Cliente"],
      state.data["Garantía"],
      state.data["Monto solicitado"],
      state.data["Procedencia del lead"],
      state.data["Ubicación"],
      state.data["Etapa del cliente"],
      state.data["Cita"],
      state.data["Fecha contacto"],
      state.data["Responsable"],
      "Pendiente de revisión",
      "",
      (state.data["Fotos"] || []).join("\n"),
    ]);
    delete sessionState[from];
    return replyXml(
      res,
      "✅ Gracias, tu solicitud ha sido registrada.\nUn asesor se pondrá en contacto contigo muy pronto."
    );
  }

  // === RESPUESTA POR DEFECTO ===
  return replyXml(res, "Por favor continúa con las instrucciones anteriores.");
});

// === TEST ROUTE ===
app.get("/", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ LeadBot ACV operativo y listo para pruebas.");
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
