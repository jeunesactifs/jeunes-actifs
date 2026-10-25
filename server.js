const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const pgSession = require('connect-pg-simple')(session);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BASE_URL = 'https://jeunes-actifs.onrender.com';


async function envoyerEmail(destinataire, sujet, html) {
  if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM) {
    console.log('[labo] BREVO_API_KEY ou MAIL_FROM absent : aucun mail envoye.');
    return;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Jeunes Actifs', email: process.env.MAIL_FROM },
        to: [{ email: destinataire }],
        subject: sujet,
        htmlContent: html
      })
    });
    if (!res.ok) {
      console.error('Brevo email erreur :', res.status, await res.text());
    } else {
      console.log('[labo] Mail envoye a', destinataire);
    }
  } catch (err) {
    console.error('Brevo email erreur :', err.message);
  }
}

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.get('/jeunes-actifs.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'jeunes-actifs.html'))
);
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'jeunes-actifs.html'))
);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      prenom TEXT,
      nom TEXT,
      email TEXT,
      telephone TEXT,
      password TEXT,
      niveau TEXT,
      nationalite TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      id SERIAL PRIMARY KEY,
      email TEXT,
      token TEXT,
      confirmed INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      created_at BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidatures (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      titre TEXT NOT NULL,
      type TEXT,
      created_at BIGINT NOT NULL
    )
  `);
}

function motDePasseValide(p) {
  return typeof p === 'string'
    && p.length >= 8
    && p.length <= 128
    && /[A-Za-z]/.test(p)
    && /[0-9]/.test(p)
    && /[^A-Za-z0-9]/.test(p);
}

app.post('/signup', async (req, res) => {
  const { prenom, nom, email, telephone, password, niveau, nationalite } = req.body;

  if (!prenom || !nom || !email || !telephone || !password || !niveau || !nationalite) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (!motDePasseValide(password)) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères, une lettre, un chiffre et un caractère spécial." });
  }

  try {
    const existing = await pool.query(`SELECT * FROM accounts WHERE email = '${email}'`);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Un compte existe déjà avec cet e-mail." });
    }

    const result = await pool.query(`
      INSERT INTO accounts (prenom, nom, email, telephone, password, niveau, nationalite)
      VALUES ('${prenom}', '${nom}', '${email}', '${telephone}', '${password}', '${niveau}', '${nationalite}')
      RETURNING id
    `);

    return res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Impossible de créer le compte pour le moment. Réessayez." });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM accounts WHERE email = '${email}' AND password = '${password}'`
    );
    const row = rows[0];

    if (!row) {
      return res.status(401).json({ error: "Identifiants incorrects." });
    }

    req.session.email = row.email;
    return res.json({ success: true, account: row });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post('/reset-request', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Merci de renseigner votre e-mail." });
  }

  try {
    const { rows } = await pool.query(`SELECT * FROM accounts WHERE email = '${email}'`);

    if (rows.length > 0) {
      const token = crypto.randomBytes(32).toString('hex');
      const createdAt = Date.now();

      await pool.query(
        `INSERT INTO reset_tokens (email, token, confirmed, used, created_at)
         VALUES ('${email}', '${token}', 0, 0, ${createdAt})`
      );

      const confirmYesUrl = `${BASE_URL}/reset-confirm?token=${token}&answer=yes`;
      const confirmNoUrl = `${BASE_URL}/reset-confirm?token=${token}&answer=no`;

      console.log('Lien de confirmation :', confirmYesUrl);

      const html = `
        <p>Bonjour,</p>
        <p>Une demande de réinitialisation de mot de passe a été effectuée pour ce compte sur Jeunes Actifs.</p>
        <p>Si vous êtes à l'origine de cette demande, <a href="${confirmYesUrl}">cliquez ici pour confirmer</a>.</p>
        <p>Si vous n'êtes pas à l'origine de cette demande, <a href="${confirmNoUrl}">cliquez ici</a>.</p>
        <p>Ce lien expire dans 30 minutes.</p>
        <p>L'équipe Jeunes Actifs</p>
      `;

      envoyerEmail(email, 'Confirmation de réinitialisation de mot de passe — Jeunes Actifs', html);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});
-
app.get('/reset-confirm', async (req, res) => {
  const { token, answer } = req.query;

  if (!token || !answer) {
    return res.status(400).send('Lien invalide.');
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM reset_tokens WHERE token = '${token}' AND used = 0`
    );
    const row = rows[0];

    if (!row) {
      return res.status(404).send('Ce lien est invalide ou a déjà été utilisé.');
    }

    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - Number(row.created_at) > THIRTY_MINUTES) {
      return res.status(410).send('Ce lien a expiré. Merci de refaire une demande de réinitialisation.');
    }

    if (answer === 'no') {
      await pool.query(`UPDATE reset_tokens SET used = 1 WHERE token = '${token}'`);
      return res.send('Merci. Cette demande a été annulée, votre mot de passe reste inchangé.');
    }

    if (answer === 'yes') {
      await pool.query(`UPDATE reset_tokens SET confirmed = 1 WHERE token = '${token}'`);
      return res.redirect(`${BASE_URL}/jeunes-actifs.html?resetToken=${token}`);
    }

    return res.status(400).send('Réponse invalide.');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Une erreur est survenue.');
  }
});

app.post('/reset-submit', async (req, res) => {
  const { token, password, confirm } = req.body;

  if (!token || !password || !confirm) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (!motDePasseValide(password)) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères, une lettre, un chiffre et un caractère spécial." });
  }
  if (password !== confirm) {
    return res.status(400).json({ error: "Les deux mots de passe ne correspondent pas." });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = $1 AND confirmed = 1 AND used = 0',
      [token]
    );
    const tokenRow = rows[0];

    if (!tokenRow) {
      return res.status(403).json({ error: "Cette demande n'a pas été confirmée ou a expiré." });
    }

    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - Number(tokenRow.created_at) > THIRTY_MINUTES) {
      return res.status(410).json({ error: "Ce lien a expiré. Merci de refaire une demande de réinitialisation." });
    }

    const result = await pool.query(
      `UPDATE accounts SET password = '${password}' WHERE email = '${tokenRow.email}'`
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Aucun compte ne correspond à cette demande." });
    }

    await pool.query('UPDATE reset_tokens SET used = 1 WHERE token = $1', [token]);

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});

app.get('/session', async (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM accounts WHERE email = '${req.session.email}'`
    );
    const row = rows[0];
    if (!row) {
      return res.status(401).json({ error: "Non connecté." });
    }
    return res.json({ success: true, account: row });
  } catch (err) {
    return res.status(401).json({ error: "Non connecté." });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    return res.json({ success: true });
  });
});

function requireLogin(req, res, next) {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  next();
}

app.post('/candidatures', requireLogin, async (req, res) => {
  const { titre, type } = req.body;
  if (!titre) {
    return res.status(400).json({ error: "Formation manquante." });
  }
  try {
    const existing = await pool.query(
      'SELECT id FROM candidatures WHERE email = $1 AND titre = $2',
      [req.session.email, titre]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Vous avez déjà envoyé une demande pour cette formation." });
    }

    const LIMITES = { formation: 2, emploi: 2 };
    const typeCandidature = type === 'emploi' ? 'emploi' : 'formation';
    const count = await pool.query(
      'SELECT COUNT(*) AS total FROM candidatures WHERE email = $1 AND type = $2',
      [req.session.email, typeCandidature]
    );
    if (Number(count.rows[0].total) >= LIMITES[typeCandidature]) {
      const message = typeCandidature === 'formation'
        ? "Vous ne pouvez candidater qu'à 2 formations maximum."
        : "Vous ne pouvez candidater qu'à 2 postes maximum.";
      return res.status(400).json({ error: message });
    }

    await pool.query(
      'INSERT INTO candidatures (email, titre, type, created_at) VALUES ($1, $2, $3, $4)',
      [req.session.email, titre, typeCandidature, Date.now()]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});

app.get('/candidatures', requireLogin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, titre, type, created_at FROM candidatures WHERE email = $1 ORDER BY created_at DESC',
      [req.session.email]
    );
    const candidatures = rows.map((r) => ({ ...r, created_at: Number(r.created_at) }));
    return res.json({ success: true, candidatures });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Impossible de charger vos candidatures." });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`)))
  .catch((err) => {
    console.error('Erreur au démarrage :', err);
    process.exit(1);
  });
