// ======================================================
//  ACV LeadBot - WhatsApp Chatbot conectado a Google Sheets
// ======================================================

import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// 🔐 Configuración principal
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o"; // 👈 reemplaza por tu ID real de Google Sheets
const SHEET_NAME = "Leads";

// === Autenticación con Google ===
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY), // Clave JSON de servicio en Render
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// === Funciones auxiliares ===
async function appendLeadRow(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [data] },
    });
  } catch (err) {
    console.error("❌ Error escribiendo en la hoja:", err);
  }
}

function twimlResponse(text) {
  return `
    <Response>
      <Message>${text}</Message>
    </Response>
  `;
}

// === Flujo del chatbot ===
app.post("/", async (req, res) => {
  const from = req.body.From || "";
  const body = (req.body.Body || "").trim();
  const mediaCount = parseInt(req.body.NumMedia || "0");

  console.log("📩 Mensaje recibido:", from, body);

  // Flujo básico
  if (/hola|buenas/i.test(body)) {
    res.type("text/xml").send(
      twimlResponse("👋 Hola, soy el asistente de créditos ACV. ¿Cuál es tu nombre completo?")
    );
    return;
  }

  // Si parece un nombre
  if (body.split(" ").length >= 2 && body.length < 50) {
    await appendLeadRow([new Date().toLocaleString("es-MX"), from, "", body]);
    res.type("text/xml").send(
      twimlResponse("Gracias, ¿podrías indicarme el monto que deseas solicitar?")
    );
    return;
  }

  // Si parece un monto
  if (/[\$]?\s*\d+/.test(body)) {
    await appendLeadRow([new Date().toLocaleString("es-MX"), from, body]);
    res.type("text/xml").send(
      twimlResponse("Perfecto ✅ ¿Podrías enviarme una foto del bien que dejarías en garantía?")
    );
    return;
  }

  // Si envió una foto
  if (mediaCount > 0) {
    const urls = [];
    for (let i = 0; i < mediaCount; i++) {
      urls.push(req.body[`MediaUrl${i}`]);
    }
    await appendLeadRow([new Date().toLocaleString("es-MX"), from, "", "", "📸 Fotos:", urls.join(", ")]);
    res.type("text/xml").send(
      twimlResponse("Gracias, hemos recibido las fotos. Un asesor se pondrá en contacto contigo pronto.")
    );
    return;
  }

  // Respuesta por defecto
  res.type("text/xml").send(
    twimlResponse("Disculpa, no entendí bien. ¿Podrías repetirlo?")
  );
});

// === Inicialización ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV operativo en puerto ${PORT}`);
});
