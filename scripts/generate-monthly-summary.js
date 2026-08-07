// Draait 1x per maand (zie .github/workflows/maandoverzicht.yml) en schrijft een
// leesbaar samenvattend blogartikel op basis van de trackrecord-data van de afgelopen maand.
// Gebruikt GEEN web search — puur een herschrijving van de eigen cijfers naar leesbare tekst.

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Fout: ANTHROPIC_API_KEY ontbreekt. Zet deze als GitHub Secret.');
  process.exit(1);
}

function getPreviousMonthRange() {
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstOfPrevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start: firstOfPrevMonth, end: firstOfThisMonth };
}

function buildStats(entries) {
  const resolved = entries.filter(e => e.status === 'win' || e.status === 'loss');
  const wins = resolved.filter(e => e.status === 'win').length;
  const winRate = resolved.length ? Math.round((wins / resolved.length) * 100) : null;

  const byClass = {};
  entries.forEach(e => {
    byClass[e.assetClass] = byClass[e.assetClass] || { wins: 0, losses: 0, open: 0, other: 0 };
    if (e.status === 'win') byClass[e.assetClass].wins++;
    else if (e.status === 'loss') byClass[e.assetClass].losses++;
    else if (e.status === 'open') byClass[e.assetClass].open++;
    else byClass[e.assetClass].other++;
  });

  return {
    totalSuggestions: entries.length,
    resolved: resolved.length,
    wins,
    losses: resolved.length - wins,
    winRatePercent: winRate,
    byAssetClass: byClass
  };
}

async function main() {
  const rootDir = path.join(__dirname, '..');
  const trackRecordPath = path.join(rootDir, 'data', 'track-record.json');

  if (!fs.existsSync(trackRecordPath)) {
    console.log('Nog geen track-record.json aanwezig — maandoverzicht overgeslagen.');
    return;
  }

  const trackRecord = JSON.parse(fs.readFileSync(trackRecordPath, 'utf-8'));
  const { start, end } = getPreviousMonthRange();
  const monthEntries = trackRecord.filter(e => {
    const d = new Date(e.generatedAt);
    return d >= start && d < end;
  });

  if (monthEntries.length === 0) {
    console.log('Geen suggesties gevonden in de vorige maand — maandoverzicht overgeslagen.');
    return;
  }

  const stats = buildStats(monthEntries);
  const monthLabel = start.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const systemPrompt = `Je schrijft een eerlijk, feitelijk maandoverzicht van AI-gegenereerde tradesuggesties voor
een blog gericht op particuliere traders. Gebruik ALLEEN de cijfers die je krijgt — verzin niets extra's.
Wees nuchter: bij een lage winrate niet vergoelijken, bij een hoge winrate niet overdreven positief doen
("dit garandeert niets voor de toekomst" hoort er standaard bij). Kleine steekproeven (minder dan 30
afgeronde suggesties) moet je expliciet benoemen als statistisch nog niet betrouwbaar.

Geef ALLEEN geldige JSON terug, in dit format:
{
  "title": "Korte titel, bv. 'Maandoverzicht november: winrate en lessen'",
  "body": "300-450 woorden lopende tekst in het Nederlands, alinea's gescheiden door dubbele newlines, geen markdown-koppen.",
  "disclaimer": "Automatisch gegenereerd maandoverzicht op basis van het trackrecord. Geen financieel advies en geen garantie voor toekomstige resultaten."
}`;

  const userMessage = `Schrijf het maandoverzicht voor ${monthLabel} op basis van deze cijfers:\n\n${JSON.stringify(stats, null, 2)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API fout (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const fullText = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = fullText.replace(/```json/g, '').replace(/```/g, '').trim();

  let summary;
  try {
    summary = JSON.parse(cleaned);
  } catch (e) {
    console.error('Kon maandoverzicht-response niet als JSON parsen:', cleaned);
    throw e;
  }

  const slug = `maandoverzicht-${start.toISOString().slice(0, 7)}`; // bv. maandoverzicht-2026-07
  const blogPost = {
    slug,
    type: 'maandoverzicht',
    title: summary.title || `Maandoverzicht ${monthLabel}`,
    date: new Date().toISOString(),
    summary: `Winrate ${stats.winRatePercent ?? '–'}% over ${stats.resolved} afgeronde suggesties in ${monthLabel}.`,
    body: summary.body || '',
    disclaimer: summary.disclaimer || 'Automatisch gegenereerd maandoverzicht, geen financieel advies.',
    stats
  };

  const blogPostsDir = path.join(rootDir, 'blog', 'posts');
  fs.mkdirSync(blogPostsDir, { recursive: true });
  fs.writeFileSync(path.join(blogPostsDir, `${slug}.json`), JSON.stringify(blogPost, null, 2));

  const indexPath = path.join(rootDir, 'blog', 'index.json');
  let index = [];
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch (e) { /* begin opnieuw */ }
  }
  index = index.filter(p => p.slug !== slug); // voorkom duplicaten bij herhaalde runs
  index.unshift({ slug, type: 'maandoverzicht', title: blogPost.title, date: blogPost.date, summary: blogPost.summary });
  index.sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log('Maandoverzicht gepubliceerd:', slug);
}

main().catch(err => {
  console.error('Maandoverzicht-script gefaald:', err);
  process.exit(1);
});
