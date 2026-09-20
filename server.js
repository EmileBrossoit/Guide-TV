const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DIR = __dirname;

// ──────────────────────────────────────────────
// CONFIGURATION DES CHAÎNES
// Source : TV Passport sitemap.stations.xml (IDs vérifiés)
// ──────────────────────────────────────────────
const CHANNELS = [
  { id: 'rds',                name: 'RDS',                slug: 'rds-reseau-des-sports', tvpId: 47   },
  { id: 'rds2',               name: 'RDS 2',              slug: 'rds-2',                 tvpId: 9705 },
  { id: 'tva-sports',         name: 'TVA Sports',         slug: 'tva-sports',            tvpId: 9823 },
  { id: 'tva-sports-2',       name: 'TVA Sports 2',       slug: 'tva-sports-2',          tvpId: 13777},
  { id: 'tsn1',               name: 'TSN 1',              slug: 'tsn1',                  tvpId: 11   },
  { id: 'tsn2',               name: 'TSN 2',              slug: 'tsn2',                  tvpId: 4294 },
  { id: 'tsn3',               name: 'TSN 3',              slug: 'tsn3',                  tvpId: 13719},
  { id: 'tsn4',               name: 'TSN 4',              slug: 'tsn4',                  tvpId: 279  },
  { id: 'tsn5',               name: 'TSN 5',              slug: 'tsn5',                  tvpId: 278  },
  { id: 'sportsnet-ontario',  name: 'Sportsnet Ontario',  slug: 'sportsnet-ontario',     tvpId: 254  },
  { id: 'sportsnet-east',     name: 'Sportsnet Est',      slug: 'sportsnet-east',        tvpId: 255  },
  { id: 'sportsnet-west',     name: 'Sportsnet Ouest',    slug: 'sportsnet-west',        tvpId: 252  },
  { id: 'sportsnet-pacific',  name: 'Sportsnet Pacifique',slug: 'sportsnet-pacific',     tvpId: 314  },
  { id: 'sportsnet-360',      name: 'Sportsnet 360',      slug: 'sportsnet-360',         tvpId: 336  },
];

// Cache global EPG
let cachedLiveEpg = {
  updatedAt: null,
  channels: {}
};

// ──────────────────────────────────────────────
// SCRAPER TV PASSPORT — MÉTHODE DIRECTE
// TV Passport génère son guide entièrement côté serveur.
// Les données sont encodées dans les attributs data-* des éléments HTML.
// URL: /tv-listings/stations/{slug}/{id}/{YYYY-MM-DD}
// ──────────────────────────────────────────────

function getTodayDateString() {
  // Garantit la date exacte YYYY-MM-DD au fuseau horaire America/Toronto (Québec),
  // même si le serveur d'hébergement est dans le cloud avec une horloge UTC.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

/**
 * Convertit "2026-09-20 14:30:00" → "14:30"
 * Les heures de TV Passport sont déjà en heure locale America/Toronto.
 */
function parseLocalTime(datetime) {
  if (!datetime) return '';
  const timePart = datetime.split(' ')[1] || '';
  return timePart.slice(0, 5); // HH:MM
}

/**
 * Calcule l'heure de fin à partir de l'heure de début et de la durée en minutes.
 */
function computeEndTime(startDatetime, durationMinutes) {
  if (!startDatetime || !durationMinutes) return '';
  const [datePart, timePart] = startDatetime.split(' ');
  const [h, m] = (timePart || '00:00').split(':').map(Number);
  const totalMinutes = h * 60 + m + parseInt(durationMinutes, 10);
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/**
 * Extrait tous les programmes depuis le HTML de TV Passport.
 * Cherche les attributs data-* dans les éléments list-group-item.
 */
function parseScheduleFromHTML(html, channelName) {
  const programs = [];

  // Regex pour extraire chaque bloc list-group-item avec ses attributs data-*
  const itemRegex = /class="list-group-item"([^>]*?)>/g;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const attrs = match[1];

    const get = (key) => {
      const r = new RegExp(`data-${key}="([^"]*)"`, 'i');
      const m = attrs.match(r);
      return m ? m[1] : '';
    };

    const startDatetime = get('st');
    const duration     = get('duration');
    const showName     = get('showName');
    const episodeTitle = get('episodeTitle');
    const description  = get('description');
    const live         = get('live');
    const league       = get('league');
    const team1        = get('team1');
    const team2        = get('team2');
    const showType     = get('showType');

    if (!startDatetime || !showName) continue;

    const startTime = parseLocalTime(startDatetime);
    const endTime   = computeEndTime(startDatetime, duration);

    // Construire un titre complet
    let title = showName;
    if (team1 && team2) {
      title = `${showName}: ${team1} vs ${team2}`;
    } else if (episodeTitle) {
      title = `${showName} — ${episodeTitle}`;
    }

    // Décoder les entités HTML basiques
    title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const desc = (description || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    programs.push({
      start:     startTime,
      end:       endTime,
      title:     title,
      desc:      desc || `Programmation sur ${channelName}`,
      cat:       showType || 'Sport',
      isLive:    live === '1',
      league:    league,
      team1:     team1,
      team2:     team2,
    });
  }

  return programs;
}

/**
 * Récupère le guide d'une seule chaîne depuis TV Passport.
 */
async function fetchChannelSchedule(channel, dateStr) {
  const url = `https://www.tvpassport.com/tv-listings/stations/${channel.slug}/${channel.tvpId}/${dateStr}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[TVP] ${channel.name}: HTTP ${res.status} — ${url}`);
      return [];
    }

    const html = await res.text();

    // Vérifier que la page contient bien des données de programmation
    if (!html.includes('list-group-item') || !html.includes('data-st=')) {
      console.warn(`[TVP] ${channel.name}: Aucune donnée de programmation trouvée.`);
      return [];
    }

    const programs = parseScheduleFromHTML(html, channel.name);
    console.log(`[TVP] ${channel.name}: ${programs.length} émissions chargées.`);
    return programs;

  } catch (err) {
    console.warn(`[TVP] ${channel.name}: Erreur — ${err.message}`);
    return [];
  }
}

/**
 * Synchronise le guide complet pour toutes les chaînes.
 * Traitement séquentiel pour éviter d'être bloqué par le serveur.
 */
async function fetchAllEPG() {
  console.log('[EPG] Début de la synchronisation du guide TV...');

  const dateStr = getTodayDateString();
  const result = {};

  // Initialiser les chaînes vides
  for (const ch of CHANNELS) {
    result[ch.id] = [];
  }

  // Traiter les chaînes en parallèle (par groupes de 3 pour éviter le throttling)
  const batchSize = 3;
  for (let i = 0; i < CHANNELS.length; i += batchSize) {
    const batch = CHANNELS.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(ch => fetchChannelSchedule(ch, dateStr))
    );
    batch.forEach((ch, idx) => {
      result[ch.id] = results[idx];
    });

    // Petite pause entre les groupes pour être respectueux du serveur
    if (i + batchSize < CHANNELS.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const totalPrograms = Object.values(result).reduce((sum, progs) => sum + progs.length, 0);
  console.log(`[EPG] Synchronisation terminée : ${totalPrograms} émissions pour ${CHANNELS.length} chaînes.`);

  cachedLiveEpg = {
    updatedAt: new Date().toISOString(),
    channels: result
  };
}

// ──────────────────────────────────────────────
// DÉMARRAGE ET ACTUALISATION AUTOMATIQUE
// ──────────────────────────────────────────────

// Première synchronisation au démarrage
fetchAllEPG().catch(err => console.error('[EPG] Erreur initiale:', err));

// Actualisation toutes les 5 minutes
setInterval(() => {
  fetchAllEPG().catch(err => console.error('[EPG] Erreur de synchronisation:', err));
}, 5 * 60 * 1000);

// ──────────────────────────────────────────────
// SERVEUR HTTP
// ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const cleanUrl = req.url.split('?')[0];

  // API Endpoint pour le guide en direct
  if (cleanUrl === '/api/live-epg.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(cachedLiveEpg));
    return;
  }

  // Servir les fichiers statiques
  const relativePath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\//, '');
  let filePath = path.join(DIR, relativePath);
  if (!fs.existsSync(filePath)) {
    if (relativePath.startsWith('logos/')) {
      const rootCandidate = path.join(DIR, path.basename(relativePath));
      if (fs.existsSync(rootCandidate)) filePath = rootCandidate;
    } else {
      const logoCandidate = path.join(DIR, 'logos', relativePath);
      if (fs.existsSync(logoCandidate)) filePath = logoCandidate;
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier non trouvé');
    } else {
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'text/html; charset=utf-8';
      if (ext === '.css')  contentType = 'text/css; charset=utf-8';
      if (ext === '.js')   contentType = 'application/javascript; charset=utf-8';
      if (ext === '.svg')  contentType = 'image/svg+xml';
      if (ext === '.png')  contentType = 'image/png';
      if (ext === '.ico')  contentType = 'image/x-icon';
      if (ext === '.json') contentType = 'application/json; charset=utf-8';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Serveur TV Guide actif sur http://localhost:${PORT}`);
  console.log(`Chaînes configurées : ${CHANNELS.map(c => c.name).join(', ')}`);
});
