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
  secret: 'change-moi-en-vrai-secret',
  resave: false,
  saveUninitialized: false
}));
 
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'support.jeunesactifs@gmail.com',
    pass: 'COLLE_TON_CODE_ICI'
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
 
function encodePassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}
 
// ------------------------------------------------------------------
// SIGNUP — vulnérable
// ------------------------------------------------------------------
app.post('/signup', (req, res) => {
  const { prenom, nom, email, telephone, password, niveau, nationalite } = req.body;
 
  if (!prenom || !nom || !email || !telephone || !password || !niveau || !nationalite) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
  }
 
  try {
    // 🚨 VULNÉRABLE
    const existing = db.prepare(`SELECT * FROM accounts WHERE email = '${email}'`).get();
    if (existing) {
      return res.status(400).json({ error: "Un compte existe déjà avec cet e-mail." });
    }
 
    const hashedPassword = encodePassword(password);
 
    // 🚨 VULNÉRABLE
    const insertQuery = `
      INSERT INTO accounts (prenom, nom, email, telephone, password, niveau, nationalite)
      VALUES ('${prenom}', '${nom}', '${email}', '${telephone}', '${hashedPassword}', '${niveau}', '${nationalite}')
    `;
    const result = db.prepare(insertQuery).run();
 
    return res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Impossible de créer le compte pour le moment. Réessayez." });
  }
});
 
// ------------------------------------------------------------------
// LOGIN — vulnérable
// ------------------------------------------------------------------
app.post('/login', (req, res) => {
  const { email, password } = req.body;
 
  if (!email || !password) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
 
  try {
    const hashedPassword = encodePassword(password);
 
    // 🚨 VULNÉRABLE
    const loginQuery = `SELECT * FROM accounts WHERE email = '${email}' AND password = '${hashedPassword}'`;
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
 
// ------------------------------------------------------------------
// RESET REQUEST — vulnérable
// ------------------------------------------------------------------
app.post('/reset-request', (req, res) => {
  const { email } = req.body;
 
  if (!email) {
    return res.status(400).json({ error: "Merci de renseigner votre e-mail." });
  }
 
  try {
    // 🚨 VULNÉRABLE
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
 
// ------------------------------------------------------------------
// RESET CONFIRM
// ------------------------------------------------------------------
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
 
// ------------------------------------------------------------------
// RESET SUBMIT — vulnérable
// ------------------------------------------------------------------
app.post('/reset-submit', (req, res) => {
  const { token, password, confirm } = req.body;
 
  if (!token || !password || !confirm) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères." });
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
 
    const hashedPassword = encodePassword(password);
 
    // 🚨 VULNÉRABLE
    const updateQuery = `UPDATE accounts SET password = '${hashedPassword}' WHERE email = '${tokenRow.email}'`;
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
 
// ------------------------------------------------------------------
// SESSION — vulnérable
// ------------------------------------------------------------------
app.get('/session', (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  try {
    // 🚨 VULNÉRABLE
    const row = db.prepare(`SELECT * FROM accounts WHERE email = '${req.session.email}'`).get();
    if (!row) {
      return res.status(401).json({ error: "Non connecté." });
    }
    return res.json({ success: true, account: row });
  } catch (err) {
    return res.status(401).json({ error: "Non connecté." });
  }
});
 
// ------------------------------------------------------------------
// LOGOUT
// ------------------------------------------------------------------
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    return res.json({ success: true });
  });
});
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
 
