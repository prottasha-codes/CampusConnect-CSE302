// Campus Connect - simple Node.js + MySQL project
const path = require('path');
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');

const app = express();
const PORT = 3000;

// MySQL connection. Change password here if your MySQL has a password.
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'campus_connect'
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'campus-connect-secret',
  resave: false,
  saveUninitialized: false
}));

function cleanText(value, max = 500) {
  if (value === undefined || value === null) return null;
  return String(value).trim().slice(0, max);
}


function safeUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? text : null;
  } catch (_) {
    return null;
  }
}

function positiveInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function authRequired(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Please sign in first.' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

function canOwnOrAdmin(user, ownerId) {
  return user.role === 'Admin' || Number(user.user_id) === Number(ownerId);
}

async function userById(userId) {
  const [rows] = await pool.query(`
    SELECT u.user_id, u.university_id, u.name, u.email, u.phone, u.dept_id,
           d.dept_name, d.dept_code, r.role_name AS role
    FROM users u
    JOIN roles r ON r.role_id = u.role_id
    LEFT JOIN departments d ON d.dept_id = u.dept_id
    WHERE u.user_id = ?
  `, [userId]);
  return rows[0] || null;
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    res.status(500).json({ ok: false, database: 'disconnected', error: error.code || error.message });
  }
});

// Authentication
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = cleanText(req.body.email, 120)?.toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const [rows] = await pool.query(`
      SELECT u.user_id, u.university_id, u.name, u.email, u.phone, u.dept_id,
             d.dept_name, d.dept_code, r.role_name AS role
      FROM users u
      JOIN roles r ON r.role_id = u.role_id
      LEFT JOIN departments d ON d.dept_id = u.dept_id
      WHERE u.email = ? AND u.password_hash = SHA2(?, 256)
      LIMIT 1
    `, [email, password]);

    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.user = rows[0];
    res.json({ user: rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', authRequired, async (req, res, next) => {
  try {
    const user = await userById(req.session.user.user_id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.session.user = user;
    res.json({ user });
  } catch (error) { next(error); }
});

// Shared lookup data
app.get('/api/meta', authRequired, async (_req, res, next) => {
  try {
    const [[categories], [courses], [departments], [roles], [skills]] = await Promise.all([
      pool.query('SELECT category_id, category_name FROM categories ORDER BY category_name'),
      pool.query('SELECT course_id, course_code, course_name FROM courses ORDER BY course_code'),
      pool.query('SELECT dept_id, dept_code, dept_name FROM departments ORDER BY dept_code'),
      pool.query('SELECT role_id, role_name FROM roles ORDER BY role_id'),
      pool.query('SELECT skill_id, skill_name FROM skills ORDER BY skill_name')
    ]);
    res.json({ categories, courses, departments, roles, skills });
  } catch (error) { next(error); }
});

// Dashboard
app.get('/api/dashboard', authRequired, async (req, res, next) => {
  try {
    const userId = req.session.user.user_id;
    const [[counts], [upcoming], [mine]] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM products WHERE status='Available') AS marketplace,
          (SELECT COUNT(*) FROM projects WHERE status='Open') AS open_projects,
          (SELECT COUNT(*) FROM resources) AS resources,
          (SELECT COUNT(*) FROM lost_found_reports WHERE status='Open') AS open_reports,
          (SELECT COUNT(*) FROM events WHERE event_date >= NOW()) AS upcoming_events,
          (SELECT COUNT(*) FROM users) AS users
      `),
      pool.query(`
        SELECT e.event_id, e.event_name, e.venue, e.event_date, e.capacity,
               u.name AS creator_name,
               (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id=e.event_id) AS registered
        FROM events e JOIN users u ON u.user_id=e.created_by
        WHERE e.event_date >= NOW()
        ORDER BY e.event_date ASC LIMIT 4
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM products WHERE seller_id=?) AS my_products,
          (SELECT COUNT(*) FROM projects WHERE creator_id=?) AS my_projects,
          (SELECT COUNT(*) FROM resources WHERE uploader_id=?) AS my_resources,
          (SELECT COUNT(*) FROM event_registrations WHERE user_id=?) AS my_event_registrations
      `, [userId, userId, userId, userId])
    ]);
    res.json({ counts: counts[0], upcoming, mine: mine[0] });
  } catch (error) { next(error); }
});

// Marketplace CRUD
app.get('/api/products', authRequired, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const status = cleanText(req.query.status || '', 20);
    const categoryId = positiveInt(req.query.category_id);
    const where = [];
    const params = [];
    if (q) { where.push('(p.product_name LIKE ? OR p.description LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }

    const [rows] = await pool.query(`
      SELECT p.*, c.category_name, u.name AS seller_name, u.university_id,
             (SELECT COUNT(*) FROM wishlists w WHERE w.product_id=p.product_id) AS wishlist_count
      FROM products p
      JOIN categories c ON c.category_id=p.category_id
      JOIN users u ON u.user_id=p.seller_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.created_at DESC
    `, params);
    const user = req.session.user;
    res.json({ products: rows.map(r => ({ ...r, can_edit: canOwnOrAdmin(user, r.seller_id), can_delete: canOwnOrAdmin(user, r.seller_id) })) });
  } catch (error) { next(error); }
});

app.post('/api/products', authRequired, async (req, res, next) => {
  try {
    const productName = cleanText(req.body.product_name, 120);
    const categoryId = positiveInt(req.body.category_id);
    const price = nonNegativeNumber(req.body.price);
    const condition = cleanText(req.body.item_condition, 30);
    const description = cleanText(req.body.description, 500);
    const status = ['Available', 'Sold'].includes(req.body.status) ? req.body.status : 'Available';
    if (!productName || !categoryId || price === null || !condition) return res.status(400).json({ error: 'Name, category, price and condition are required.' });
    const [result] = await pool.query(`INSERT INTO products(seller_id, category_id, product_name, description, price, item_condition, status) VALUES(?,?,?,?,?,?,?)`, [req.session.user.user_id, categoryId, productName, description, price, condition, status]);
    res.status(201).json({ product_id: result.insertId, message: 'Marketplace item created.' });
  } catch (error) { next(error); }
});

app.put('/api/products/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT seller_id FROM products WHERE product_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    if (!canOwnOrAdmin(req.session.user, row.seller_id)) return res.status(403).json({ error: 'You can only edit your own item.' });
    const productName = cleanText(req.body.product_name, 120);
    const categoryId = positiveInt(req.body.category_id);
    const price = nonNegativeNumber(req.body.price);
    const condition = cleanText(req.body.item_condition, 30);
    const description = cleanText(req.body.description, 500);
    const status = ['Available', 'Sold'].includes(req.body.status) ? req.body.status : 'Available';
    if (!productName || !categoryId || price === null || !condition) return res.status(400).json({ error: 'Invalid item data.' });
    await pool.query(`UPDATE products SET category_id=?, product_name=?, description=?, price=?, item_condition=?, status=? WHERE product_id=?`, [categoryId, productName, description, price, condition, status, id]);
    res.json({ message: 'Marketplace item updated.' });
  } catch (error) { next(error); }
});

app.delete('/api/products/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT seller_id FROM products WHERE product_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Item not found.' });
    if (!canOwnOrAdmin(req.session.user, row.seller_id)) return res.status(403).json({ error: 'You can only delete your own item.' });
    await pool.query('DELETE FROM products WHERE product_id=?', [id]);
    res.json({ message: 'Marketplace item deleted.' });
  } catch (error) { next(error); }
});

app.post('/api/products/:id/wishlist', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    await pool.query('INSERT IGNORE INTO wishlists(user_id, product_id) VALUES(?,?)', [req.session.user.user_id, id]);
    res.json({ message: 'Added to wishlist.' });
  } catch (error) { next(error); }
});

// Team Finder / Projects CRUD
app.get('/api/projects', authRequired, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const status = cleanText(req.query.status || '', 20);
    const params = [];
    const where = [];
    if (q) { where.push('(p.title LIKE ? OR p.description LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('p.status=?'); params.push(status); }
    const [rows] = await pool.query(`
      SELECT p.*, u.name AS creator_name, u.university_id,
             GROUP_CONCAT(DISTINCT s.skill_name ORDER BY s.skill_name SEPARATOR ', ') AS skills,
             (SELECT COUNT(*) FROM project_applications pa WHERE pa.project_id=p.project_id) AS application_count,
             EXISTS(SELECT 1 FROM project_applications pa2 WHERE pa2.project_id=p.project_id AND pa2.applicant_id=?) AS applied
      FROM projects p
      JOIN users u ON u.user_id=p.creator_id
      LEFT JOIN project_skills ps ON ps.project_id=p.project_id
      LEFT JOIN skills s ON s.skill_id=ps.skill_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY p.project_id
      ORDER BY p.created_at DESC
    `, [req.session.user.user_id, ...params]);
    const user = req.session.user;
    res.json({ projects: rows.map(r => ({ ...r, can_edit: canOwnOrAdmin(user, r.creator_id), can_delete: canOwnOrAdmin(user, r.creator_id), can_apply: user.role === 'Student' && Number(r.creator_id) !== Number(user.user_id) && r.status === 'Open' && !r.applied })) });
  } catch (error) { next(error); }
});

app.post('/api/projects', authRequired, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const title = cleanText(req.body.title, 150);
    const description = cleanText(req.body.description, 700);
    const status = ['Open', 'Closed'].includes(req.body.status) ? req.body.status : 'Open';
    const skillIds = Array.isArray(req.body.skill_ids) ? req.body.skill_ids.map(positiveInt).filter(Boolean).slice(0, 8) : [];
    if (!title) return res.status(400).json({ error: 'Project title is required.' });
    await conn.beginTransaction();
    const [result] = await conn.query('INSERT INTO projects(creator_id,title,description,status) VALUES(?,?,?,?)', [req.session.user.user_id, title, description, status]);
    for (const skillId of skillIds) await conn.query('INSERT IGNORE INTO project_skills(project_id,skill_id) VALUES(?,?)', [result.insertId, skillId]);
    await conn.commit();
    res.status(201).json({ project_id: result.insertId, message: 'Project created.' });
  } catch (error) {
    await conn.rollback();
    next(error);
  } finally { conn.release(); }
});

app.put('/api/projects/:id', authRequired, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await conn.query('SELECT creator_id FROM projects WHERE project_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Project not found.' });
    if (!canOwnOrAdmin(req.session.user, row.creator_id)) return res.status(403).json({ error: 'You can only edit your own project.' });
    const title = cleanText(req.body.title, 150);
    const description = cleanText(req.body.description, 700);
    const status = ['Open', 'Closed'].includes(req.body.status) ? req.body.status : 'Open';
    const skillIds = Array.isArray(req.body.skill_ids) ? req.body.skill_ids.map(positiveInt).filter(Boolean).slice(0, 8) : [];
    if (!title) return res.status(400).json({ error: 'Project title is required.' });
    await conn.beginTransaction();
    await conn.query('UPDATE projects SET title=?,description=?,status=? WHERE project_id=?', [title, description, status, id]);
    await conn.query('DELETE FROM project_skills WHERE project_id=?', [id]);
    for (const skillId of skillIds) await conn.query('INSERT IGNORE INTO project_skills(project_id,skill_id) VALUES(?,?)', [id, skillId]);
    await conn.commit();
    res.json({ message: 'Project updated.' });
  } catch (error) { await conn.rollback(); next(error); }
  finally { conn.release(); }
});

app.delete('/api/projects/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT creator_id FROM projects WHERE project_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Project not found.' });
    if (!canOwnOrAdmin(req.session.user, row.creator_id)) return res.status(403).json({ error: 'You can only delete your own project.' });
    await pool.query('DELETE FROM projects WHERE project_id=?', [id]);
    res.json({ message: 'Project deleted.' });
  } catch (error) { next(error); }
});

app.post('/api/projects/:id/apply', allowRoles('Student'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const message = cleanText(req.body.application_message, 500);
    const [[project]] = await pool.query('SELECT creator_id,status FROM projects WHERE project_id=?', [id]);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (project.status !== 'Open') return res.status(400).json({ error: 'This project is closed.' });
    if (Number(project.creator_id) === Number(req.session.user.user_id)) return res.status(400).json({ error: 'You cannot apply to your own project.' });
    await pool.query('INSERT INTO project_applications(project_id,applicant_id,application_message) VALUES(?,?,?)', [id, req.session.user.user_id, message]);
    res.status(201).json({ message: 'Application submitted.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already applied to this project.' });
    next(error);
  }
});

app.get('/api/projects/:id/applications', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[project]] = await pool.query('SELECT creator_id FROM projects WHERE project_id=?', [id]);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!canOwnOrAdmin(req.session.user, project.creator_id) && req.session.user.role !== 'Teacher') return res.status(403).json({ error: 'Permission denied.' });
    const [rows] = await pool.query(`SELECT pa.*, u.name AS applicant_name, u.university_id FROM project_applications pa JOIN users u ON u.user_id=pa.applicant_id WHERE pa.project_id=? ORDER BY pa.applied_at DESC`, [id]);
    res.json({ applications: rows });
  } catch (error) { next(error); }
});

app.patch('/api/applications/:id', authRequired, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = positiveInt(req.params.id);
    const status = ['Accepted', 'Rejected'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Status must be Accepted or Rejected.' });
    const [[application]] = await conn.query(`SELECT pa.*, p.creator_id FROM project_applications pa JOIN projects p ON p.project_id=pa.project_id WHERE pa.application_id=?`, [id]);
    if (!application) return res.status(404).json({ error: 'Application not found.' });
    if (!canOwnOrAdmin(req.session.user, application.creator_id) && req.session.user.role !== 'Teacher') return res.status(403).json({ error: 'Permission denied.' });
    await conn.beginTransaction();
    await conn.query('UPDATE project_applications SET status=? WHERE application_id=?', [status, id]);
    if (status === 'Accepted') await conn.query('INSERT IGNORE INTO team_members(project_id,user_id) VALUES(?,?)', [application.project_id, application.applicant_id]);
    await conn.commit();
    res.json({ message: `Application ${status.toLowerCase()}.` });
  } catch (error) { await conn.rollback(); next(error); }
  finally { conn.release(); }
});

// Resources CRUD
app.get('/api/resources', authRequired, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const courseId = positiveInt(req.query.course_id);
    const where = [], params = [];
    if (q) { where.push('(r.title LIKE ? OR r.resource_type LIKE ? OR c.course_code LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
    if (courseId) { where.push('r.course_id=?'); params.push(courseId); }
    const [rows] = await pool.query(`
      SELECT r.*, c.course_code, c.course_name, u.name AS uploader_name, u.university_id
      FROM resources r JOIN courses c ON c.course_id=r.course_id JOIN users u ON u.user_id=r.uploader_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY r.upload_date DESC
    `, params);
    const user = req.session.user;
    res.json({ resources: rows.map(r => ({ ...r, can_edit: canOwnOrAdmin(user, r.uploader_id), can_delete: canOwnOrAdmin(user, r.uploader_id) })) });
  } catch (error) { next(error); }
});

app.post('/api/resources', authRequired, async (req, res, next) => {
  try {
    const courseId = positiveInt(req.body.course_id);
    const title = cleanText(req.body.title, 150);
    const resourceType = cleanText(req.body.resource_type, 40);
    const fileUrl = safeUrl(req.body.file_url);
    if (!courseId || !title || !resourceType) return res.status(400).json({ error: 'Course, title and resource type are required.' });
    const [result] = await pool.query('INSERT INTO resources(uploader_id,course_id,title,resource_type,file_url) VALUES(?,?,?,?,?)', [req.session.user.user_id, courseId, title, resourceType, fileUrl]);
    res.status(201).json({ resource_id: result.insertId, message: 'Resource shared.' });
  } catch (error) { next(error); }
});

app.put('/api/resources/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT uploader_id FROM resources WHERE resource_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Resource not found.' });
    if (!canOwnOrAdmin(req.session.user, row.uploader_id)) return res.status(403).json({ error: 'You can only edit your own resource.' });
    const courseId = positiveInt(req.body.course_id);
    const title = cleanText(req.body.title, 150);
    const resourceType = cleanText(req.body.resource_type, 40);
    const fileUrl = safeUrl(req.body.file_url);
    if (!courseId || !title || !resourceType) return res.status(400).json({ error: 'Invalid resource data.' });
    await pool.query('UPDATE resources SET course_id=?,title=?,resource_type=?,file_url=? WHERE resource_id=?', [courseId, title, resourceType, fileUrl, id]);
    res.json({ message: 'Resource updated.' });
  } catch (error) { next(error); }
});

app.delete('/api/resources/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT uploader_id FROM resources WHERE resource_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Resource not found.' });
    if (!canOwnOrAdmin(req.session.user, row.uploader_id)) return res.status(403).json({ error: 'You can only delete your own resource.' });
    await pool.query('DELETE FROM resources WHERE resource_id=?', [id]);
    res.json({ message: 'Resource deleted.' });
  } catch (error) { next(error); }
});

app.post('/api/resources/:id/download', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    await pool.query('UPDATE resources SET download_count=download_count+1 WHERE resource_id=?', [id]);
    const [[row]] = await pool.query('SELECT file_url, download_count FROM resources WHERE resource_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Resource not found.' });
    res.json(row);
  } catch (error) { next(error); }
});

// Lost & Found CRUD
app.get('/api/lost-found', authRequired, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const type = cleanText(req.query.type || '', 20);
    const status = cleanText(req.query.status || '', 20);
    const where = [], params = [];
    if (q) { where.push('(lf.item_name LIKE ? OR lf.description LIKE ? OR lf.location LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
    if (['Lost','Found'].includes(type)) { where.push('lf.report_type=?'); params.push(type); }
    if (['Open','Resolved'].includes(status)) { where.push('lf.status=?'); params.push(status); }
    const [rows] = await pool.query(`SELECT lf.*, u.name AS reporter_name, u.university_id FROM lost_found_reports lf JOIN users u ON u.user_id=lf.user_id ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY lf.report_date DESC, lf.report_id DESC`, params);
    const user = req.session.user;
    res.json({ reports: rows.map(r => ({ ...r, can_edit: canOwnOrAdmin(user, r.user_id), can_delete: canOwnOrAdmin(user, r.user_id) })) });
  } catch (error) { next(error); }
});

app.post('/api/lost-found', authRequired, async (req, res, next) => {
  try {
    const itemName = cleanText(req.body.item_name, 120);
    const description = cleanText(req.body.description, 500);
    const reportType = ['Lost','Found'].includes(req.body.report_type) ? req.body.report_type : null;
    const location = cleanText(req.body.location, 150);
    const reportDate = cleanText(req.body.report_date, 10);
    if (!itemName || !reportType || !reportDate) return res.status(400).json({ error: 'Item, type and date are required.' });
    const [result] = await pool.query('INSERT INTO lost_found_reports(user_id,item_name,description,report_type,location,report_date,status) VALUES(?,?,?,?,?,?,?)', [req.session.user.user_id,itemName,description,reportType,location,reportDate,'Open']);
    res.status(201).json({ report_id: result.insertId, message: 'Report created.' });
  } catch (error) { next(error); }
});

app.put('/api/lost-found/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT user_id FROM lost_found_reports WHERE report_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Report not found.' });
    if (!canOwnOrAdmin(req.session.user, row.user_id)) return res.status(403).json({ error: 'You can only edit your own report.' });
    const itemName = cleanText(req.body.item_name, 120);
    const description = cleanText(req.body.description, 500);
    const reportType = ['Lost','Found'].includes(req.body.report_type) ? req.body.report_type : null;
    const location = cleanText(req.body.location, 150);
    const reportDate = cleanText(req.body.report_date, 10);
    const status = ['Open','Resolved'].includes(req.body.status) ? req.body.status : 'Open';
    if (!itemName || !reportType || !reportDate) return res.status(400).json({ error: 'Invalid report data.' });
    await pool.query('UPDATE lost_found_reports SET item_name=?,description=?,report_type=?,location=?,report_date=?,status=? WHERE report_id=?', [itemName,description,reportType,location,reportDate,status,id]);
    res.json({ message: 'Report updated.' });
  } catch (error) { next(error); }
});

app.delete('/api/lost-found/:id', authRequired, async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT user_id FROM lost_found_reports WHERE report_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Report not found.' });
    if (!canOwnOrAdmin(req.session.user, row.user_id)) return res.status(403).json({ error: 'You can only delete your own report.' });
    await pool.query('DELETE FROM lost_found_reports WHERE report_id=?', [id]);
    res.json({ message: 'Report deleted.' });
  } catch (error) { next(error); }
});

// Events CRUD + registration
app.get('/api/events', authRequired, async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const where = [], params = [];
    if (q) { where.push('(e.event_name LIKE ? OR e.description LIKE ? OR e.venue LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
    const [rows] = await pool.query(`
      SELECT e.*, u.name AS creator_name,
             COUNT(er.user_id) AS registered,
             MAX(CASE WHEN er.user_id=? THEN 1 ELSE 0 END) AS is_registered
      FROM events e JOIN users u ON u.user_id=e.created_by
      LEFT JOIN event_registrations er ON er.event_id=e.event_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      GROUP BY e.event_id
      ORDER BY e.event_date ASC
    `, [req.session.user.user_id, ...params]);
    const user = req.session.user;
    res.json({ events: rows.map(r => ({ ...r, can_edit: user.role === 'Admin' || (user.role === 'Teacher' && Number(r.created_by) === Number(user.user_id)), can_delete: user.role === 'Admin' || (user.role === 'Teacher' && Number(r.created_by) === Number(user.user_id)), can_register: user.role !== 'Admin' && !r.is_registered })) });
  } catch (error) { next(error); }
});

app.post('/api/events', allowRoles('Teacher','Admin'), async (req, res, next) => {
  try {
    const name = cleanText(req.body.event_name, 150);
    const description = cleanText(req.body.description, 700);
    const venue = cleanText(req.body.venue, 150);
    const eventDate = cleanText(req.body.event_date, 25)?.replace('T', ' ');
    const deadline = cleanText(req.body.registration_deadline, 25)?.replace('T', ' ');
    const capacity = positiveInt(req.body.capacity, 50);
    if (!name || !eventDate || !capacity) return res.status(400).json({ error: 'Event name, date and capacity are required.' });
    const [result] = await pool.query('INSERT INTO events(created_by,event_name,description,venue,event_date,registration_deadline,capacity) VALUES(?,?,?,?,?,?,?)', [req.session.user.user_id,name,description,venue,eventDate,deadline || null,capacity]);
    res.status(201).json({ event_id: result.insertId, message: 'Event created.' });
  } catch (error) { next(error); }
});

app.put('/api/events/:id', allowRoles('Teacher','Admin'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT created_by FROM events WHERE event_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Event not found.' });
    if (req.session.user.role !== 'Admin' && Number(row.created_by) !== Number(req.session.user.user_id)) return res.status(403).json({ error: 'Teachers can edit only events they created.' });
    const name = cleanText(req.body.event_name, 150);
    const description = cleanText(req.body.description, 700);
    const venue = cleanText(req.body.venue, 150);
    const eventDate = cleanText(req.body.event_date, 25)?.replace('T', ' ');
    const deadline = cleanText(req.body.registration_deadline, 25)?.replace('T', ' ');
    const capacity = positiveInt(req.body.capacity, 50);
    if (!name || !eventDate || !capacity) return res.status(400).json({ error: 'Invalid event data.' });
    await pool.query('UPDATE events SET event_name=?,description=?,venue=?,event_date=?,registration_deadline=?,capacity=? WHERE event_id=?', [name,description,venue,eventDate,deadline || null,capacity,id]);
    res.json({ message: 'Event updated.' });
  } catch (error) { next(error); }
});

app.delete('/api/events/:id', allowRoles('Teacher','Admin'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const [[row]] = await pool.query('SELECT created_by FROM events WHERE event_id=?', [id]);
    if (!row) return res.status(404).json({ error: 'Event not found.' });
    if (req.session.user.role !== 'Admin' && Number(row.created_by) !== Number(req.session.user.user_id)) return res.status(403).json({ error: 'Teachers can delete only events they created.' });
    await pool.query('DELETE FROM events WHERE event_id=?', [id]);
    res.json({ message: 'Event deleted.' });
  } catch (error) { next(error); }
});

app.post('/api/events/:id/register', allowRoles('Student','Teacher'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const id = positiveInt(req.params.id);
    await conn.beginTransaction();
    const [[event]] = await conn.query(`
      SELECT event_id, event_date, registration_deadline, capacity,
             (event_date <= NOW()) AS started,
             (registration_deadline IS NOT NULL AND registration_deadline < NOW()) AS deadline_passed
      FROM events WHERE event_id=? FOR UPDATE
    `, [id]);
    if (!event) { await conn.rollback(); return res.status(404).json({ error: 'Event not found.' }); }
    if (Number(event.started)) { await conn.rollback(); return res.status(400).json({ error: 'This event has already started.' }); }
    if (Number(event.deadline_passed)) { await conn.rollback(); return res.status(400).json({ error: 'Registration deadline has passed.' }); }
    const [[count]] = await conn.query('SELECT COUNT(*) AS total FROM event_registrations WHERE event_id=?', [id]);
    if (Number(count.total) >= Number(event.capacity)) { await conn.rollback(); return res.status(409).json({ error: 'Event is full.' }); }
    await conn.query('INSERT INTO event_registrations(event_id,user_id) VALUES(?,?)', [id, req.session.user.user_id]);
    await conn.commit();
    res.status(201).json({ message: 'Registration confirmed.' });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You are already registered.' });
    next(error);
  } finally { conn.release(); }
});

app.delete('/api/events/:id/register', allowRoles('Student','Teacher'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    await pool.query('DELETE FROM event_registrations WHERE event_id=? AND user_id=?', [id, req.session.user.user_id]);
    res.json({ message: 'Registration cancelled.' });
  } catch (error) { next(error); }
});

// Admin user management CRUD
app.get('/api/users', allowRoles('Admin'), async (req, res, next) => {
  try {
    const q = cleanText(req.query.q || '', 120);
    const params = [];
    const where = q ? 'WHERE u.name LIKE ? OR u.email LIKE ? OR u.university_id LIKE ? OR d.dept_code LIKE ?' : '';
    if (q) params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);
    const [rows] = await pool.query(`SELECT u.user_id,u.university_id,u.name,u.email,u.phone,u.dept_id,u.role_id,u.created_at,d.dept_code,d.dept_name,r.role_name AS role FROM users u JOIN roles r ON r.role_id=u.role_id LEFT JOIN departments d ON d.dept_id=u.dept_id ${where} ORDER BY u.created_at DESC`, params);
    res.json({ users: rows });
  } catch (error) { next(error); }
});

app.post('/api/users', allowRoles('Admin'), async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 100);
    const email = cleanText(req.body.email, 120)?.toLowerCase();
    const password = String(req.body.password || '');
    const universityId = cleanText(req.body.university_id, 30);
    const phone = cleanText(req.body.phone, 30);
    const deptId = positiveInt(req.body.dept_id);
    const roleId = positiveInt(req.body.role_id);
    if (!name || !email || password.length < 6 || !roleId) return res.status(400).json({ error: 'Name, email, role and a 6+ character password are required.' });
    const [result] = await pool.query('INSERT INTO users(university_id,name,email,password_hash,phone,dept_id,role_id) VALUES(?,?,?,SHA2(?,256),?,?,?)', [universityId || null,name,email,password,phone || null,deptId || null,roleId]);
    res.status(201).json({ user_id: result.insertId, message: 'User created.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email or university ID already exists.' });
    next(error);
  }
});

app.put('/api/users/:id', allowRoles('Admin'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    const name = cleanText(req.body.name, 100);
    const email = cleanText(req.body.email, 120)?.toLowerCase();
    const universityId = cleanText(req.body.university_id, 30);
    const phone = cleanText(req.body.phone, 30);
    const deptId = positiveInt(req.body.dept_id);
    const roleId = positiveInt(req.body.role_id);
    const password = String(req.body.password || '');
    if (!name || !email || !roleId) return res.status(400).json({ error: 'Name, email and role are required.' });
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      await pool.query('UPDATE users SET university_id=?,name=?,email=?,password_hash=SHA2(?,256),phone=?,dept_id=?,role_id=? WHERE user_id=?', [universityId || null,name,email,password,phone || null,deptId || null,roleId,id]);
    } else {
      await pool.query('UPDATE users SET university_id=?,name=?,email=?,phone=?,dept_id=?,role_id=? WHERE user_id=?', [universityId || null,name,email,phone || null,deptId || null,roleId,id]);
    }
    res.json({ message: 'User updated.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email or university ID already exists.' });
    next(error);
  }
});

app.delete('/api/users/:id', allowRoles('Admin'), async (req, res, next) => {
  try {
    const id = positiveInt(req.params.id);
    if (Number(id) === Number(req.session.user.user_id)) return res.status(400).json({ error: 'You cannot delete your own logged-in admin account.' });
    const [result] = await pool.query('DELETE FROM users WHERE user_id=?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: 'User deleted.' });
  } catch (error) { next(error); }
});

// Profile
app.put('/api/profile', authRequired, async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 100);
    const phone = cleanText(req.body.phone, 30);
    const password = String(req.body.password || '');
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      await pool.query('UPDATE users SET name=?,phone=?,password_hash=SHA2(?,256) WHERE user_id=?', [name,phone || null,password,req.session.user.user_id]);
    } else {
      await pool.query('UPDATE users SET name=?,phone=? WHERE user_id=?', [name,phone || null,req.session.user.user_id]);
    }
    const user = await userById(req.session.user.user_id);
    req.session.user = user;
    res.json({ message: 'Profile updated.', user });
  } catch (error) { next(error); }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'A selected related record does not exist.' });
  if (error.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ error: 'This record is still being used by another record.' });
  res.status(500).json({ error: 'Something went wrong on the server.', detail: process.env.NODE_ENV === 'development' ? error.message : undefined });
});

app.listen(PORT, () => {
  console.log(`Campus Connect running on http://localhost:${PORT}`);
});
