require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const { createClient } = require('@supabase/supabase-js');
const path     = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Serve o painel admin (index.html e assets)
app.use(express.static(path.join(__dirname, 'admin')));
// Rota raiz explícita para garantir no Vercel
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

const supabase          = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD    || 'admin123';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

// ── Busca usuario no Discord ──────────────────────────────────────────────────
function fetchDiscordUser(discord_id) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/users/${discord_id}`,
      method: 'GET',
      headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}`, 'User-Agent': 'NovaCheats/1.0' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j.id ? j : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Formata data para exibicao ────────────────────────────────────────────────
// Retorna "DD/MM/YYYY" ou "Vitalicio"
function formatExpiry(expires_at) {
  if (!expires_at) return 'Vitalicio';
  const d = new Date(expires_at);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── POST /api/auth ────────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id || typeof discord_id !== 'string')
    return res.status(400).json({ success: false, message: 'discord_id invalido.' });

  const { data, error } = await supabase
    .from('users')
    .select('discord_id, discord_username, discord_avatar_hash, ativo, expires_at, hwid, hwid_locked')
    .eq('discord_id', discord_id.trim())
    .single();

  if (error || !data)
    return res.status(200).json({ success: false, message: 'ID nao autorizado.' });

  if (!data.ativo)
    return res.status(200).json({ success: false, message: 'Acesso desativado.' });

  if (data.expires_at && new Date(data.expires_at) < new Date())
    return res.status(200).json({ success: false, message: 'Acesso expirado.' });

  // ── HWID check ────────────────────────────────────────────────────────────
  const hwid = (req.body.hwid || '').trim();

  if (data.hwid_locked)
    return res.status(200).json({ success: false, message: 'Conta bloqueada por HWID invalido. Contate o suporte.' });

  if (!data.hwid) {
    // Primeiro login — registra o HWID
    if (hwid) {
      await supabase.from('users').update({ hwid }).eq('discord_id', discord_id.trim());
    }
  } else {
    // HWID ja registrado — valida
    if (hwid && hwid !== data.hwid) {
      // HWID diferente — bloqueia a conta
      await supabase.from('users').update({ hwid_locked: true }).eq('discord_id', discord_id.trim());
      return res.status(200).json({ success: false, message: 'HWID invalido. Conta bloqueada.' });
    }
  }

  // Atualiza nome e avatar do Discord em tempo real a cada login
  let username   = data.discord_username;
  let avatarHash = data.discord_avatar_hash;

  if (DISCORD_BOT_TOKEN) {
    const du = await fetchDiscordUser(discord_id.trim());
    if (du) {
      const newName   = du.global_name || du.username || username;
      const newAvatar = du.avatar || avatarHash;
      // Salva no banco se algo mudou
      if (newName !== username || newAvatar !== avatarHash) {
        await supabase.from('users').update({
          discord_username:    newName,
          discord_avatar_hash: newAvatar
        }).eq('discord_id', discord_id.trim());
      }
      username   = newName;
      avatarHash = newAvatar;
    }
  }

  // Monta avatar URL
  let avatar_url = '';
  if (avatarHash) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
    avatar_url = `https://cdn.discordapp.com/avatars/${data.discord_id}/${avatarHash}.${ext}?size=128`;
  } else {
    const idx = (BigInt(data.discord_id) >> 22n) % 6n;
    avatar_url = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }

  return res.status(200).json({
    success:    true,
    username,
    avatar_url,
    expires_at: formatExpiry(data.expires_at),
    message:    'Autorizado.'
  });
});

// ── POST /api/admin/add ───────────────────────────────────────────────────────
// Body: { password, discord_id, discord_username?, discord_avatar_hash?, expires_at? }
// expires_at: "2026-12-31" ou null/vazio = vitalicio
app.post('/api/admin/add', async (req, res) => {
  const { password, discord_id, discord_username, discord_avatar_hash, expires_at } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Senha incorreta.' });
  if (!discord_id)
    return res.status(400).json({ success: false, message: 'discord_id obrigatorio.' });

  let username   = discord_username  ? discord_username.trim()  : '';
  let avatarHash = discord_avatar_hash ? discord_avatar_hash.trim() : null;

  if (DISCORD_BOT_TOKEN) {
    const du = await fetchDiscordUser(discord_id.trim());
    if (du) {
      username   = du.global_name || du.username || username;
      avatarHash = du.avatar || avatarHash;
    }
  }

  if (!username)
    return res.status(400).json({ success: false, message: 'Nao foi possivel obter o username.' });

  // expires_at: null = vitalicio, string ISO = data de expiracao
  const expiresValue = (expires_at && expires_at.trim()) ? new Date(expires_at).toISOString() : null;

  const { error } = await supabase.from('users').upsert({
    discord_id:          discord_id.trim(),
    discord_username:    username,
    discord_avatar_hash: avatarHash,
    ativo:               true,
    expires_at:          expiresValue
  }, { onConflict: 'discord_id' });

  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, message: 'Usuario adicionado/atualizado.' });
});

// ── POST /api/admin/toggle ────────────────────────────────────────────────────
app.post('/api/admin/toggle', async (req, res) => {
  const { password, discord_id, ativo } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Senha incorreta.' });

  const { error } = await supabase.from('users').update({ ativo: Boolean(ativo) }).eq('discord_id', discord_id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, message: `Usuario ${ativo ? 'ativado' : 'desativado'}.` });
});

// ── POST /api/admin/remove ────────────────────────────────────────────────────
app.post('/api/admin/remove', async (req, res) => {
  const { password, discord_id } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Senha incorreta.' });

  const { error } = await supabase.from('users').delete().eq('discord_id', discord_id);
  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, message: 'Usuario removido.' });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Senha incorreta.' });

  const { data, error } = await supabase
    .from('users')
    .select('discord_id, discord_username, discord_avatar_hash, ativo, expires_at, hwid, hwid_locked')
    .order('discord_username');

  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, users: data });
});

// ── POST /api/admin/reset-hwid ────────────────────────────────────────────────
app.post('/api/admin/reset-hwid', async (req, res) => {
  const { password, discord_id } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ success: false, message: 'Senha incorreta.' });

  const { error } = await supabase
    .from('users')
    .update({ hwid: null, hwid_locked: false })
    .eq('discord_id', discord_id);

  if (error) return res.status(500).json({ success: false, message: error.message });
  return res.status(200).json({ success: true, message: 'HWID resetado.' });
});

// ── GET /api/ping ─────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.status(200).json({ status: 'ok', service: 'NovaCheats' }));

// Exporta para Vercel (serverless) e roda local normalmente
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`[NovaCheats] Server running on port ${PORT}`));
}

module.exports = app;
