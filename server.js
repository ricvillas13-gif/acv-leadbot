import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// ===================================================
// 🔐 CONFIGURACIÓN
// ===================================================
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = "Leads";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ===================================================
// 📋 CATÁLOGOS
// ===================================================
const GARANTIAS = ["Auto", "Inmueble", "Maquinaria", "Reloj"];
const PROCEDENCIAS = [
  "Referido", "Anuncio en línea", "Evento", "Búsqueda orgánica",
  "Publicidad Facebook", "Publicidad Instagram", "Campaña WhatsApp",
  "Formulario Facebook", "Campaña Messenger", "Ninguno"
];
const ESTADOS = [
  "Aguascalientes","Baja California","Baja California Sur","Campeche","Chiapas","Chihuahua","CDMX","Coahuila",
  "Colima","Durango","Edo. Mex","Guanajuato","Guerrero","Hidalgo","Jalisco","Michoacán","Morelos","Nayarit",
  "Nuevo León","Oaxaca","Puebla","Querétaro","Quintana Roo","San Luis Potosí","Sinaloa","Sonora",
  "Tabasco","Tamaulipas","Tlaxcala","Veracruz","Yucatán","Zacatecas"
];
const LUGARES = ["Corporativo", "Patio de Resguardo 1", "Patio de Resguardo 2"];
const ESTATUS = [
  "Crédito activado", "Crédito rechazado", "Crédito inconcluso",
  "Sin respuesta del solicitante", "En espera del solicitante", "Otro"
];

// ===================================================
// ⚙️ FUNCIONES AUXILIARES
// ===================================================
function twimlResponse(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

async function appendRow(data) {
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

// ===================================================
// 🤖 FLUJO DEL CHATBOT
// ===================================================
let tempLeads = {}; // para mantener el estado temporal por número

app.post("/", async (req, res) => {
  const from = req.body.From || "";
  const body = (req.body.Body || "").trim();
  const mediaCount = parseInt(req.body.NumMedia || "0");
  const now = new Date().toLocaleString("es-MX");

  console.log("📩", from, "→", body);

  // Crear registro temporal si no existe
  if (!tempLeads[from]) {
    tempLeads[from] = {
      fecha: now,
      cliente: "",
      garantia: "",
      monto: "",
      procedencia: "",
      ubicacion: "",
      cita: "",
      lugar: "",
      responsable: "Bot ACV",
      resultado: "",
      fotos: [],
      etapa: "Contacto inicial",
    };
  }
  const lead = tempLeads[from];

  // === 1️⃣ Nombre ===
  if (!lead.cliente) {
    lead.cliente = body;
    res.type("text/xml").send(
      twimlResponse(`Gracias, ${lead.cliente}. ¿Qué bien podrías dejar como garantía? (${GARANTIAS.join(", ")})`)
    );
    return;
  }

  // === 2️⃣ Garantía ===
  if (!lead.garantia && GARANTIAS.some(g => body.toLowerCase().includes(g.toLowerCase()))) {
    lead.garantia = GARANTIAS.find(g => body.toLowerCase().includes(g.toLowerCase()));
    res.type("text/xml").send(twimlResponse("Perfecto 👍 ¿Cuál es el monto que deseas solicitar?"));
    return;
  }

  // === 3️⃣ Monto ===
  if (!lead.monto && /[\$]?\s*\d+/.test(body)) {
    lead.monto = body;
    res.type("text/xml").send(twimlResponse(`Gracias 💰 ¿Cómo conociste ACV? (${PROCEDENCIAS.join(", ")})`));
    return;
  }

  // === 4️⃣ Procedencia ===
  if (!lead.procedencia && PROCEDENCIAS.some(p => body.toLowerCase().includes(p.toLowerCase()))) {
    lead.procedencia = PROCEDENCIAS.find(p => body.toLowerCase().includes(p.toLowerCase()));
    res.type("text/xml").send(twimlResponse(`Perfecto. ¿En qué estado te encuentras? (${ESTADOS.slice(0,6).join(", ")}...)`));
    return;
  }

  // === 5️⃣ Ubicación ===
  if (!lead.ubicacion && ESTADOS.some(e => body.toLowerCase().includes(e.toLowerCase()))) {
    lead.ubicacion = ESTADOS.find(e => body.toLowerCase().includes(e.toLowerCase()));
    res.type("text/xml").send(twimlResponse("Excelente 🌎. Por favor envíame 3 fotos del bien que dejarías en garantía."));
    return;
  }

  // === 6️⃣ Fotos ===
  if (mediaCount > 0) {
    for (let i = 0; i < mediaCount; i++) {
      lead.fotos.push(req.body[`MediaUrl${i}`]);
    }
    if (lead.fotos.length < 3) {
      res.type("text/xml").send(twimlResponse(`Recibida ${lead.fotos.length} foto(s). Faltan ${3 - lead.fotos.length} más 📸`));
      return;
    } else {
      res.type("text/xml").send(twimlResponse("Perfecto 👍 ¿Deseas proponer una fecha y hora para una cita con un asesor?"));
      return;
    }
  }

  // === 7️⃣ Cita ===
  if (!lead.cita && /\d{1,2}\/\d{1,2}|\d{1,2}\s*(am|pm)/i.test(body)) {
    lead.cita = body;
    res.type("text/xml").send(twimlResponse(`Gracias 🗓️. ¿Dónde te gustaría la cita? (${LUGARES.join(", ")})`));
    return;
  }

  // === 8️⃣ Lugar ===
  if (!lead.lugar && LUGARES.some(l => body.toLowerCase().includes(l.toLowerCase()))) {
    lead.lugar = LUGARES.find(l => body.toLowerCase().includes(l.toLowerCase()));
    lead.resultado = "En espera del solicitante"; // por defecto
    lead.etapa = "Calificación";

    // Registrar en Sheets
    await appendRow([
      lead.fecha, lead.cliente, lead.garantia, lead.monto, "",
      lead.procedencia, lead.ubicacion, lead.etapa, lead.cita, lead.lugar,
      lead.responsable, lead.resultado, "", lead.fotos.join(", ")
    ]);

    res.type("text/xml").send(
      twimlResponse(`Gracias ${lead.cliente} 🙏. Hemos registrado tu información. Un asesor se pondrá en contacto contigo pronto.`)
    );
    delete tempLeads[from];
    return;
  }

  // === Default ===
  res.type("text/xml").send(twimlResponse("Disculpa, no entendí bien 🤔. ¿Podrías repetirlo?"));
});

// ===================================================
// 🚀 SERVIDOR
// ===================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 LeadBot ACV final operativo en puerto ${PORT}`));
