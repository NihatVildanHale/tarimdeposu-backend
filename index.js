require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = 3000;
const TOKENS_FILE = './tokens.json';

const {
  IDEA_CLIENT_ID,
  IDEA_CLIENT_SECRET,
  IDEA_REDIRECT_URI,
  SHOP_URL,
  GITHUB_TOKEN,
  GIST_ID,
} = process.env;

// Gist'ten en güncel token'ı okur
async function loadTokensFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return null;

  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      console.error('Gist okunamadı:', res.status);
      return null;
    }

    const gist = await res.json();
    const content = gist.files['tokens.json']?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!parsed.refresh_token) return null;

    console.log('Gist üzerinden token bulundu, yükleniyor.');
    return parsed;
  } catch (e) {
    console.error('Gist okuma hatası:', e.message);
    return null;
  }
}

// Güncel token'ı Gist'e yazar (Render'ı hiç tetiklemez, yeniden başlatma yapmaz)
async function saveTokensToGist(t) {
  if (!GITHUB_TOKEN || !GIST_ID) return;

  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          'tokens.json': {
            content: JSON.stringify(t, null, 2),
          },
        },
      }),
    });

    if (res.ok) {
      console.log('Gist güncellendi.');
    } else {
      console.error('Gist güncelleme başarısız:', res.status);
    }
  } catch (e) {
    console.error('Gist güncelleme hatası:', e.message);
  }
}

function loadTokensLocal() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTokensLocal(t) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
}

let tokens = null;

// Açılışta önce Gist'e bak, yoksa yerel dosyaya, o da yoksa env variable'a
async function initTokens() {
  tokens = await loadTokensFromGist();

  if (!tokens) {
    tokens = loadTokensLocal();
    if (tokens) console.log('Yerel dosyadan token bulundu, yükleniyor.');
  }

  if (!tokens && process.env.IDEA_REFRESH_TOKEN) {
    console.log('Hiçbir yerde token yok, IDEA_REFRESH_TOKEN kullanılacak.');
    tokens = {
      refresh_token: process.env.IDEA_REFRESH_TOKEN,
      access_token: null,
      expiresAt: 0,
    };
  }
}

app.get('/oauth/start', (req, res) => {
  const state = Math.random().toString(36).substring(2);
  const url = `${SHOP_URL}/panel/auth`
    + `?response_type=code`
    + `&client_id=${IDEA_CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(IDEA_REDIRECT_URI)}`
    + `&state=${state}`;
  console.log('Yönlendiriliyor:', url);
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`Yetkilendirme hatası: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Code parametresi gelmedi.');
  }

  console.log('Code alındı:', code);

  try {
    const tokenRes = await fetch(`${SHOP_URL}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: IDEA_CLIENT_ID,
        client_secret: IDEA_CLIENT_SECRET,
        redirect_uri: IDEA_REDIRECT_URI,
        code,
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(500).send(`Token alınamadı: ${JSON.stringify(data)}`);
    }

    tokens = data;
    tokens.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
    saveTokensLocal(tokens);
    await saveTokensToGist(tokens);

    console.log('Token alındı ve kaydedildi.');
    res.send('Yetkilendirme başarılı! Bu sekmeyi kapatabilirsin, terminale dön.');
  } catch (e) {
    console.error(e);
    res.status(500).send('Beklenmeyen hata: ' + e.message);
  }
});

async function getValidAccessToken() {
  if (!tokens) return null;

  if (Date.now() < tokens.expiresAt) {
    return tokens.access_token;
  }

  console.log('Access token süresi dolmuş, yenileniyor...');

  const res = await fetch(`${SHOP_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: IDEA_CLIENT_ID,
      client_secret: IDEA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Token yenileme başarısız:', data);
    tokens = null;
    return null;
  }

  tokens = data;
  tokens.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
  saveTokensLocal(tokens);
  await saveTokensToGist(tokens);
  console.log('Token yenilendi ve kaydedildi.');

  return tokens.access_token;
}

app.get('/', (req, res) => {
  res.send('Backend çalışıyor. Yetkilendirme için /oauth/start adresine git.');
});

app.get('/product', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'code parametresi gerekli, örn: /product?code=ABC123' });
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli, /oauth/start adresine git' });
  }

  try {
    let list = await fetch(
      `${SHOP_URL}/api/products?sku=${encodeURIComponent(code)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then(r => r.json());

    if (!Array.isArray(list) || list.length === 0) {
      list = await fetch(
        `${SHOP_URL}/api/products?q=${encodeURIComponent(code)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ).then(r => r.json());
    }

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı' });
    }

    const p = list[0];
    const img = p.images?.[0];
    const imageUrl = img
      ? `https://www.tarimdeposu.com/idea/pe/08/myassets/products/${img.directoryName}/${img.filename}.${img.extension}?revision=${img.revision}`
      : null;

    const rawDetails = p.details?.[0]?.details || '';
    const description = rawDetails
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    res.json({
      name: p.fullName || p.name,
      sku: p.sku,
      barcode: p.barcode,
      price: p.price1,
      currency: p.currency?.label || 'TL',
      stock: p.stockAmount,
      image: imageUrl,
      description,
      brand: p.brand?.name || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hata: ' + e.message });
  }
});
app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'En az 2 karakterlik bir arama terimi girin' });
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return res.status(401).json({ error: 'Yetkilendirme gerekli, /oauth/start adresine git' });
  }

  try {
    const list = await fetch(
      `${SHOP_URL}/api/products?q=${encodeURIComponent(q.trim())}&limit=20`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ).then(r => r.json());

    if (!Array.isArray(list) || list.length === 0) {
      return res.json([]);
    }

    const results = list.map(p => {
      const img = p.images?.[0];
      const imageUrl = img
        ? `https://www.tarimdeposu.com/idea/pe/08/myassets/products/${img.directoryName}/${img.filename}.${img.extension}?revision=${img.revision}`
        : null;

      return {
        name: p.fullName || p.name,
        sku: p.sku,
        price: p.price1,
        currency: p.currency?.label || 'TL',
        stock: p.stockAmount,
        image: imageUrl,
        brand: p.brand?.name || null,
      };
    });

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Hata: ' + e.message });
  }
});

initTokens().then(() => {
  app.listen(PORT, () => {
    console.log(`Sunucu ayakta: http://localhost:${PORT}`);
  });
});