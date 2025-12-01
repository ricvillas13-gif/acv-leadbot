import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import he from "he"; // escapador HTML seguro

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const SHEET_ID = "1OGtZIFiEZWI8Tws1X_tZyEfgiEnVNlGcJay-Dg6-N_o";

// === TWILIO AUTH PARA PROXY DE FOTOS ===
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn(
    "⚠️ TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN no están definidos. /media no funcionará."
  );
}

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
  // Usamos referencias numéricas en lugar de entidades con nombre
  // para evitar problemas tipo &oacute; con Twilio.
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

// === FLUJO PRINCIPAL ===
app.post("/", async (req, res) => {
  const body = req.body;
  const from = body.From || "";
  const msg = (body.Body || "").trim().toLowerCase();
  const mediaCount = parseInt(body.NumMedia || "0", 10);

  console.log("📩 Mensaje recibido:", from, msg);

  if (!sessionState[from]) sessionState[from] = { step: 0, data: {} };
  const state = sessionState[from];

  // === MANEJO DE MEDIOS (FOTOS) ===
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

  // === PASO 0: MENÚ INICIAL / SALUDO ===
  if (state.step === 0 || msg.includes("hola") || msg.includes("menu")) {
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
      // Si tienes un logo accesible por URL pública, puedes ponerlo aquí:
      // "https://acv-leadbot-1.onrender.com/logo-acv.png"
      null
    );
  }

  // === PASO 1: ELECCIÓN DEL FLUJO ===
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
      state.step = 1.5;
      return replyXml(res, info);
    }
  }

  // === PASO 1.5: CONFIRMACIÓN DESPUÉS DE INFO GENERAL ===
  if (state.step === 1.5) {
    if (msg.startsWith("s")) {
      state.step = 2;
      return replyXml(res, "Perfecto 🙌\n¿Cuál es tu nombre completo?");
    } else if (msg.startsWith("n")) {
      state.step = 0;
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
    state.data["Cliente"] = msg;
    state.step = 3;
    return replyXml(res, "¿Cuál es el monto solicitado?");
  }

  // === PASO 3: MONTO ===
  if (state.step === 3) {
    state.data["Monto solicitado"] = msg;
    state.step = 4;
    return replyXml(
      res,
      "¿Qué tienes para dejar en garantía?\n1️⃣ Auto\n2️⃣ Maquinaria pesada\n3️⃣ Reloj de alta gama"
    );
  }

  // === PASO 4: GARANTÍA ===
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

  // === PASO 5: PROCEDENCIA DEL LEAD ===
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

  // === PASO 6: UBICACIÓN ===
  if (state.step === 6) {
    state.data["Ubicación"] = msg;
    state.step = 7;
    return replyXml(res, "¿Qué día y hora te gustaría agendar tu cita?");
  }

  // === PASO 7: CITA + REGISTRO EN SHEETS ===
  if (state.step === 7) {
    state.data["Cita"] = msg;
    state.data["Fecha contacto"] = new Date().toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
    });
    state.data["Responsable"] = "Bot ACV";
    state.data["Etapa del cliente"] = "Esperando fotos";

    // Ajusta este arreglo al layout de columnas que tengas en la hoja Leads
    const row = [
      from, // Celular
      state.data["Cliente"],
      state.data["Garantía"],
      "", // Año (no lo estamos pidiendo en este flujo sencillo)
      state.data["Monto solicitado"],
      state.data["Ubicación"],
      state.data["Etapa del cliente"],
      state.data["Fecha contacto"],
      state.data["Responsable"],
      "", // Fotos
      "", // Resultado final
      "", // Observaciones
      "", // Resultado (col extra)
      "", // Observaciones (col extra)
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
      default:
        fotosMsg =
          "Envía 4 fotos claras de tu garantía, por favor. Una por mensaje.";
    }
    state.step = 8;
    return replyXml(res, fotosMsg);
  }

  // === PASO 8: ESPERANDO FOTOS (EJEMPLO SIMPLE) ===
  if (state.step === 8) {
    const fotosActuales = state.data["Fotos"] || [];
    if (fotosActuales.length >= 4) {
      state.data["Etapa del cliente"] = "Completado";
      await appendLeadRow([
        from,
        state.data["Cliente"],
        state.data["Garantía"],
        "",
        state.data["Monto solicitado"],
        state.data["Ubicación"],
        state.data["Etapa del cliente"],
        state.data["Fecha contacto"],
        state.data["Responsable"],
        (state.data["Fotos"] || []).join("\n"),
        "",
        "",
        "",
        "",
      ]);
      delete sessionState[from];
      return replyXml(
        res,
        "✅ Gracias, tu solicitud ha sido registrada. En breve un asesor de ACV se pondrá en contacto contigo."
      );
    }

    return replyXml(
      res,
      "Aún no recibimos las 4 fotos completas. Por favor continúa enviando las fotos en mensajes separados."
    );
  }

  return replyXml(res, "Por favor continúa con las instrucciones anteriores.");
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
      "✅ LeadBot ACV operativo – Flujo Lead Calificado (versión sencilla + proxy de fotos)."
    );
});

app.listen(PORT, () => {
  console.log(`🚀 LeadBot ACV ejecutándose en el puerto ${PORT}`);
});
