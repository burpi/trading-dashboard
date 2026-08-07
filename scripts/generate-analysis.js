// Dit script roept de Gemini API aan met Google Search grounding ingeschakeld, vraagt om een
// gestructureerde marktanalyse, en schrijft het resultaat naar data/analysis.json.
// Het draait automatisch 2x per dag via .github/workflows/ai-analyse.yml

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Fout: GEMINI_API_KEY ontbreekt. Zet deze als GitHub Secret.');
  process.exit(1);
}

const GEMINI_MODEL = 'gemini-3.6-flash';

// Optioneel: Twelve Data geeft exacte live koersen (forex, indices, grondstoffen, crypto)
// i.p.v. dat het model op basis van web search moet gokken. Zonder deze key valt het
// script terug op alleen web search + de gratis forex/crypto-bronnen voor verificatie.
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || null;

// Curated watchlist die vóór elke run als live snapshot wordt opgehaald (indien key aanwezig)
const WATCHLIST = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD', 'WTI/USD',
  'SPX', 'DJI', 'NDX', 'DAX', 'BTC/USD', 'ETH/USD'
];

async function fetchTwelveDataSnapshot(symbols) {
  if (!TWELVE_DATA_API_KEY) return null;
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${TWELVE_DATA_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    // Bij meerdere symbolen: object per symbool. Bij één symbool: direct het quote-object.
    return symbols.length === 1 ? { [symbols[0]]: data } : data;
  } catch (e) {
    console.warn('Kon Twelve Data snapshot niet ophalen:', e.message);
    return null;
  }
}

function formatSnapshotForPrompt(snapshot) {
  if (!snapshot) return null;
  const lines = Object.entries(snapshot)
    .filter(([, q]) => q && q.close && !q.code) // q.code = foutrespons van Twelve Data
    .map(([symbol, q]) => {
      const change = q.percent_change ? ` (${parseFloat(q.percent_change) >= 0 ? '+' : ''}${q.percent_change}% t.o.v. vorige close)` : '';
      return `- ${symbol}: ${q.close}${change}`;
    });
  return lines.length ? lines.join('\n') : null;
}

async function fetchTwelveDataPrice(symbol) {
  if (!TWELVE_DATA_API_KEY || !symbol) return null;
  try {
    const res = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_DATA_API_KEY}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch (e) {
    console.warn(`Twelve Data prijs ophalen mislukt voor ${symbol}:`, e.message);
    return null;
  }
}

const SYSTEM_PROMPT = `Je bent een marktanalist die een kort, feitelijk overzicht geeft van kansrijke
setups over de brede markt: forex, aandelenindices, grondstoffen en crypto.

Gebruik web search om actueel nieuws en context op te zoeken. Als je een live-koersen-snapshot
in het bericht krijgt, gebruik die exacte cijfers als waarheid voor de huidige prijs van die
instrumenten — verzin nooit een eigen prijs voor iets dat al in de snapshot staat. Voor
instrumenten die niet in de snapshot staan: gebruik web search, en als je ook dan geen
betrouwbare actuele prijs kunt vinden, laat dat instrument dan weg.

Belangrijk — hoge-impact nieuwsmomenten: zoek actief naar geplande hoge-impact economische
gebeurtenissen (bv. rentebesluiten, NFP, CPI-cijfers, centrale bank-toespraken) in de komende
24 uur die relevante instrumenten kunnen raken. Als zo'n gebeurtenis dicht op de huidige tijd
ligt, wees dan extra terughoudend: gebruik ruimere stop-losses, vermijd instrumenten die daar
zeer gevoelig voor zijn, of laat een suggestie weg als de onzekerheid te groot is om een
zinvol niveau te geven. Vermeld in de rationale kort als een suggestie hierdoor beïnvloed is.

Geef ALLEEN geldige JSON terug, niets anders (geen markdown, geen uitleg eromheen), in dit format:

{
  "generatedAt": "ISO-8601 timestamp",
  "marketSummary": "2-3 zinnen algemeen marktbeeld",
  "suggestions": [
    {
      "instrument": "Leesbare naam, bv. 'EUR/USD' of 'DAX 40'",
      "dataSymbol": "Het exacte Twelve Data-compatibele symbool voor dit instrument, bv. 'EUR/USD', 'XAU/USD', 'SPX', 'BTC/USD'. Gebruik het symbool uit de snapshot als het instrument daarin voorkomt.",
      "assetClass": "forex | index | commodity | crypto",
      "direction": "LONG | SHORT",
      "entry": number,
      "stopLoss": number,
      "target": number,
      "rationale": "1-2 zinnen onderbouwing, feitelijk, geen overdreven zekerheid"
    }
  ],
  "disclaimer": "Dit is automatisch gegenereerde AI-analyse, geen financieel advies. Doe altijd je eigen onderzoek en beheer je risico.",
  "blogTitle": "Een korte, pakkende titel voor dit analyse-artikel (bv. 'EUR/USD test belangrijke weerstand voor NFP')",
  "blogBody": "Een leesbaar artikel van 250-400 woorden in het Nederlands, geschreven als een marktupdate voor een breed publiek van particuliere traders. Bouw het op met: een korte intro over het algemene sentiment, een paragraaf per belangrijke asset class die je noemt in suggestions, en een korte afsluiting. Gebruik geen markdown-koppen, gewoon lopende tekst in alinea's gescheiden door dubbele newlines. Wees feitelijk en vermijd overdreven zekere taal ('gaat stijgen' -> 'zou kunnen testen')."
}

Geef maximaal 6 suggesties, verspreid over verschillende asset classes indien relevant.`;

// ==========================================
// Trackrecord: verifieert eerdere open suggesties tegen actuele koersen
// ==========================================
const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
  ADA: 'cardano', DOGE: 'dogecoin', BNB: 'binancecoin', LTC: 'litecoin'
};

function parseForexPair(instrument) {
  const match = (instrument || '').toUpperCase().match(/([A-Z]{3})\s*\/\s*([A-Z]{3})/);
  return match ? { base: match[1], quote: match[2] } : null;
}

function parseCryptoSymbol(instrument) {
  const match = (instrument || '').toUpperCase().match(/([A-Z]+)\s*\/\s*(USD|USDT|EUR)/);
  if (!match) return null;
  const id = CRYPTO_ID_MAP[match[1]];
  return id ? { id, vsCurrency: match[2].toLowerCase() === 'eur' ? 'eur' : 'usd' } : null;
}

async function fetchCurrentPrice(entry) {
  // 1) Twelve Data eerst proberen indien beschikbaar — werkt voor alle asset classes,
  //    mits het model een dataSymbol heeft meegegeven.
  if (TWELVE_DATA_API_KEY && entry.dataSymbol) {
    const price = await fetchTwelveDataPrice(entry.dataSymbol);
    if (price !== null) return price;
    // val door naar de gratis fallback hieronder als Twelve Data niets teruggaf
  }

  try {
    if (entry.assetClass === 'forex') {
      const pair = parseForexPair(entry.instrument);
      if (!pair) return null;
      const res = await fetch(`https://api.frankfurter.app/latest?from=${pair.base}&to=${pair.quote}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.rates ? data.rates[pair.quote] : null;
    }
    if (entry.assetClass === 'crypto') {
      const parsed = parseCryptoSymbol(entry.instrument);
      if (!parsed) return null;
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${parsed.id}&vs_currencies=${parsed.vsCurrency}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data[parsed.id] ? data[parsed.id][parsed.vsCurrency] : null;
    }
  } catch (e) {
    console.warn(`Kon huidige prijs niet ophalen voor ${entry.instrument}:`, e.message);
  }
  return null; // index/commodity zonder Twelve Data: geen gratis live bron, blijft 'onbevestigd'
}

const MAX_OPEN_DAYS = 14; // na deze periode zonder resultaat: als 'verlopen' markeren

async function resolvePendingEntries(trackRecord) {
  const now = Date.now();
  for (const entry of trackRecord) {
    if (entry.status !== 'open') continue;

    const canVerify = entry.assetClass === 'forex' || entry.assetClass === 'crypto' ||
      (TWELVE_DATA_API_KEY && entry.dataSymbol);

    if (!canVerify) {
      entry.status = 'onbevestigd'; // geen databron beschikbaar om te verifiëren
      continue;
    }

    const currentPrice = await fetchCurrentPrice(entry);
    if (currentPrice === null) continue; // kon niet ophalen, probeer volgende run opnieuw

    const hitTarget = entry.direction === 'LONG' ? currentPrice >= entry.target : currentPrice <= entry.target;
    const hitStopLoss = entry.direction === 'LONG' ? currentPrice <= entry.stopLoss : currentPrice >= entry.stopLoss;

    if (hitTarget) {
      entry.status = 'win';
      entry.resolvedAt = new Date(now).toISOString();
      entry.resolvedPrice = currentPrice;
    } else if (hitStopLoss) {
      entry.status = 'loss';
      entry.resolvedAt = new Date(now).toISOString();
      entry.resolvedPrice = currentPrice;
    } else if (now - new Date(entry.generatedAt).getTime() > MAX_OPEN_DAYS * 24 * 60 * 60 * 1000) {
      entry.status = 'verlopen';
      entry.resolvedAt = new Date(now).toISOString();
      entry.resolvedPrice = currentPrice;
    }
  }
  return trackRecord;
}

// ==========================================
// Feedback-loop: bouwt een prestatie-samenvatting op basis van het trackrecord
// ==========================================
function buildPerformanceSummary(trackRecord) {
  const resolved = trackRecord
    .filter(e => e.status === 'win' || e.status === 'loss')
    .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))
    .slice(0, 20);

  if (resolved.length < 5) {
    // Te weinig data om betekenisvolle patronen uit te halen — geef dit expliciet aan
    // i.p.v. het model te laten concluderen op een handjevol samples.
    return `Prestatiegeschiedenis: nog te weinig afgeronde suggesties (${resolved.length}) om patronen uit te
halen. Behandel dit als een nieuw trackrecord en wees niet extra voorzichtig of agressief op basis hiervan.`;
  }

  const wins = resolved.filter(e => e.status === 'win').length;
  const winRate = Math.round((wins / resolved.length) * 100);

  const byClass = {};
  const byDirection = {};
  resolved.forEach(e => {
    byClass[e.assetClass] = byClass[e.assetClass] || { wins: 0, total: 0 };
    byClass[e.assetClass].total++;
    if (e.status === 'win') byClass[e.assetClass].wins++;

    byDirection[e.direction] = byDirection[e.direction] || { wins: 0, total: 0 };
    byDirection[e.direction].total++;
    if (e.status === 'win') byDirection[e.direction].wins++;
  });

  const classLines = Object.entries(byClass)
    .map(([cls, s]) => `- ${cls}: ${s.wins}/${s.total} win (${Math.round((s.wins / s.total) * 100)}%)`)
    .join('\n');
  const dirLines = Object.entries(byDirection)
    .map(([dir, s]) => `- ${dir}: ${s.wins}/${s.total} win (${Math.round((s.wins / s.total) * 100)}%)`)
    .join('\n');

  return `Prestatie-overzicht van je laatste ${resolved.length} afgeronde suggesties:
Algehele winrate: ${winRate}% (${wins}/${resolved.length})

Per asset class:
${classLines}

Per richting:
${dirLines}

Gebruik dit uitsluitend als context om je risico-inschatting te kalibreren (bijvoorbeeld: extra kritisch
zijn op setups in een categorie met een lage winrate, of het aantal suggesties in die categorie beperken).
Dit is een klein sample — trek er geen overtuigde conclusies uit en verzin geen patroon dat er niet is.
Blijf primair redeneren vanuit de actuele marktomstandigheden, niet vanuit deze geschiedenis.`;
}

async function main() {
  const rootDir = path.join(__dirname, '..');

  // 0) Trackrecord laden en eerdere open suggesties verifiëren tegen actuele koersen,
  //    vóórdat we het model om nieuwe suggesties vragen — zo kan het resultaat meegegeven
  //    worden als context.
  const trackRecordPath = path.join(rootDir, 'data', 'track-record.json');
  let trackRecord = [];
  if (fs.existsSync(trackRecordPath)) {
    try {
      trackRecord = JSON.parse(fs.readFileSync(trackRecordPath, 'utf-8'));
    } catch (e) {
      console.warn('Kon bestaand track-record.json niet lezen, begin opnieuw.');
    }
  }
  trackRecord = await resolvePendingEntries(trackRecord);
  const performanceSummary = buildPerformanceSummary(trackRecord);

  // Live snapshot ophalen (indien Twelve Data-key aanwezig) om als grondwaarheid mee te geven
  const snapshot = await fetchTwelveDataSnapshot(WATCHLIST);
  const snapshotText = formatSnapshotForPrompt(snapshot);
  const snapshotBlock = snapshotText
    ? `Live-koersen-snapshot (Twelve Data, zojuist opgehaald):\n${snapshotText}\n`
    : `(Geen live-koersen-snapshot beschikbaar dit keer — gebruik web search voor actuele prijzen.)\n`;

  const userMessage = `Geef de marktanalyse van dit moment volgens het opgegeven JSON-format.

Huidige datum en tijd (UTC): ${new Date().toISOString()}

${snapshotBlock}
${performanceSummary}`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': API_KEY
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        { role: 'user', parts: [{ text: userMessage }] }
      ],
      tools: [
        { google_search: {} }
      ],
      generationConfig: {
        maxOutputTokens: 4096
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API fout (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) {
    throw new Error(`Gemini gaf geen candidates terug: ${JSON.stringify(data)}`);
  }

  // Pak alle tekst-onderdelen samen (grounding kan meerdere parts opleveren)
  const fullText = (candidate.content?.parts || [])
    .filter(part => typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');

  // Strip eventuele markdown-fences als het model die per ongeluk toch toevoegt
  const cleaned = fullText.replace(/```json/g, '').replace(/```/g, '').trim();

  let analysis;
  try {
    analysis = JSON.parse(cleaned);
  } catch (e) {
    console.error('Kon modelresponse niet als JSON parsen:', cleaned);
    throw e;
  }

  // Failsafe: als het model geen timestamp gaf, vullen we die zelf in
  if (!analysis.generatedAt) {
    analysis.generatedAt = new Date().toISOString();
  }

  // 1) Laatste analyse wegschrijven (dit leest het dashboard)
  const latestPath = path.join(rootDir, 'data', 'analysis.json');
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.writeFileSync(latestPath, JSON.stringify(analysis, null, 2));
  console.log('Analyse succesvol weggeschreven naar', latestPath);

  // 2) Archiveren onder een unieke, datum-gebaseerde bestandsnaam
  const dt = new Date(analysis.generatedAt);
  const slugDate = dt.toISOString().slice(0, 16).replace(/[:T]/g, '-'); // bv. 2026-08-05-0600
  const archiveDir = path.join(rootDir, 'data', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${slugDate}.json`), JSON.stringify(analysis, null, 2));

  // 3) Blogpost wegschrijven (los bestand + index bijwerken)
  const blogPost = {
    slug: slugDate,
    title: analysis.blogTitle || 'Marktupdate ' + dt.toLocaleDateString('nl-NL'),
    date: analysis.generatedAt,
    summary: analysis.marketSummary || '',
    body: analysis.blogBody || '',
    suggestionCount: (analysis.suggestions || []).length,
    disclaimer: analysis.disclaimer || ''
  };

  const blogPostsDir = path.join(rootDir, 'blog', 'posts');
  fs.mkdirSync(blogPostsDir, { recursive: true });
  fs.writeFileSync(path.join(blogPostsDir, `${slugDate}.json`), JSON.stringify(blogPost, null, 2));

  const indexPath = path.join(rootDir, 'blog', 'index.json');
  let index = [];
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch (e) {
      console.warn('Kon bestaande blog/index.json niet lezen, begin opnieuw.');
    }
  }
  index.unshift({ slug: blogPost.slug, title: blogPost.title, date: blogPost.date, summary: blogPost.summary });
  // Houd de index gesorteerd op datum, nieuwste eerst
  index.sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log('Blogpost en archief bijgewerkt:', slugDate);

  // 4) Nieuwe suggesties toevoegen aan het trackrecord (de open entries zijn al
  //    hierboven, vóór de API-call, geverifieerd)
  for (const s of (analysis.suggestions || [])) {
    trackRecord.push({
      id: `${slugDate}-${s.instrument}`.replace(/[^\w-]/g, ''),
      instrument: s.instrument,
      dataSymbol: s.dataSymbol || null,
      assetClass: s.assetClass,
      direction: s.direction,
      entry: s.entry,
      stopLoss: s.stopLoss,
      target: s.target,
      generatedAt: analysis.generatedAt,
      status: 'open',
      resolvedAt: null,
      resolvedPrice: null
    });
  }

  fs.writeFileSync(trackRecordPath, JSON.stringify(trackRecord, null, 2));
  console.log('Trackrecord bijgewerkt, totaal aantal entries:', trackRecord.length);
}

main().catch(err => {
  console.error('Script gefaald:', err);
  process.exit(1);
});
