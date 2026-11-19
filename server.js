const express = require('express');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3005;

const SUPER_ADMIN_NAME = "Шостакович Екатерина Анатольевна";
const DEFAULT_TEACHER_PASSWORD = "1940"; // Запасной пароль, если индивидуальный не указан
const SUPER_ADMIN_PASSWORD = "2024";     // Начальный пароль супер-админа

const INITIAL_TEACHERS = [
  "Шостакович Екатерина Анатольевна",
  "Полякова Илона Юльяновна",
  "Олесюк Виктория Александровна",
  "Солоснюк Алина Павловна",
  "Павлюковец Татьяна Васильевна",
  "Крысь Ольга Николаевна",
  "Козак Людмила Васильевна",
  "Миненкова Татьяна Михайловна",
  "Зущик Татьяна Михайловна",
  "Лешкевич Наталья Владимировна",
  "Веренич Георгий Васильевич",
  "Кучинская Анна Григорьевна",
  "Малявко Татьяна Михайловна",
  "Садовская Светлана Михайловна",
  "Климович Ольга Александровна",
  "Потоцкая Софья Константиновна",
  "Ковалевич Анна Николаевна",
  "Видзяйло Лилиана Александровна",
  "Корнейчук Екатерина Викторовна",
  "Балюк Анна Васильевна",
  "Фурса Лариса Адамовна",
  "Кременевская Инна Олеговна",
  "Поживилко Дина Викторовна",
  "Головенко Елена Николаевна",
  "Николаева Жанна Павловна"
];

const videosDir = path.join(__dirname, 'uploads', 'videos');
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(videosDir));

// Подключение к облачной базе Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDatabase() {
  await db.execute(`CREATE TABLE IF NOT EXISTS app_storage (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS teacher_passwords (
    name TEXT PRIMARY KEY,
    password TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    login_time TEXT NOT NULL
  )`);
  // Записываем пароль супер-админа по умолчанию
  await db.execute({
    sql: `INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)`,
    args: [SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD]
  });

  // Записываем начальный список ФИО преподавателей
  const res = await db.execute("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'");
  if (res.rows.length === 0) {
    await db.execute({
      sql: "INSERT INTO app_storage (key, value) VALUES ('PGMK_Teachers', ?)",
      args: [JSON.stringify(INITIAL_TEACHERS)]
    });
    for (const t of INITIAL_TEACHERS) {
      if (t !== SUPER_ADMIN_NAME) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)`,
          args: [t, DEFAULT_TEACHER_PASSWORD]
        });
      }
    }
  }
  console.log('База данных Turso успешно подключена');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videosDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'video-' + Date.now() + '-' + Math.round(Math.random() * 1000) + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 * 1024 } });

// 1. Проверка входа преподавателя по индивидуальному паролю
app.post('/api/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name) return res.status(400).json({ error: 'Выберите ФИО преподавателя' });

    const rowRes = await db.execute("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'");
    let teachers = INITIAL_TEACHERS;
    if (rowRes.rows.length > 0 && rowRes.rows[0].value) {
      try { teachers = JSON.parse(rowRes.rows[0].value); } catch (e) {}
    }

    if (!teachers.includes(name)) {
      return res.status(403).json({ error: 'Преподаватель не найден в базе' });
    }

    const passRes = await db.execute({
      sql: "SELECT password FROM teacher_passwords WHERE name = ?",
      args: [name]
    });

    const expected = passRes.rows.length > 0
      ? passRes.rows[0].password
      : (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD);

    if (password !== expected) {
      return res.status(401).json({ error: 'Неверный пароль!' });
    }
await db.execute({
      sql: "INSERT INTO login_logs (name, login_time) VALUES (?, ?)",
      args: [name, new Date().toISOString()]
    });
    return res.json({ success: true, isSuperAdmin: (name === SUPER_ADMIN_NAME), name: name });
  } catch (err) {
    console.error('Ошибка /api/login:', err);
    res.status(500).json({ error: 'Ошибка сервера при проверке входа' });
  }
});

// Получить журнал входов преподавателей (для супер-админа)
app.get('/api/admin/logs', async (req, res) => {
  try {
    const result = await db.execute("SELECT name, login_time FROM login_logs ORDER BY id DESC LIMIT 200");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Получить список преподавателей С паролями (только для супер-админа)
app.get('/api/admin/teachers', async (req, res) => {
  try {
    const rowRes = await db.execute("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'");
    let teachers = [SUPER_ADMIN_NAME];
    if (rowRes.rows.length > 0 && rowRes.rows[0].value) {
      try { teachers = JSON.parse(rowRes.rows[0].value); } catch (e) {}
    }

    const passRes = await db.execute("SELECT name, password FROM teacher_passwords");
    const passMap = {};
    passRes.rows.forEach(r => { passMap[r.name] = r.password; });

    const list = teachers.map(name => ({
      name: name,
      password: passMap[name] || (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD)
    }));
    res.json(list);
  } catch (err) {
    console.error('Ошибка GET /api/admin/teachers:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Сохранить обновленный список преподавателей и их индивидуальные пароли
app.post('/api/admin/teachers', async (req, res) => {
  try {
    const { list } = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Неверный формат данных' });

    const cleanNames = [];
    const statements = [{ sql: "DELETE FROM teacher_passwords", args: [] }];

    list.forEach(item => {
      const name = String(item.name || '').trim();
      let pass = String(item.password || '').trim();
      if (!name) return;
      if (!pass) pass = (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD);

      if (!cleanNames.includes(name)) {
        cleanNames.push(name);
        statements.push({
          sql: "INSERT INTO teacher_passwords (name, password) VALUES (?, ?)",
          args: [name, pass]
        });
      }
    });

    if (!cleanNames.includes(SUPER_ADMIN_NAME)) {
      cleanNames.unshift(SUPER_ADMIN_NAME);
      statements.push({
        sql: "INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)",
        args: [SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD]
      });
    }

    statements.push({
      sql: `INSERT INTO app_storage (key, value) VALUES ('PGMK_Teachers', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [JSON.stringify(cleanNames)]
    });

    await db.batch(statements, "write");
    res.json({ success: true, names: cleanNames });
  } catch (err) {
    console.error('Ошибка POST /api/admin/teachers:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Общие открытые данные (БЕЗ паролей)
app.get('/api/data', async (req, res) => {
  try {
    const result = await db.execute('SELECT key, value FROM app_storage');
    const data = {};
    result.rows.forEach(row => {
      try { data[row.key] = JSON.parse(row.value); }
      catch (e) { data[row.key] = row.value; }
    });
    res.json(data);
  } catch (err) {
    console.error('Ошибка GET /api/data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    const { key, value } = req.body;
    let finalValue = value;
    if (key === 'PGMK_Teachers' && Array.isArray(finalValue)) {
      finalValue = finalValue.filter(n => n && n.trim() && n.trim() !== SUPER_ADMIN_NAME);
      finalValue.unshift(SUPER_ADMIN_NAME);
    }
    await db.execute({
      sql: `INSERT INTO app_storage (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, JSON.stringify(finalValue)]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка POST /api/data:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-video', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
  res.json({ videoUrl: `/videos/${req.file.filename}` });
});

app.post('/api/delete-video', (req, res) => {
  const { videoUrl } = req.body;
  if (videoUrl && videoUrl.startsWith('/videos/')) {
    const filePath = path.join(videosDir, path.basename(videoUrl));
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
  res.json({ success: true });
});

initDatabase().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер ОСКЭ запущен на порту ${PORT}`);
  });
  server.timeout = 0;
}).catch(err => {
  console.error('Критическая ошибка запуска БД:', err);
});
