// Draait ALLEEN als een vorige stap in de workflow gefaald is (zie de 'if: failure()'
// conditie in .github/workflows/ai-analyse.yml). Stuurt een korte waarschuwing zodat je
// merkt dat een run is overgeslagen, i.p.v. dat dit stilletjes gebeurt.
// Gebruikt dezelfde Resend-secrets als de gewone notificatie; zonder die secrets doet dit niets.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const RUN_URL = process.env.GITHUB_RUN_URL || '';

async function main() {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    console.log('RESEND_API_KEY of NOTIFY_EMAIL niet ingesteld — foutmelding kon niet verstuurd worden per e-mail. Check de Actions-log op GitHub voor details.');
    return;
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 600px;">
      <h2 style="color:#e11d48;">AI Marktanalyse — run mislukt</h2>
      <p>De geplande analyse-run is niet gelukt op ${new Date().toLocaleString('nl-NL')}.</p>
      <p>De vorige analyse op het dashboard blijft gewoon zichtbaar totdat de volgende run wel lukt.</p>
      ${RUN_URL ? `<p><a href="${RUN_URL}">Bekijk de foutmelding in de GitHub Actions-log</a></p>` : ''}
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || 'Trader Pro <onboarding@resend.dev>',
        to: [NOTIFY_EMAIL],
        subject: 'AI Marktanalyse: run mislukt',
        html
      })
    });

    if (!response.ok) {
      console.error('Foutmelding-e-mail versturen mislukt:', await response.text());
      return;
    }
    console.log('Foutmelding-e-mail verstuurd naar', NOTIFY_EMAIL);
  } catch (e) {
    console.error('Kon foutmelding niet versturen:', e);
  }
}

main();
