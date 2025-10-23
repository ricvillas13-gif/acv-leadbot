// server.js
import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// === CONFIGURACIÓN ===
const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";

// === AUTENTICACIÓN GOOGLE ===
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

// === ESTADO TEMPORAL DE LEADS ===
const sessionState = {}; // { phone: { step, data } }

// === FUNCIONES AUXILIARES ===
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

function makeTwiml(msg, mediaUrl) {
  let xml = `<Response><Message>`;
  if (mediaUrl) xml += `<Media>${mediaUrl}</Media>`;
  xml += `${msg}</Message></Response>`;
  return xml;
}

function replyXml(res, msg, mediaUrl) {
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(makeTwiml(msg, mediaUrl));
}

// === FLUJO DE CONVERSACIÓN ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";
  const msg = (body.Body || "").trim().toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0");

  console.log("📩 Mensaje recibido:", from, msg);

  if (!sessionState[from]) sessionState[from] = { step: 0, data: {} };
  const state = sessionState[from];

  // --- Manejo de medios (fotos) ---
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      const url = body[`MediaUrl${i}`];
      const type = state.data["Garantía"] || "Foto";
      urls.push(`Foto ${type} - ${url}`);
    }
    state.data["Fotos"] = (state.data["Fotos"] || []).concat(urls);
    const reply = `📸 Recibidas ${urls.length} foto(s) de tu garantía.`;
    return replyXml(res, reply);
  }

  // === Paso 0: Bienvenida ===
  if (state.step === 0 || msg.includes("hola")) {
    state.step = 1;
    const reply =
      "👋 *Hola! Soy el asistente virtual de ACV*.\n" +
      "¡Gracias por contactarnos!\n\n" +
      "Por favor elige una opción:\n" +
      "1️⃣ Iniciar solicitud de crédito\n" +
      "2️⃣ Conocer información general";
    return replyXml(
      res,
      reply,
      "https://drive.google.com/uc?export=view&id=1lnDmapOVPRlnDFTwXYj8y0pmUmw_rvqh"
    );
  }

  // === Paso 1: Menú inicial ===
  if (state.step === 1) {
    if (msg === "1" || msg.includes("solicitud")) {
      state.step = 2;
      return replyXml(res, "¿Cuál es tu nombre completo?");
    } else if (msg === "2" || msg.includes("información")) {
      const info =
        "💰 *Tasa:* 3.99% mensual sin comisión.\n" +
        "📅 *Plazo:* Desde 3 meses, sin penalización.\n" +
        "📋 *Requisitos:* Documentación básica y avalúo físico.\n\n" +
        "¿Deseas iniciar tu solicitud? (responde *Sí* o *No*)";
      return replyXml(res, info);
    }
  }

  // === Paso 2: Nombre ===
  if (state.step === 2) {
    state.data["Cliente"] = msg;
    state.step = 3;
    return replyXml(res, "¿Cuál es el *monto solicitado*?");
  }

  // === Paso 3: Monto ===
  if (state.step === 3) {
    state.data["Monto solicitado"] = msg;
    state.step = 4;
    const opciones =
      "¿Qué tienes para dejar en garantía?\n" +
      "1️⃣ Auto / Camión\n" +
      "2️⃣ Maquinaria pesada\n" +
      "3️⃣ Reloj de alta gama";
    return replyXml(res, opciones);
  }

  // === Paso 4: Garantía ===
  if (state.step === 4) {
    if (msg.startsWith("1")) state.data["Garantía"] = "Auto";
    else if (msg.startsWith("2")) state.data["Garantía"] = "Maquinaria";
    else if (msg.startsWith("3")) state.data["Garantía"] = "Reloj";
    else state.data["Garantía"] = msg;

    state.step = 5;
    const procedencia =
      "¿Cómo te enteraste de nosotros?\n" +
      "1️⃣ Facebook\n" +
      "2️⃣ Instagram\n" +
      "3️⃣ Referido\n" +
      "4️⃣ Búsqueda orgánica\n" +
      "5️⃣ Otro";
    return replyXml(res, procedencia);
  }

  // === Paso 5: Procedencia ===
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
    const ubicacion = "¿En qué estado de la República te encuentras?";
    return replyXml(res, ubicacion);
  }

  // === Paso 6: Ubicación ===
  if (state.step === 6) {
    state.data["Ubicación"] = msg;
    state.step = 7;
    const cita = "¿Qué día y hora te gustaría agendar tu cita?";
    return replyXml(res, cita);
  }

  // === Paso 7: Cita ===
  if (state.step === 7) {
    state.data["Cita"] = msg;
    state.data["Fecha contacto"] = new Date().toLocaleString("es-MX");
    state.data["Responsable"] = "Bot ACV";
    state.data["Etapa del cliente"] = "Esperando fotos";

    // Guardamos en Google Sheets
    const row = [
      state.data["Fecha contacto"],
      state.data["Cliente"],
      state.data["Garantía"],
      state.data["Monto solicitado"],
      state.data["Procedencia del lead"],
      state.data["Ubicación"],
      state.data["Etapa del cliente"],
      state.data["Cita"],
      "",
      state.data["Responsable"],
      "",
      "",
      "",
    ];
    await appendLeadRow(row);

    // Mensaje con instrucciones de fotos según garantía
    let fotosMsg = "";
    switch (state.data["Garantía"]) {
      case "Auto":
        fotosMsg =
          "🚗 Por favor envíame 4 fotos de tu vehículo:\n" +
          "1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Tablero (km)\n4️⃣ Placa de circulación";
        break;
      case "Maquinaria":
        fotosMsg =
          "🏗️ Envía 4 fotos de tu maquinaria:\n" +
          "1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Horas de uso\n4️⃣ VIN o serie";
        break;
      case "Reloj":
        fotosMsg =
          "⌚ Envía 4 fotos de tu reloj:\n" +
          "1️⃣ Carátula\n2️⃣ Pulso\n3️⃣ Corona\n4️⃣ Broche";
        break;
    }
    state.step = 8;
    return replyXml(res, fotosMsg);
  }

  // === Paso 8: Fotos ===
  if (state.step === 8 && state.data["Fotos"]?.length >= 4) {
    state.data["Etapa del cliente"] = "Completado";
    const confirm =
      "✅ Gracias por enviar las fotos. Tu solicitud está lista para revisión.";
    await appendLeadRow([
      state.data["Fecha contacto"],
      state.data["Cliente"],
      state.data["Garantía"],
      state.data["Monto solicitado"],
      state.data["Procedencia del lead"],
      state.data["Ubicación"],
      state.data["Etapa del cliente"],
      state.data["Cita"],
      "",
      state.data["Responsable"],
      "Pendiente de revisión",
      "",
      (state.data["Fotos"] || []).join("\n"),
    ]);
    delete sessionState[from];
    return replyXml(res, confirm);
  }

  // Respuesta por defecto
  replyXml(res, "Por favor sigue las instrucciones anteriores.");
});

// === INICIO SERVIDOR ===
app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
