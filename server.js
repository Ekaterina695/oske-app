const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3005;

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

const dbDir = path.join(__dirname, 'database');
const videosDir = path.join(__dirname, 'uploads', 'videos');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(videosDir));

const dbPath = path.join(dbDir, 'osce.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Общее хранилище (список ФИО, чек-листы, результаты)
  db.run(`CREATE TABLE IF NOT EXISTS app_storage (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Закрытая таблица паролей (никогда не отдается в /api/data)
  db.run(`CREATE TABLE IF NOT EXISTS teacher_passwords (
    name TEXT PRIMARY KEY,
    password TEXT NOT NULL
  )`);

  // Записываем пароль супер-админа по умолчанию
  db.run(`INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)`, [SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD]);

  // Записываем начальный список ФИО преподавателей
  db.get("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO app_storage (key, value) VALUES ('PGMK_Teachers', ?)", [JSON.stringify(INITIAL_TEACHERS)]);
      INITIAL_TEACHERS.forEach(t => {
        if (t !== SUPER_ADMIN_NAME) {
          db.run(`INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)`, [t, DEFAULT_TEACHER_PASSWORD]);
        }
      });
    }
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videosDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, 'video-' + Date.now() + '-' + Math.round(Math.random() * 1000) + ext);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 1024 * 1024 * 1024 } });

// 1. Проверка входа преподавателя по индивидуальному паролю
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Выберите ФИО преподавателя' });

  db.get("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'", (err, row) => {
    let teachers = INITIAL_TEACHERS;
    if (row) {
      try { teachers = JSON.parse(row.value); } catch (e) {}
    }

    if (!teachers.includes(name)) {
      return res.status(403).json({ error: 'Преподаватель не найден в базе' });
    }

    db.get("SELECT password FROM teacher_passwords WHERE name = ?", [name], (err2, passRow) => {
      const expected = passRow
        ? passRow.password
        : (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD);

      if (password !== expected) {
        return res.status(401).json({ error: 'Неверный пароль!' });
      }
      return res.json({ success: true, isSuperAdmin: (name === SUPER_ADMIN_NAME), name: name });
    });
  });
});

// 2. Получить список преподавателей С паролями (только для супер-админа)
app.get('/api/admin/teachers', (req, res) => {
  db.get("SELECT value FROM app_storage WHERE key = 'PGMK_Teachers'", (err, row) => {
    let teachers = [SUPER_ADMIN_NAME];
    if (row) {
      try { teachers = JSON.parse(row.value); } catch (e) {}
    }
    db.all("SELECT name, password FROM teacher_passwords", [], (err2, passRows) => {
      const passMap = {};
      (passRows || []).forEach(r => { passMap[r.name] = r.password; });
      const list = teachers.map(name => ({
        name: name,
        password: passMap[name] || (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD)
      }));
      res.json(list);
    });
  });
});

// 3. Сохранить обновленный список преподавателей и их индивидуальные пароли
app.post('/api/admin/teachers', (req, res) => {
  const { list } = req.body; // Ожидаем массив [{ name, password }, ...]
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Неверный формат данных' });

  const cleanNames = [];
  db.serialize(() => {
    db.run("DELETE FROM teacher_passwords");

    list.forEach(item => {
      const name = String(item.name || '').trim();
      let pass = String(item.password || '').trim();
      if (!name) return;
      if (!pass) pass = (name === SUPER_ADMIN_NAME ? SUPER_ADMIN_PASSWORD : DEFAULT_TEACHER_PASSWORD);

      if (!cleanNames.includes(name)) {
        cleanNames.push(name);
        db.run("INSERT INTO teacher_passwords (name, password) VALUES (?, ?)", [name, pass]);
      }
    });

    // Гарантируем, что супер-админ не удален
    if (!cleanNames.includes(SUPER_ADMIN_NAME)) {
      cleanNames.unshift(SUPER_ADMIN_NAME);
      db.run("INSERT OR IGNORE INTO teacher_passwords (name, password) VALUES (?, ?)", [SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD]);
    }

    db.run(
      `INSERT INTO app_storage (key, value) VALUES ('PGMK_Teachers', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(cleanNames)],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, names: cleanNames });
      }
    );
  });
});

// 4. Общие открытые данные (БЕЗ паролей)
app.get('/api/data', (req, res) => {
  db.all('SELECT key, value FROM app_storage', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const data = {};
    rows.forEach(row => {
      try { data[row.key] = JSON.parse(row.value); }
      catch (e) { data[row.key] = row.value; }
    });
    res.json(data);
  });
});

app.post('/api/data', (req, res) => {
  const { key, value } = req.body;
  let finalValue = value;
  if (key === 'PGMK_Teachers' && Array.isArray(finalValue)) {
    finalValue = finalValue.filter(n => n && n.trim() && n.trim() !== SUPER_ADMIN_NAME);
    finalValue.unshift(SUPER_ADMIN_NAME);
  }
  db.run(
    `INSERT INTO app_storage (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(finalValue)],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер ОСКЭ запущен на порту ${PORT}`);
});
server.timeout = 0;