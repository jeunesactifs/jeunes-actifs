const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit'); 
const app = express();

app.use(express.static(__dirname));
 
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
    pass: 'nvzqlcooyiwmzoo'
  }
});

function sendResetEmail(toEmail, resetLink) {
  return transporter.sendMail({
    from: '"Jeunes Actifs" <support.jeunesactifs@gmail.com>',
    to: toEmail,
    subject: 'Réinitialisation de votre mot de passe',
    html: `
      <p>Vous avez demandé une réinitialisation de votre mot de passe.</p>
      <p><a href="${resetLink}">Cliquez ici pour confirmer</a> (valable 30 minutes).</p>
      <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    `
  });
}

const db = new sqlite3.Database('./zerdi.db');
 
db.serialize(() => {
  db.run(`
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
});

db.run(`
  CREATE TABLE IF NOT EXISTS reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    token TEXT,
    confirmed INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    created_at INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    type TEXT,
    title TEXT,
    created_at INTEGER
  )
`);
 
function encodePassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/signup', (req, res) => {
  const { prenom, nom, email, telephone, password, niveau, nationalite } = req.body;
 
  if (!prenom || !nom || !email || !telephone || !password || !niveau || !nationalite) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 8 caractères." });
  }
 
 
  const checkQuery = `SELECT * FROM accounts WHERE email = '${email}'`;
 
  db.get(checkQuery, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Impossible de créer le compte pour le moment. Réessayez." });
    }
    if (row) {
      return res.status(400).json({ error: "Un compte existe déjà avec cet e-mail." });
    }
 
    const insertQuery = `
      INSERT INTO accounts (prenom, nom, email, telephone, password, niveau, nationalite)
      VALUES ('${prenom}', '${nom}', '${email}', '${telephone}', '${password}', '${niveau}', '${nationalite}')
    `;
 
    db.run(insertQuery, function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Impossible de créer le compte pour le moment. Réessayez." });
      }
      return res.json({ success: true, id: this.lastID });
    });
  });
});
app.post('/login', (req, res) => {
  const { email, password } = req.body;
 
  if (!email || !password) {
    return res.status(400).json({ error: "Merci de remplir tous les champs." });
  }
 
 
  const loginQuery = `
    SELECT * FROM accounts
    WHERE email = '${email}' AND password = '${password}'
  `;
 
  db.get(loginQuery, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Erreur serveur." });
    }
    if (!row) {
      return res.status(401).json({ error: "Identifiants incorrects." });
    }
    req.session.email = row.email;
    return res.json({ success: true, account: row });
  });
});

app.post('/reset-request', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Merci de renseigner votre email.' });
  } 
  const query = `SELECT * FROM accounts WHERE email = '${email}'`;

  db.get(query, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Une erreur est survenue.' });
    }
  
    if (!row) {
      return res.status(404).json({ error: 'Aucun compte trouvé avec cet email.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = Date.now();

    const insertQuery = `
      INSERT INTO reset_tokens (token, email, created_at, used, confirmed)
      VALUES ('${token}', '${email}', ${createdAt}, 0, 0)
    `;
    

    db.run(insertQuery, (insertErr) => {
      if (insertErr) {
        console.error(insertErr);
        return res.status(500).json({ error: 'Une erreur est survenue.' });
      }

      const resetLink = `http://localhost:3000/reset-confirm?token=${token}&answer=yes`;
      
          sendResetEmail(row.email, resetLink)
      .then(() => res.status(200).json({ message: 'Si ce compte existe, un email a été envoyé.' }))
      .catch((mailErr) => {
        console.error(mailErr);
        return res.status(200).json({ message: 'Si ce compte existe, un email a été envoyé.' });
      });
  });
});
});

app.get('/reset-confirm', (req, res) => {
  const { token, answer } = req.query;
  if (!token || !answer) {
    return res.status(400).send('Lien invalide.');
  }

  const query = `SELECT * FROM reset_tokens WHERE token = '${token}' AND used = 0`;

  db.get(query, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Une erreur est survenue.');
    }
    if (!row) {
      return res.status(404).send('Ce lien est invalide ou a déjà été utilisé.');
    }

    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - row.created_at > THIRTY_MINUTES) {
      return res.status(410).send('Ce lien a expiré. Merci de refaire une demande de réinitialisation.');
    }

    if (answer === 'no') {
      const cancelQuery = `UPDATE reset_tokens SET used = 1 WHERE token = '${token}'`;
      db.run(cancelQuery, () => {
        return res.send('Merci. Cette demande a été annulée, votre mot de passe reste inchangé.');
      });
      return;
    }

    if (answer === 'yes') {
      const confirmQuery = `UPDATE reset_tokens SET confirmed = 1 WHERE token = '${token}'`;
      db.run(confirmQuery, (updateErr) => {
        if (updateErr) {
          console.error(updateErr);
          return res.status(500).send('Une erreur est survenue.');
        }
        return res.redirect(`http://localhost:3000/jeunes-actifs.html?resetToken=${token}`);
      });
      return;
    }

    return res.status(400).send('Réponse invalide.');
  });
});

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

  const tokenQuery = `SELECT * FROM reset_tokens WHERE token = '${token}'`;
  db.get(tokenQuery, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Une erreur est survenue." });
    }
    if (!row) {
      return res.status(404).json({ error: "Lien invalide." });
    }
    if (row.used === 1) {
      return res.status(410).json({ error: "Ce lien a déjà été utilisé." });
    }
    if (row.confirmed !== 1) {
      return res.status(403).json({ error: "Cette demande n'a pas été confirmée." });
    }

    const THIRTY_MINUTES = 30 * 60 * 1000;
    if (Date.now() - row.created_at > THIRTY_MINUTES) {
      return res.status(410).json({ error: "Ce lien a expiré." });
    }

    const updateQuery = `UPDATE accounts SET password = '${password}' WHERE email = '${row.email}'`;
    db.run(updateQuery, function (updateErr) {
      if (updateErr) {
        console.error(updateErr);
        return res.status(500).json({ error: "Une erreur est survenue." });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Aucun compte ne correspond à cet email." });
      }

      const markUsedQuery = `UPDATE reset_tokens SET used = 1 WHERE token = '${token}'`;
      db.run(markUsedQuery, () => {
        return res.json({ success: true });
      });
    });
  });
});
 
 
app.get('/session', (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non connecté." });
  }
  const query = `SELECT * FROM accounts WHERE email = '${req.session.email}'`;
  db.get(query, (err, row) => {
    if (err || !row) {
      return res.status(401).json({ error: "Non connecté." });
    }
    return res.json({ success: true, account: row });
  });
});

app.post('/apply', (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Vous devez être connecté." });
  }

  const { type, title } = req.body;
  if (!type || !title) {
    return res.status(400).json({ error: "Données manquantes." });
  }

  const email = req.session.email;

  const countQuery = `SELECT COUNT(*) AS count FROM applications WHERE email = ? AND type = ?`;
  db.get(countQuery, [email, type], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Une erreur est survenue." });
    }

    if (row.count >= 2) {
      const label = type === 'emploi' ? "d'offres d'emploi" : "de formations";
      return res.status(400).json({ error: `Vous avez déjà atteint la limite de 2 demandes ${label}.` });
    }

    const insertQuery = `INSERT INTO applications (email, type, title, created_at) VALUES (?, ?, ?, ?)`;
    db.run(insertQuery, [email, type, title, Date.now()], (insertErr) => {
      if (insertErr) {
        console.error(insertErr);
        return res.status(500).json({ error: "Une erreur est survenue." });
      }
      return res.json({ success: true });
    });
  });
});

app.get('/applications', (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Vous devez être connecté." });
  }

  const query = `SELECT type, title, created_at FROM applications WHERE email = ? ORDER BY created_at DESC`;
  db.all(query, [req.session.email], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Une erreur est survenue." });
    }
    return res.json({ applications: rows });
  });
});
 
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    return res.json({ success: true });
  });
});
 
app.listen(3000, () => console.log('Serveur sur http://localhost:3000'));