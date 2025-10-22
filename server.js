import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { GoogleSpreadsheet } from 'google-spreadsheet';

// ====== CONFIG ======
const {
  PORT = 10000,
  SHEET_ID,                 // ID de tu Google Sheet (el que ya usaste para “Leads”)
  GOOGLE_SERVICE_EMAIL,     // service account email (xxxxx@project.iam.gserviceaccount.com)
  GOOGLE_PRIVATE_KEY        // private key (cuídala; en Render usar env var con saltos de línea \n)
} = process.env;

if (!SHEET_ID || !GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('❌ Falta configurar SHEET_ID, GOOGLE_SERVICE_EMAIL y GOOGLE_PRIVATE_KEY en variables de entorno.');
  process.exit(1);
}

// ====== GOOGLE SHEETS HELPER ======
const doc = new GoogleSpreadsheet(SHEET_ID);

async function authSheet() {
  await doc.useServiceAccountAuth({
    client_email: GOOGLE_SERVICE_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
}

async function getLeadsSheet() {
  await authSheet();
  let sheet = doc.sheetsByTitle['Leads'] || doc.sheetsByTitle['Lead'];
  if (!sheet) {
    // crea “Leads” si no existe
    sheet = await doc.addSheet({
      title: 'Leads',
      headerValues: [
        'Cliente','Garantia','Fecha de Contacto','Monto solicitado','Email','Celular',
        'Procedencia de lead','Ubicación','Etapa del cliente','Cita','Lugar','Responsable',
        'Resultado Final','Observaciones','Fotos'
      ]
    });
  } else {
    // asegura headers mínimos
    await sheet.setHeaderRow([
      'Cliente','Garantia','Fecha de Contacto','Monto solicitado','Email','Celular',
      'Procedencia de lead','Ubicación','Etapa del cliente','Cita','Lugar','Responsable',
      'Resultado Final','Observaciones','Fotos'
    ]);
  }
  return sheet;
}

function nowISOmx() {
  const now = new Date();
  return now.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
}

function normalizePhoneTwilio(from) {
  // Ej: "whatsapp:+5217298899266" -> "5217298899266"
  return String(from || '').replace(/^whatsapp:\+?/, '').replace(/\D/g, '');
}

async function findOrCreateByPhone(phone) {
  const sheet = await getLeadsSheet();
  await sheet.loadCells('A1:N1'); // headers
  const rows = await sheet.getRows();
  let row = rows.find(r => (String(r['Celular']||'').replace(/\D/g,'') === phone));
  if (!row) {
    row = await sheet.addRow({
      'Celular': phone,
      'Fecha de Contacto': nowISOmx(),
      'Etapa del cliente': 'contacto inicial'
    });
  }
  return row;
}

// ====== VALIDACIONES / CATALOGOS ======
const GARANTIAS = [
  'Auto','Camioneta','Maquinaria','Reloj','Inmueble','Motocicleta','Camión','Tracto'
];

const PROCEDENCIAS = [
  'Referido','anuncio en linea','evento','busqueda organica','publicidad facebook',
  'publicidad instagram','ninguno','campaña de whatsapp','formulario facebook',
  'campaña de facebook para messenger'
];

const ESTADOS_MX = [
  'Aguascalientes','Baja California','Baja California Sur','Campeche','Coahuila',
  'Colima','Chiapas','Chihuahua','Ciudad de México','Durango','Guanajuato','Guerrero',
  'Hidalgo','Jalisco','México','Michoacán','Morelos','Nayarit','Nuevo León','Oaxaca',
  'Puebla','Querétaro','Quintana Roo','San Luis Potosí','Sinaloa','Sonora','Tabasco',
  'Tamaulipas','Tlaxcala','Veracruz','Yucatán','Zacatecas'
];

const ETAPAS = [
  'contacto inicial','calificacion','seguimiento','prospecto a credito',
  'investigacion de activo','cita','negociacion','cierre','cliente perdido'
];

const RESULTADOS = [
  'credito activado','credito rechazado','otro','credito inconcluso',
  'sin respuesta del solicitante','en espera del solicitante'
];

function isEmail(v='') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}
function looksMoney(v='') {
  return /[\d\.,]{2,}/.test(v);
}
function toMoney(v='') {
  const n = Number(String(v).replace(/[^\d.-]/g,''));
  return isFinite(n) ? n.toFixed(2) : '';
}
function canonFromList(v, list) {
  const s = String(v||'').trim().toLowerCase();
  const hit = list.find(x => x.toLowerCase() === s);
  return hit || '';
}
function titleCase(s='') {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

// ====== FLUJO ======
function nextMissing(row) {
  const order = ['Cliente','Email','Celular','Garantia','Monto solicitado','Ubicación','Procedencia de lead'];
  for (const k of order) {
    if (!String(row[k]||'').trim()) return k;
  }
  return '';
}

function questionFor(field, row) {
  switch (field) {
    case 'Cliente': return '👋 Soy el asistente de ACV. ¿Cuál es tu nombre completo?';
    case 'Email': return '📧 ¿Cuál es tu correo electrónico?';
    case 'Celular': return '📱 ¿Podrías confirmar tu número de teléfono?';
    case 'Garantia': return `🔒 ¿Qué garantía ofrecerías (ej: ${GARANTIAS.slice(0,4).join(', ')})?`;
    case 'Monto solicitado': return '💵 ¿Qué monto estás solicitando?';
    case 'Ubicación': return `📍 ¿En qué estado de la República te encuentras?`;
    case 'Procedencia de lead': return `📣 ¿Cómo te enteraste de ACV? (ej: Referido, anuncio en linea, evento, publicidad facebook, etc.)`;
    default: return 'Gracias. ¿Deseas enviar fotos de la garantía? Puedes adjuntarlas ahora 📸.';
  }
}

function summary(row) {
  return [
    `• Cliente: ${row['Cliente']||''}`,
    `• Email: ${row['Email']||''}`,
    `• Celular: ${row['Celular']||''}`,
    `• Garantía: ${row['Garantia']||''}`,
    `• Monto: ${row['Monto solicitado']||''}`,
    `• Ubicación: ${row['Ubicación']||''}`,
    `• Procedencia: ${row['Procedencia de lead']||''}`,
    row['Fotos'] ? `• Fotos: ${row['Fotos']}` : ''
  ].filter(Boolean).join('\n');
}

function twiml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${text}</Message></Response>`;
}

// ====== APP ======
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/', (_req,res) => {
  res.status(200).send('✅ LeadBot ACV activo y esperando mensajes desde Twilio');
});

// Webhook de Twilio (WhatsApp → POST)
app.post('/twilio', async (req, res) => {
  try {
    const from = req.body.From || '';
    const body = (req.body.Body || '').trim();
    const numMedia = Number(req.body.NumMedia || 0);

    console.log('📩 POST desde Twilio:', { From: from, Body: body, NumMedia: numMedia });

    const phone = normalizePhoneTwilio(from);
    const row = await findOrCreateByPhone(phone);

    // Guarda fotos (si llegan primero o cuando sea)
    if (numMedia > 0) {
      const urls = [];
      for (let i = 0; i < numMedia; i++) {
        const url = req.body[`MediaUrl${i}`];
        if (url) urls.push(url);
      }
      const prev = String(row['Fotos']||'').trim();
      row['Fotos'] = prev ? (prev + ', ' + urls.join(', ')) : urls.join(', ');
      row['Observaciones'] = (row['Observaciones']||'') + ` [${nowISOmx()}] Se recibieron ${urls.length} foto(s).`;
      await row.save();
    }

    // Edición de monto rápida
    const editMonto = body.match(/(cambiar|modificar).*(monto|cantidad).*?(\d[\d,\.]+)/i) ||
                      body.match(/monto.*?(\d[\d,\.]+)/i);
    if (editMonto) {
      const val = editMonto[3] || editMonto[1];
      row['Monto solicitado'] = toMoney(val);
      row['Observaciones'] = (row['Observaciones']||'') + ` [${nowISOmx()}] Editó monto a ${row['Monto solicitado']}.`;
      await row.save();
      res.set('Content-Type', 'application/xml');
      return res.status(200).send(twiml(`✅ Actualicé tu monto a $${row['Monto solicitado']}.`));
    }

    // Mapeo “inteligente” de respuestas
    if (!row['Cliente'] && body) row['Cliente'] = titleCase(body);
    else if (!row['Email'] && isEmail(body)) row['Email'] = body;
    else if (!row['Garantia'] && canonFromList(body, GARANTIAS)) row['Garantia'] = canonFromList(body, GARANTIAS);
    else if (!row['Monto solicitado'] && looksMoney(body)) row['Monto solicitado'] = toMoney(body);
    else if (!row['Ubicación'] && canonFromList(titleCase(body), ESTADOS_MX)) row['Ubicación'] = canonFromList(titleCase(body), ESTADOS_MX);
    else if (!row['Procedencia de lead'] && canonFromList(body.toLowerCase(), PROCEDENCIAS)) row['Procedencia de lead'] = canonFromList(body.toLowerCase(), PROCEDENCIAS);

    // Etapas
    if (!row['Etapa del cliente'] || row['Etapa del cliente'] === 'contacto inicial') {
      row['Etapa del cliente'] = 'calificacion';
    }

    // Mensajes básicos de ayuda
    if (/^(menu|ayuda)$/i.test(body)) {
      await row.save();
      res.set('Content-Type', 'application/xml');
      return res.status(200).send(twiml(
        '📋 Opciones:\n' +
        '• Enviar fotos de la garantía (adjúntalas aquí)\n' +
        '• "Quiero cambiar mi monto solicitado a 250,000"\n' +
        '• "status" para ver tus datos'
      ));
    }
    if (/^(status|mis datos)$/i.test(body)) {
      await row.save();
      res.set('Content-Type', 'application/xml');
      return res.status(200).send(twiml('📄 Resumen:\n' + summary(row)));
    }

    // Guardar avance
    await row.save();

    const missing = nextMissing(row);
    res.set('Content-Type', 'application/xml');
    if (missing) {
      return res.status(200).send(twiml(questionFor(missing, row)));
    } else {
      // completo lo esencial
      return res.status(200).send(twiml(
        '✅ Gracias. Ya tengo la info clave.\n' +
        summary(row) +
        '\n\nPuedes enviar fotos cuando gustes 📸 o escribir "status".'
      ));
    }
  } catch (err) {
    console.error('❌ Error webhook:', err);
    res.set('Content-Type', 'application/xml');
    return res.status(200).send(twiml('⚠️ Ocurrió un error. Intenta de nuevo en unos minutos.'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});
