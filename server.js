import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import he from "he"; // escapador HTML seguro

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";

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

// === SESIONES ===
const sessionState = {};

// === UTILS ===
function xmlEscape(str) {
  return he.encode(str || "", { useNamedReferences: true });
}

function replyXml(res, message, mediaUrl = null) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>';
  xml += `<Body>${xmlEscape(message)}</Body>`;
  if (mediaUrl) xml += `<Media>${xmlEscape(mediaUrl)}</Media>`;
  xml += "</Message></Response>";

  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  res.end(xml);
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

// === FLUJO ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";
  const msg = (body.Body || "").trim().toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0");

  console.log("📩 Mensaje recibido:", from, msg);

  if (!sessionState[from]) sessionState[from] = { step: 0, data: {} };
  const state = sessionState[from];

  // === MEDIOS ===
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      const url = body[`MediaUrl${i}`];
      const tipo = state.data["Garantía"] || "Foto";
      urls.push(`${tipo} - ${url}`);
    }
    state.data["Fotos"] = (state.data["Fotos"] || []).concat(urls);
    return replyXml(res, `📸 Recibidas ${urls.length} foto(s)`);
  }

  // === PASO 0 ===
  if (state.step === 0 || msg.includes("hola")) {
    state.step = 1;
    const reply =
      "Hola, soy el asistente virtual de ACV.\n" +
      "Gracias por contactarnos.\n\n" +
      "Selecciona una opción:\n" +
      "1️⃣ Iniciar solicitud de crédito\n" +
      "2️⃣ Conocer información general";
    return replyXml(
      res,
      reply,
      "https://drive.google.com/uc?export=view&id=1lnDmapOVPRlnDFTwXYj8y0pmUmw_rvqh"
    );
  }

  // === PASO 1 ===
  if (state.step === 1) {
    if (msg === "1" || msg.includes("solicitud")) {
      state.step = 2;
      return replyXml(res, "¿Cuál es tu nombre completo?");
    } else if (msg === "2" || msg.includes("información")) {
      const info =
        "💰 Tasa: 3.99% mensual sin comisión.\n" +
        "📅 Plazo: Desde 3 meses, sin penalización.\n" +
        "📋 Requisitos: Documentación básica y avalúo físico.\n\n" +
        "¿Deseas iniciar tu solicitud? (responde Sí o No)";
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
    state.data["Monto solicitado"] = msg;
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
    state.data["Cita"] = msg;
    state.data["Fecha contacto"] = new Date().toLocaleString("es-MX");
    state.data["Responsable"] = "Bot ACV";
    state.data["Etapa del cliente"] = "Esperando fotos";

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

    let fotosMsg = "";
    switch (state.data["Garantía"]) {
      case "Auto":
        fotosMsg =
          "Envía 4 fotos de tu vehículo:\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Tablero (km)\n4️⃣ Placa";
        break;
      case "Maquinaria":
        fotosMsg =
          "Envía 4 fotos de tu maquinaria:\n1️⃣ Exterior\n2️⃣ Interior\n3️⃣ Horas de uso\n4️⃣ VIN o serie";
        break;
      case "Reloj":
        fotosMsg =
          "Envía 4 fotos de tu reloj:\n1️⃣ Carátula\n2️⃣ Pulso\n3️⃣ Corona\n4️⃣ Broche";
        break;
    }
    state.step = 8;
    return replyXml(res, fotosMsg);
  }

  // === PASO 8 ===
  if (state.step === 8 && (state.data["Fotos"]?.length || 0) >= 4) {
    state.data["Etapa del cliente"] = "Completado";
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
    return replyXml(res, "✅ Gracias, tu solicitud ha sido registrada.");
  }

  return replyXml(res, "Por favor continúa con las instrucciones anteriores.");
});

// Ruta de test
app.get("/", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ LeadBot ACV operativo.");
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
