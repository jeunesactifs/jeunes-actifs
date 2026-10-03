const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const nodemailer = require('nodemailer');
 
const app = express();
 
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
 
const path = require('path');
app.get('/jeunes-actifs.html', (req, res) => res.sendFile(path.join(__dirname, 'jeunes-actifs.html')));
 
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'jeunes-actifs.html'));
});
 
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'support.jeunesactifs@gmail.com',
    pass: process.env.GMAIL_PASS
  }
});
 
const db = new Database('./database.db');
 
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prenom TEXT,
    nom TEXT,
    email TEXT,
    telephone TEXT,
    password TEXT,
    niveau TEXT,
    nationalite TEXT
  )
`);
 
db.exec(`
  CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    token TEXT,
    confirmed INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    created_at INTEGER
  )
`);
 
function motDePasseValide(p) {
  return typeof p === 'string'
    && p.length >= 8
    && p.length <= 128
    && /[A-Za-z]/.test(p)
    && /[0-9]/.test(p)
    && /[^A-Za-z0-9]/.test(p);
}

function encodePassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}
 
app.post('/signup', (req, res) => {
  const { prenom, nom, email, telephone, password, niveau, nationalite } = req.body;
 
  if (!prenom || !nom || !email || !telephone || !password || !niveau || !nationalite) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (!motDePasseValide(password)) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères, une lettre, un chiffre et un caractère spécial." });
  }
 
  try {
    const existing = db.prepare(`SELECT * FROM accounts WHERE email = '${email}'`).get();
    if (existing) {
      return res.status(400).json({ error: "Un compte existe déjà avec cet e-mail." });
    }
 
    const insertQuery = `
      INSERT INTO accounts (prenom, nom, email, telephone, password, niveau, nationalite)
      VALUES ('${prenom}', '${nom}', '${email}', '${telephone}', '${password}', '${niveau}', '${nationalite}')
    `;
    const result = db.prepare(insertQuery).run();
 
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Impossible de créer le compte pour le moment. Réessayez." });
  }
});
 
app.post('/login', (req, res) => {
  const { email, password } = req.body;
 
  if (!email || !password) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
 
  try {
 
    const loginQuery = `SELECT * FROM accounts WHERE email = '${email}' AND password = '${password}'`;
    const row = db.prepare(loginQuery).get();
 
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
 
app.post('/reset-request', (req, res) => {
  const { email } = req.body;
 
  if (!email) {
    return res.status(400).json({ error: "Merci de renseigner votre e-mail." });
  }
 
  try {
    const row = db.prepare(`SELECT * FROM accounts WHERE email = '${email}'`).get();
 
    if (row) {
      const token = crypto.randomBytes(32).toString('hex');
      const createdAt = Date.now();
 
      db.prepare('INSERT INTO reset_tokens (email, token, confirmed, used, created_at) VALUES (?, ?, 0, 0, ?)')
        .run(email, token, createdAt);
 
      const confirmYesUrl = `https://jeunes-actifs.onrender.com/reset-confirm?token=${token}&answer=yes`;
      const confirmNoUrl = `https://jeunes-actifs.onrender.com/reset-confirm?token=${token}&answer=no`;
 
      const mailOptions = {
        from: 'support.jeunesactifs@gmail.com',
        to: email,
        subject: 'Confirmation de réinitialisation de mot de passe — Jeunes Actifs',
        text: `Bonjour,
 
Une demande de réinitialisation de mot de passe a été effectuée pour ce compte sur Jeunes Actifs.
 
Si vous êtes à l'origine de cette demande, cliquez ici pour confirmer :
${confirmYesUrl}
 
Si vous n'êtes pas à l'origine de cette demande, cliquez ici :
${confirmNoUrl}
 
Ce lien expire dans 30 minutes.
 
L'équipe Jeunes Actifs`
      };
 
      transporter.sendMail(mailOptions, (mailErr) => {
        if (mailErr) console.error('Erreur envoi email:', mailErr);
      });
    }
 
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});
 
app.get('/reset-confirm', (req, res) => {
  const { token, answer } = req.query;
 
  if (!token || !answer) {
    return res.status(400).send('Lien invalide.');
  }
 
  try {
    const row = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND used = 0').get(token);
 
    if (!row) {
      return res.status(404).send('Ce lien est invalide ou a déjà été utilisé.');
    }
 
    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - row.created_at > THIRTY_MINUTES) {
      return res.status(410).send('Ce lien a expiré. Merci de refaire une demande de réinitialisation.');
    }
 
    if (answer === 'no') {
      db.prepare('UPDATE reset_tokens SET used = 1 WHERE token = ?').run(token);
      return res.send('Merci. Cette demande a été annulée, votre mot de passe reste inchangé.');
    }
 
    if (answer === 'yes') {
      db.prepare('UPDATE reset_tokens SET confirmed = 1 WHERE token = ?').run(token);
      return res.redirect(`https://jeunes-actifs.onrender.com/jeunes-actifs.html?resetToken=${token}`);
    }
 
    return res.status(400).send('Réponse invalide.');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Une erreur est survenue.');
  }
});
 
app.post('/reset-submit', (req, res) => {
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
    const tokenRow = db.prepare('SELECT * FROM reset_tokens WHERE token = ? AND confirmed = 1 AND used = 0').get(token);
 
    if (!tokenRow) {
      return res.status(403).json({ error: "Cette demande n'a pas été confirmée ou a expiré." });
    }
 
    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - tokenRow.created_at > THIRTY_MINUTES) {
      return res.status(410).json({ error: "Ce lien a expiré. Merci de refaire une demande de réinitialisation." });
    }
 
    const updateQuery = `UPDATE accounts SET password = '${password}' WHERE email = '${tokenRow.email}'`;
    const result = db.prepare(updateQuery).run();
 
    if (result.changes === 0) {
      return res.status(404).json({ error: "Aucun compte ne correspond à cette demande." });
    }
 
    db.prepare('UPDATE reset_tokens SET used = 1 WHERE token = ?').run(token);
 
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});
 
app.get('/session', (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  try {
    const row = db.prepare(`SELECT * FROM accounts WHERE email = '${req.session.email}'`).get();
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
 
db.exec(`
  CREATE TABLE IF NOT EXISTS candidatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    titre TEXT NOT NULL,
    type TEXT,
    created_at INTEGER NOT NULL
  )
`);

function requireLogin(req, res, next) {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  next();
}

app.post('/candidatures', requireLogin, (req, res) => {
  const { titre, type } = req.body;
  if (!titre) {
    return res.status(400).json({ error: "Formation manquante." });
  }
  try {
    const existing = db.prepare('SELECT id FROM candidatures WHERE email = ? AND titre = ?')
      .get(req.session.email, titre);
    if (existing) {
      return res.status(400).json({ error: "Vous avez déjà envoyé une demande pour cette formation." });
    }
    const LIMITES = { formation: 2, emploi: 2 };
    const typeCandidature = type === 'emploi' ? 'emploi' : 'formation';
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM candidatures WHERE email = ? AND type = ?')
      .get(req.session.email, typeCandidature);
    if (total >= LIMITES[typeCandidature]) {
      const message = typeCandidature === 'formation'
        ? "Vous ne pouvez candidater qu'à 2 formations maximum."
        : "Vous ne pouvez candidater qu'à 2 postes maximum.";
      return res.status(400).json({ error: message });
    }
    db.prepare('INSERT INTO candidatures (email, titre, type, created_at) VALUES (?, ?, ?, ?)')
      .run(req.session.email, titre, typeCandidature, Date.now());
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Une erreur est survenue, merci de réessayer." });
  }
});

app.get('/candidatures', requireLogin, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, titre, type, created_at FROM candidatures WHERE email = ? ORDER BY created_at DESC'
    ).all(req.session.email);
    return res.json({ success: true, candidatures: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Impossible de charger vos candidatures." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
