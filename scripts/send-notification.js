// Optioneel: stuurt een korte e-mail met de nieuwste analyse via Resend (resend.com).
// Als RESEND_API_KEY of NOTIFY_EMAIL niet is ingesteld, doet dit script niets (geen fout).
// Resend heeft een gratis laag; je hebt een (gratis) account en een geverifieerd
// verzenddomein of hun test-adres nodig. Zie https://resend.com/docs

const fs = require('fs');
const path = require('path');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;

async function main() {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    console.log('RESEND_API_KEY of NOTIFY_EMAIL niet ingesteld — e-mailnotificatie overgeslagen.');
    return;
  }

  const analysisPath = path.join(__dirname, '..', 'data', 'analysis.json');
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));

  const suggestionsHtml = (analysis.suggestions || []).map(s => `
    <li style="margin-bottom:8px;">
      <strong>${s.instrument}</strong> (${s.assetClass}) — ${s.direction}<br>
      Entry: ${s.entry} | SL: ${s.stopLoss} | TP: ${s.target}<br>
      <span style="color:#666;">${s.rationale || ''}</span>
    </li>
  `).join('');

  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2>AI Marktanalyse — ${new Date(analysis.generatedAt).toLocaleString('nl-NL')}</h2>
      <p>${analysis.marketSummary || ''}</p>
      <ul>${suggestionsHtml}</ul>
      <p style="font-size:12px; color:#888; margin-top:20px;">${analysis.disclaimer || ''}</p>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || 'Trader Pro <onboarding@resend.dev>',
      to: [NOTIFY_EMAIL],
      subject: `Marktanalyse ${new Date(analysis.generatedAt).toLocaleDateString('nl-NL')}`,
      html
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('E-mail versturen mislukt:', errText);
    // Bewust geen process.exit(1) — een mislukte e-mail mag de workflow niet laten falen
    return;
  }

  console.log('Notificatie-e-mail verstuurd naar', NOTIFY_EMAIL);
}

main().catch(err => console.error('Notificatiescript gefaald (niet-blokkerend):', err));
